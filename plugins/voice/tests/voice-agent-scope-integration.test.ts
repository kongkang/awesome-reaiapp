import { afterAll, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { MockHost } from "@reai/app-test/v1";
import type { AgentApprovalSummary, AgentServiceEvent, AgentTurnResult, AppContext } from "@reai/app-sdk/v1";
import manifest from "../app.manifest.json";
import { COMMAND_HISTORY_KEY, DEFAULT_SETTINGS, VoiceStateRepository, type VoiceCommandHistoryItem } from "../src/data";
import type { VoiceConversationOptions } from "../src/agent-conversation";

/*
  F02 / F03 / F04 在真实 Voice 激活、挂载与聊天详情交互上的端到端行为（Host 用内存替身）：
  对话级切换 Agent、续接有界可见聊天、旧会话不提权、审批只显示等待；
  工作目录设置入口已按 2026-09-30 用户裁定移除，存量 direct 目录选择仍生效。
*/
let ownsDom = false;
beforeAll(() => { if (typeof document === "undefined") { GlobalRegistrator.register(); ownsDom = true; } });
afterAll(() => { if (ownsDom) GlobalRegistrator.unregister(); });

async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  const end = Date.now() + 2500;
  while (!await check() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 5));
  expect(await check()).toBeTrue();
}

type Config = { runtime?: string; tools: { ref: string }[]; workspace: { kind: string; path?: string }; mode?: string };
type Start = { sessionId: string; idempotencyKey: string; text: string };
type LegacySend = { sessionId: string; turnId?: string; text: string };

/** 旧条目没有 conversationId：可见对话的键沿用它的会话 id（`conversationKey`）。 */
const SEED: VoiceCommandHistoryItem = {
  id: "seed", transcript: "原来的问题", reply: "PI_OLD_ANSWER", status: "completed", commandId: "voice.command.agent",
  agentSessionId: "pi-old", createdAt: "2026-09-20T09:00:00.000Z", messages: [
    { from: "user", text: "原来的问题", at: "2026-09-20T09:00:00.000Z" },
    { from: "ai", text: "PI_OLD_ANSWER", runtime: "pi", usage: { complete: true, inputTokens: 10, outputTokens: 2, totalTokens: 12 }, at: "2026-09-20T09:00:01.000Z" },
  ],
};

async function mount(options: {
  scopeProof?: boolean; unsupportedBackends?: string[]; pick?: () => Promise<string | undefined>;
  history?: VoiceCommandHistoryItem[]; choices?: Record<string, VoiceConversationOptions>; failSave?: boolean;
  rejectFirstStart?: boolean;
} = {}) {
  document.body.replaceChildren();
  let context!: AppContext;
  const configs: Config[] = [];
  const starts: Start[] = [];
  const legacy: LegacySend[] = [];
  const legacyPending: ((value: unknown) => void)[] = [];
  const waiting = new Map<string, (value: AgentTurnResult) => void>();
  const events = new Map<string, AgentServiceEvent[]>();
  const deleted: string[] = [];
  const runtimeOf = new Map<string, "pi" | "dsh" | "codex">();
  let picks = 0;
  let emitAgentEvent: Parameters<AppContext["events"]["onLocalAgent"]>[0] | undefined;
  let rejectStart = options.rejectFirstStart ?? false;
  const host = new MockHost({
    manifest: structuredClone(manifest) as never,
    loadApp: async () => {
      const { default: app } = await import("../src/app?agent-scope=" + crypto.randomUUID());
      return { default: { ...app, async activate(ctx: AppContext) {
        context = ctx;
        const onLocalAgent = ctx.events.onLocalAgent.bind(ctx.events);
        ctx.events.onLocalAgent = (handler) => { emitAgentEvent = handler; return onLocalAgent(handler); };
        const store = ctx.storage.private("voice-state");
        await store.set("recognition-engine-choice-v1", "local");
        await store.set("settings", { ...DEFAULT_SETTINGS, polish: "raw" });
        if (options.choices) await store.set("command-conversation-options-v1", options.choices);
        await store.set(COMMAND_HISTORY_KEY, options.history ?? [SEED]);
        ctx.folderPick.pick = async () => { picks++; return options.pick ? options.pick() : "/workspace/project"; };
        if (options.failSave) {
          const privateStore = ctx.storage.private.bind(ctx.storage);
          ctx.storage.private = name => {
            const target = privateStore(name);
            return { ...target, set: async (key, value) => {
              if (key === "command-conversation-options-v1") throw new Error("simulated storage failure");
              await target.set(key, value);
            } };
          };
        }
        Object.assign(ctx.agent, {
          backends: async () => ({ schemaVersion: 2, defaultBackend: "pi", backends: (["pi", "dsh", "codex"] as const).map(backend => ({
            backend, available: true, downloadRequired: false, detail: "",
            capabilities: { hostTools: true, fileTools: true, turnModes: ["chat", "plan", "yolo"], modelSelection: "host-settings",
              ...(options.unsupportedBackends?.includes(backend) ? {} : { scopedExecutionVersion: 1, commandExecution: true }) },
          })) }),
          createSession: async (config: Config) => {
            configs.push(structuredClone(config));
            const sessionId = `agent2-new-${configs.length}`;
            const runtime = config.runtime === "dsh" || config.runtime === "codex" ? config.runtime : "pi";
            runtimeOf.set(sessionId, runtime);
            const scoped = config.tools.some(tool => tool.ref === "command");
            return { schemaVersion: 2, sessionId, backend: runtime, runtime,
              ...(options.scopeProof === false || !scoped ? {} : {
                workspace: config.workspace,
                workspaceRoot: config.workspace.kind === "direct" ? config.workspace.path : "/Host/private/workspace",
                scopeVersion: 1,
              }) };
          },
          listSessions: async () => ({ sessions: [
            { sessionId: "pi-old", backend: "pi", memory: "session", createdMs: 1, updatedMs: 1, stale: false },
            ...[...runtimeOf].map(([sessionId, backend]) => ({ sessionId, backend, runtime: backend, memory: "session", createdMs: 1, updatedMs: 1, stale: false })),
          ] }),
          startTurn: async (input: Start) => {
            starts.push(structuredClone(input));
            if (rejectStart) { rejectStart = false; throw Object.assign(new Error("admission rejected"), { code: "AGENT_BACKEND_UNAVAILABLE", retryable: false }); }
            return { schemaVersion: 2, sessionId: input.sessionId, turnId: `native-${starts.length}`, runtime: runtimeOf.get(input.sessionId) ?? "pi",
              status: "running", expired: false, result: null, createdAt: 1, updatedAt: 1 };
          },
          events: async ({ sessionId, turnId }: { sessionId: string; turnId: string }) => ({ schemaVersion: 2, sessionId, turnId, runtime: runtimeOf.get(sessionId) ?? "pi",
            status: "running", expired: false, result: null, createdAt: 1, updatedAt: 1, events: events.get(turnId) ?? [], gap: false, nextSequence: events.get(turnId)?.length ?? 0 }),
          waitForTurn: async ({ turnId }: { turnId: string }) => new Promise<AgentTurnResult>(resolve => waiting.set(turnId, resolve)),
          cancel: async () => ({ cancelled: true }),
          deleteSession: async ({ sessionId }: { sessionId: string }) => { deleted.push(sessionId); return { deleted: true }; },
          send: async (input: LegacySend) => { legacy.push(structuredClone(input)); return new Promise(resolve => legacyPending.push(resolve)); },
        });
        return app.activate(ctx);
      } } };
    },
    createRoot: () => { const root = document.createElement("div"); document.body.append(root); return root; },
  });
  await host.installAndEnable();
  const { root: surface } = await host.openSurface("main");
  const root = surface!;
  root.querySelector<HTMLButtonElement>('[data-voice-tab="command"]')!.click();
  root.querySelector<HTMLButtonElement>(".command-history-item")!.click();
  const expand = async () => {
    if (!root.querySelector(".chat-scope-panel")) root.querySelector<HTMLButtonElement>(".chat-scope-toggle")!.click();
    await until(() => root.querySelector<HTMLSelectElement>(".chat-agent-select")?.disabled === false);
  };
  const finish = (index: number, result: Partial<AgentTurnResult>) => {
    const start = starts[index]!;
    const turnId = `native-${index + 1}`;
    waiting.get(turnId)!({ schemaVersion: 2, sessionId: start.sessionId, turnId, runtime: runtimeOf.get(start.sessionId) ?? "pi",
      channel: "external-brain", status: "completed", text: null, content: [], usage: null, toolAttempts: [], failure: null, ...result } as AgentTurnResult);
  };
  return {
    root, host, configs, starts, legacy, legacyPending, deleted, events, expand, finish, picks: () => picks,
    emit: (event: AgentServiceEvent) => { expect(emitAgentEvent).toBeDefined(); emitAgentEvent!(event as never); },
    waitingFor: (turnId: string) => waiting.has(turnId),
    load: () => new VoiceStateRepository(context.storage.private("voice-state")).load(),
    switch: async (backend: string) => {
      await expand();
      const select = root.querySelector<HTMLSelectElement>(".chat-agent-select")!;
      select.value = backend; select.dispatchEvent(new Event("change", { bubbles: true }));
      await until(() => root.querySelector<HTMLSelectElement>(".chat-agent-select")?.disabled === false);
    },
    send: (text: string) => {
      const input = root.querySelector<HTMLInputElement>(".chat-input")!;
      expect(input.disabled).toBeFalse();
      input.value = text; input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    },
    settle: () => until(() => root.querySelector<HTMLInputElement>(".chat-input")?.disabled === false
      && !root.querySelector(".chat-scope-note[role=status]")),
    close: async () => {
      for (const [, resolve] of waiting) resolve({ schemaVersion: 2, sessionId: "", turnId: "", runtime: "pi", channel: "external-brain", status: "cancelled", text: null, content: [], usage: null, toolAttempts: [], failure: { kind: "killed", code: "AGENT_CANCELLED", stage: "cancel", retry: "new-turn", message: "" } } as unknown as AgentTurnResult);
      legacyPending.forEach(resolve => resolve({ turnId: "", text: null, failure: { kind: "killed" } }));
      await host.disable();
    },
  };
}

const failure = { kind: "engine", code: "AGENT_RUNTIME_FAILED", stage: "runtime", retry: "new-turn", message: "engine failed" } as unknown as AgentTurnResult["failure"];

test("切换到 DSH 只改本对话：新会话带 17 项工具与 yolo，第一条续接可见聊天；受理后失败的重试不重放背景", async () => {
  const h = await mount();
  try {
    await h.switch("dsh");
    h.send("新的问题");
    await until(() => h.starts.length === 1);
    expect(h.configs).toHaveLength(1);
    expect(h.configs[0]).toMatchObject({ runtime: "dsh", mode: "yolo", workspace: { kind: "app-private" } });
    expect(h.configs[0]!.tools).toHaveLength(17);
    expect(h.configs[0]!.tools.map(tool => tool.ref)).toEqual(expect.arrayContaining(["read", "write", "edit", "list", "glob", "grep", "command"]));
    expect(h.starts[0]!.text).toContain("PI_OLD_ANSWER");
    expect(h.starts[0]!.text).toContain("不重放已执行动作");
    // 工具卡、用量等元数据永远不进续接种子；用户界面也看不到这段引用资料。
    expect(h.starts[0]!.text).not.toContain("totalTokens");
    expect(h.root.textContent).not.toContain("此前可见聊天");
    // 受理之后才失败：上下文已进入新会话的记录。
    await until(() => h.waitingFor("native-1"));
    h.finish(0, { status: "failed", failure });
    await h.settle();
    expect((await h.load()).conversationOptions["pi-old"]?.continuationPending).toBeUndefined();
    h.send("继续，只处理这句话");
    await until(() => h.starts.length === 2);
    expect(h.configs).toHaveLength(1);
    expect(h.starts[1]!.sessionId).toBe(h.starts[0]!.sessionId);
    expect(h.starts[1]!.text).toBe("继续，只处理这句话");
    await until(() => h.waitingFor("native-2"));
    h.finish(1, { text: "DSH_NEW_ANSWER" });
    await h.settle();
    const loaded = await h.load();
    // 只改本对话，不写 Driver 全局默认；旧条目的运行归属与用量原样保留。
    expect(loaded.agentExperiment?.backend).toBe("auto");
    expect(loaded.conversationOptions["pi-old"]).toMatchObject({ backend: "dsh", resolvedBackend: "dsh", sessionId: "agent2-new-1", scopeVersion: 1 });
    expect(loaded.commandHistory!.find(item => item.id === "seed")).toMatchObject({ agentSessionId: "pi-old" });
    expect(loaded.commandHistory!.find(item => item.id === "seed")!.messages!.at(-1)).toMatchObject({ runtime: "pi", usage: { totalTokens: 12 } });
    expect(loaded.commandHistory!.filter(item => item.conversationId === "pi-old" || item.id === "seed")).toHaveLength(3);
    expect(h.root.textContent).toContain("PI_OLD_ANSWER");
    expect(h.root.textContent).toContain("DSH_NEW_ANSWER");
    expect(h.legacy).toHaveLength(0);
  } finally { await h.close(); }
});

test("切换后的第一条在 Host 受理前就失败：同一会话的重试仍附上续接上下文，受理后才清标记", async () => {
  const h = await mount({ rejectFirstStart: true });
  try {
    await h.switch("codex");
    h.send("第一次尝试");
    await until(() => h.starts.length === 1);
    await h.settle();
    expect(h.starts[0]!.text).toContain("PI_OLD_ANSWER");
    expect((await h.load()).conversationOptions["pi-old"]).toMatchObject({ sessionId: "agent2-new-1", continuationPending: true });
    h.send("再试一次");
    await until(() => h.starts.length === 2);
    expect(h.configs).toHaveLength(1);
    expect(h.starts[1]!.sessionId).toBe("agent2-new-1");
    expect(h.starts[1]!.text).toContain("PI_OLD_ANSWER");
    expect(h.starts[1]!.text).toContain("再试一次");
    await until(async () => (await h.load()).conversationOptions["pi-old"]?.continuationPending === undefined);
    await until(() => h.waitingFor("native-2"));
    h.finish(1, { text: "CODEX_ANSWER" });
    await h.settle();
    h.send("第三句");
    await until(() => h.starts.length === 3);
    expect(h.starts[2]!.text).toBe("第三句");
  } finally { await h.close(); }
});

test("对话详情不再提供工作目录设置入口：无切目录按钮与目录文案、系统目录面板永不弹出；只改本对话 Agent 的面板仍在", async () => {
  const h = await mount();
  try {
    await h.expand();
    // 回退防线：把「App 工作目录 / 更换授权文件夹」入口加回来，这三条当场变红。
    expect(h.root.querySelector(".chat-folder-pick")).toBeNull();
    expect(h.root.querySelector(".chat-scope-path")).toBeNull();
    expect(h.root.textContent).not.toContain("工作目录");
    // 「只改本对话 Agent」不陪葬：面板里仍有 Agent 选择器。
    expect(h.root.querySelector<HTMLSelectElement>(".chat-agent-select")).not.toBeNull();
    expect(h.picks()).toBe(0);
  } finally { await h.close(); }
});

test("存量对话此前选过的 direct 工作目录仍生效：撤的只是 UI 入口，不清洗既有选择", async () => {
  const h = await mount({ choices: { "pi-old": { backend: "dsh", workspace: { kind: "direct", path: "/workspace/project" } } } });
  try {
    h.send("写入一个测试文件");
    await until(() => h.starts.length === 1);
    expect(h.configs[0]).toMatchObject({ runtime: "dsh", workspace: { kind: "direct", path: "/workspace/project" }, mode: "yolo" });
    expect(h.picks()).toBe(0);
  } finally { await h.close(); }
});

test("Host 没给范围执行证明时，显式选择的会话不发任何模型请求并删掉刚建的会话", async () => {
  const h = await mount({ scopeProof: false });
  try {
    await h.switch("codex");
    h.send("write a file");
    await until(() => h.configs.length === 1);
    await h.settle();
    expect(h.starts).toHaveLength(0);
    expect(h.legacy).toHaveLength(0);
    expect(h.deleted).toContain("agent2-new-1");
  } finally { await h.close(); }
});

test("没改过选择的旧对话继续用原会话：不新建会话、不追加文件与命令工具", async () => {
  const h = await mount();
  try {
    h.send("继续原来的聊天");
    await until(() => h.legacy.length === 1);
    expect(h.configs).toHaveLength(0);
    expect(h.starts).toHaveLength(0);
    expect(h.legacy[0]).toMatchObject({ sessionId: "pi-old", text: "继续原来的聊天" });
  } finally { await h.close(); }
});

test("选择保存失败时保留原选择，不出现虚假的切换成功，也不起任何请求", async () => {
  const h = await mount({ failSave: true });
  try {
    await h.switch("dsh");
    expect((await h.load()).conversationOptions).toEqual({});
    expect(h.root.querySelector<HTMLSelectElement>(".chat-agent-select")?.value).toBe("auto");
    expect(h.root.querySelector(".chat-send-error")).not.toBeNull();
    expect(h.configs).toHaveLength(0);
    expect(h.starts).toHaveLength(0);
  } finally { await h.close(); }
});

test("显式选的 Agent 在当前平台没有范围执行：零 create/send，也不偷换成其它 Agent", async () => {
  const h = await mount({ unsupportedBackends: ["pi"], choices: { "pi-old": { backend: "pi" } } });
  try {
    h.send("读取文件");
    await h.settle();
    expect(h.configs).toHaveLength(0);
    expect(h.starts).toHaveLength(0);
    expect(h.legacy).toHaveLength(0);
    expect(h.root.querySelector(".chat-send-error")).not.toBeNull();
    expect((await h.load()).conversationOptions["pi-old"]?.backend).toBe("pi");
  } finally { await h.close(); }
});

test("越界审批只显示「等待 Host 确认」：挂在正在运行的那条上，插件里没有批准入口；解决后消失", async () => {
  const h = await mount();
  try {
    await h.switch("pi");
    h.send("改一下项目外的文件");
    await until(() => h.waitingFor("native-1"));
    expect(h.root.querySelector(".chat-approval-status")).toBeNull();
    const approval: AgentApprovalSummary = { id: "approval-1", sessionId: "agent2-new-1", turnId: "native-1", toolCallId: "call-1",
      actionDigest: "d".repeat(64), description: "write: /outside/file", paths: [{ path: "/outside/file", write: true }],
      status: "pending", createdMs: 1, expiresMs: Date.now() + 120_000 };
    const event = (sequence: number, type: "approval.requested" | "approval.resolved", status: AgentApprovalSummary["status"]) =>
      ({ ...approval, status, schemaVersion: 2, sessionId: "agent2-new-1", turnId: "native-1", runtime: "pi", type, sequence, timestamp: sequence }) as unknown as AgentServiceEvent;
    h.emit(event(1, "approval.requested", "pending"));
    await until(() => h.root.querySelector(".chat-approval-status") !== null);
    const status = h.root.querySelector(".chat-approval-status")!;
    expect(status.getAttribute("role")).toBe("status");
    // 插件界面里不存在任何批准 / 允许按钮。
    const labels = Array.from(h.root.querySelectorAll("button"), button => button.textContent ?? "");
    expect(labels.some(label => /允许|批准|Allow|Approve/.test(label))).toBeFalse();
    h.emit(event(2, "approval.resolved", "denied"));
    await until(() => h.root.querySelector(".chat-approval-status") === null);
  } finally { await h.close(); }
});
