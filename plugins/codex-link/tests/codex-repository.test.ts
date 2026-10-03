import { describe, expect, test } from "bun:test";
import type { CodexStore } from "../src/codex-repository";
import {
  CodexRepository,
  TaskCreationError,
  type CodexCall,
} from "../src/codex-repository";

const THREAD_ID = "019ff15d-20e1-7123-a4b1-1807dcc44196";

class MemoryStore implements CodexStore {
  values = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }
  async set(key: string, value: unknown): Promise<void> {
    this.values.set(key, structuredClone(value));
  }
  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }
  async keys(): Promise<string[]> {
    return [...this.values.keys()];
  }
}

describe("Codex Link 0.5 Repository", () => {
  test("新任务默认值单独存一个键，读进来先裁一遍再用", async () => {
    const store = new MemoryStore();
    const call: CodexCall = async <T>(): Promise<T> => ({}) as T;
    const repository = new CodexRepository(call, store);

    expect(await repository.loadComposeDefaults()).toEqual({});

    await repository.saveComposeDefaults({ cwd: "  /work/a  ", model: "gpt-5.6", effort: "" });
    expect(store.values.get("compose-defaults")).toEqual({ cwd: "/work/a", model: "gpt-5.6" });
    // 与会话状态互不干扰：默认值不该挤进 state 那个键。
    expect(store.values.has("state")).toBeFalse();

    // 存盘内容不可信：类型不对、超长的一律丢掉，不能带进表单。
    store.values.set("compose-defaults", { cwd: 42, model: "x".repeat(5_000), effort: "high" });
    const reloaded = new CodexRepository(call, store);
    expect(await reloaded.loadComposeDefaults()).toEqual({ effort: "high" });
  });

  test("模型目录按 feature 惰性加载、规范化并缓存", async () => {
    const store = new MemoryStore();
    const calls: string[] = [];
    const call: CodexCall = async <T>(method: string): Promise<T> => {
      calls.push(method);
      if (method === "codex.status") return {
        connected: true,
        threadCount: 0,
        features: { thread_state_v1: true, task_options_v1: true },
        threads: [],
      } as T;
      if (method === "codex.list_threads" || method === "codex.list_skills") return { data: [] } as T;
      if (method === "codex.list_models") return { data: [{
        id: "gpt-5.6-sol",
        displayName: "GPT-5.6",
        isDefault: true,
        defaultReasoningEffort: "medium",
        supportedReasoningEfforts: [
          { reasoningEffort: "low", description: "快" },
          { reasoningEffort: "medium", description: "均衡" },
        ],
      }] } as T;
      throw new Error(`unexpected ${method}`);
    };
    const repository = new CodexRepository(call, store);
    await repository.refresh();
    expect(calls).not.toContain("codex.list_models");
    expect((await repository.listTaskModels())[0]).toMatchObject({
      id: "gpt-5.6-sol",
      defaultEffort: "medium",
      efforts: [{ id: "low", description: "快" }, { id: "medium", description: "均衡" }],
    });
    await repository.listTaskModels();
    expect(calls.filter((method) => method === "codex.list_models")).toHaveLength(1);
  });

  test("首 turn 失败保留 thread 和稳定消息 id，重试不再创建 thread", async () => {
    const store = new MemoryStore();
    const calls: Array<{ method: string; params: any }> = [];
    let failTurn = true;
    const call: CodexCall = async <T>(method: string, params?: unknown): Promise<T> => {
      calls.push({ method, params });
      if (method === "codex.status") return {
        connected: true,
        threadCount: 0,
        features: { thread_state_v1: true, task_options_v1: true },
        threads: [],
      } as T;
      if (method === "codex.list_threads" || method === "codex.list_skills") return { data: [] } as T;
      if (method === "codex.start_thread") return { thread: { id: THREAD_ID } } as T;
      if (method === "codex.start_turn" && failTurn) {
        failTurn = false;
        throw { code: "CODEX_LINK_PROTOCOL_ERROR", userMessage: "turn failed" };
      }
      if (method === "codex.start_turn") return { turn: { id: "turn-1" } } as T;
      throw new Error(`unexpected ${method}`);
    };
    const repository = new CodexRepository(call, store, { now: () => 123_000 });
    await repository.refresh();
    let partial: TaskCreationError | undefined;
    try {
      await repository.startTask({ cwd: "/tmp/project", text: "补测试", model: "gpt-5.6-sol", effort: "high" });
    } catch (cause) {
      partial = cause as TaskCreationError;
    }
    expect(partial).toBeInstanceOf(TaskCreationError);
    expect(partial?.outcome).toBe("turn-failed");
    expect(partial?.threadId).toBe(THREAD_ID);
    await repository.startTask({
      cwd: "/tmp/project",
      text: "补测试",
      model: "gpt-5.6-sol",
      effort: "high",
      threadId: partial!.threadId,
      clientUserMessageId: partial!.clientUserMessageId,
    });
    expect(calls.filter((item) => item.method === "codex.start_thread")).toHaveLength(1);
    const turns = calls.filter((item) => item.method === "codex.start_turn");
    expect(turns).toHaveLength(2);
    expect(turns[0]!.params.clientUserMessageId).toBe(turns[1]!.params.clientUserMessageId);
    expect(turns[0]!.params).toMatchObject({ model: "gpt-5.6-sol", effort: "high" });
  });

  test("首 turn 超时标记结果不确定，调用方不得盲重发", async () => {
    const repository = new CodexRepository(async <T>(method: string): Promise<T> => {
      if (method === "codex.start_thread") return { thread: { id: THREAD_ID } } as T;
      throw { code: "CODEX_LINK_TIMEOUT", userMessage: "请求超时" };
    }, new MemoryStore());
    await expect(repository.startTask({ cwd: "/tmp/project", text: "补测试" }))
      .rejects.toMatchObject({ outcome: "unknown", threadId: THREAD_ID });
  });

  test("thread/start 超时也标记结果不确定，避免重复创建对话", async () => {
    let startThreadCalls = 0;
    const repository = new CodexRepository(async <T>(method: string): Promise<T> => {
      if (method === "codex.start_thread") {
        startThreadCalls += 1;
        throw { code: "CODEX_LINK_TIMEOUT", userMessage: "请求超时" };
      }
      throw new Error(`unexpected ${method}`);
    }, new MemoryStore());
    await expect(repository.startTask({ cwd: "/tmp/project", text: "补测试" }))
      .rejects.toMatchObject({ outcome: "unknown", threadId: undefined });
    expect(startThreadCalls).toBe(1);
  });

  test("新任务严格 thread/start→持久 managed→turn/start，首 turn 失败不隐藏孤儿", async () => {
    const store = new MemoryStore();
    const calls: Array<{ method: string; params: unknown }> = [];
    const call: CodexCall = async <T>(method: string, params?: unknown): Promise<T> => {
      calls.push({ method, params });
      if (method === "codex.start_thread") return { thread: { id: THREAD_ID } } as T;
      if (method === "codex.start_turn") throw new Error("turn failed");
      throw new Error(`unexpected ${method}`);
    };
    const repository = new CodexRepository(call, store, { now: () => 123_000 });
    await repository.loadLocalState();

    await expect(repository.startTask("/tmp/project", "把测试补齐")).rejects.toThrow("turn failed");
    expect(calls.map((item) => item.method)).toEqual([
      "codex.start_thread",
      "codex.start_turn",
    ]);
    expect(repository.localState.managed[THREAD_ID]).toEqual({
      createdAtMs: 123_000,
      cwd: "/tmp/project",
    });
    expect((await store.get<{ managed: Record<string, unknown> }>("state"))?.managed[THREAD_ID])
      .toBeDefined();
  });

  test("Host 完成交接并打开 Desktop 后才移除 managed 且标为已看，失败不误标", async () => {
    const store = new MemoryStore();
    let shouldFail = true;
    const call: CodexCall = async <T>(method: string): Promise<T> => {
      if (method !== "codex.open_thread") throw new Error(`unexpected ${method}`);
      if (shouldFail) throw new Error("open failed");
      return { ok: true } as T;
    };
    const repository = new CodexRepository(call, store, { now: () => 456_000 });
    await repository.loadLocalState();
    repository.localState.managed[THREAD_ID] = { createdAtMs: 1, cwd: "/tmp/project" };

    await expect(repository.openThread(THREAD_ID)).rejects.toThrow("open failed");
    expect(repository.localState.seenAtMs[THREAD_ID]).toBeUndefined();
    expect(repository.localState.managed[THREAD_ID]).toBeDefined();
    shouldFail = false;
    await repository.openThread(THREAD_ID);
    expect(repository.localState.seenAtMs[THREAD_ID]).toBe(456_000);
    expect(repository.localState.managed[THREAD_ID]).toBeUndefined();
    await repository.markUnseen(THREAD_ID);
    expect(repository.localState.seenAtMs[THREAD_ID]).toBeUndefined();
  });

  test("旧 Host 无 features 时只读降级，不调用未知写窄口", async () => {
    const store = new MemoryStore();
    const calls: string[] = [];
    const call: CodexCall = async <T>(method: string): Promise<T> => {
      calls.push(method);
      if (method === "codex.status") return { connected: true, threadCount: 0 } as T;
      if (method === "codex.list_threads") return { data: [] } as T;
      if (method === "codex.list_active_threads") return { data: [] } as T;
      if (method === "codex.list_skills") return { data: [] } as T;
      if (method === "codex.drain_events") return { events: [] } as T;
      throw new Error(`unexpected ${method}`);
    };
    const repository = new CodexRepository(call, store);
    const snapshot = await repository.refresh();
    expect(snapshot.compatibility).toEqual({
      readOnly: true,
      message: "当前 Driver 版本不支持这些操作",
    });
    await expect(repository.startTask("/tmp/project", "do it")).rejects.toThrow("不支持");
    expect(calls).not.toContain("codex.start_thread");
  });

  test("审批和中断都透传精确 id，不使用 FIFO", async () => {
    const store = new MemoryStore();
    const calls: Array<{ method: string; params: unknown }> = [];
    const call: CodexCall = async <T>(method: string, params?: unknown): Promise<T> => {
      calls.push({ method, params });
      return { ok: true } as T;
    };
    const repository = new CodexRepository(call, store);
    await repository.respondApproval(91, "denied", "风险太高");
    await repository.interruptTurn(THREAD_ID, "turn-91");
    expect(calls).toEqual([
      {
        method: "codex.respond_approval",
        params: { serverRequestId: 91, decision: "denied", reason: "风险太高" },
      },
      {
        method: "codex.interrupt_turn",
        params: { threadId: THREAD_ID, turnId: "turn-91" },
      },
    ]);
  });
  test("预设点名 Skill 时，首个回合把它排在正文前面一起发出去", async () => {
    // Host 的 turn 窄口本来就收 `{type:"skill", name, path}` 输入行，所以这不是新通道，
    // 只是多发一行。顺序是「先说用哪套办法，再说这次要做什么」。
    const store = new MemoryStore();
    const calls: Array<{ method: string; params: unknown }> = [];
    const call: CodexCall = async <T>(method: string, params?: unknown): Promise<T> => {
      calls.push({ method, params });
      if (method === "codex.status") return {
        connected: true,
        threadCount: 0,
        features: { thread_state_v1: true, task_options_v1: true },
        threads: [],
      } as T;
      if (method === "codex.list_threads" || method === "codex.list_skills") return { data: [] } as T;
      if (method === "codex.start_thread") return { thread: { id: THREAD_ID } } as T;
      if (method === "codex.start_turn") return { turn: { id: "turn-1" } } as T;
      throw new Error(`unexpected ${method}`);
    };
    const repository = new CodexRepository(call, store, { now: () => 123_000 });
    await repository.refresh();
    await repository.startTask({
      cwd: "/tmp/project",
      text: "把发布说明写完",
      skill: { name: "release-notes", path: "/tmp/project/.codex/skills/release-notes" },
    });
    const turn = calls.find((item) => item.method === "codex.start_turn")!;
    expect((turn.params as { input: unknown[] }).input).toEqual([
      { type: "skill", name: "release-notes", path: "/tmp/project/.codex/skills/release-notes" },
      { type: "text", text: "把发布说明写完" },
    ]);
  });

  test("没指定 Skill 时输入行只有正文，不平白多发一行", async () => {
    const store = new MemoryStore();
    const calls: Array<{ method: string; params: unknown }> = [];
    const call: CodexCall = async <T>(method: string, params?: unknown): Promise<T> => {
      calls.push({ method, params });
      if (method === "codex.status") return {
        connected: true,
        threadCount: 0,
        features: { thread_state_v1: true, task_options_v1: true },
        threads: [],
      } as T;
      if (method === "codex.list_threads" || method === "codex.list_skills") return { data: [] } as T;
      if (method === "codex.start_thread") return { thread: { id: THREAD_ID } } as T;
      if (method === "codex.start_turn") return { turn: { id: "turn-1" } } as T;
      throw new Error(`unexpected ${method}`);
    };
    const repository = new CodexRepository(call, store, { now: () => 123_000 });
    await repository.refresh();
    await repository.startTask({ cwd: "/tmp/project", text: "只有正文" });
    const turn = calls.find((item) => item.method === "codex.start_turn")!;
    expect((turn.params as { input: unknown[] }).input).toEqual([
      { type: "text", text: "只有正文" },
    ]);
  });
});
