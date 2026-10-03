/**
 * SDK 运行时的约束测试。
 *
 * 这里测的都是「写错了不会立刻报错、但会在用户机器上变成怪事」的那类约束：
 * 晚注册、重复注册、ready 调两次、卸载后没清理。
 */

import { describe, expect, mock, test } from "bun:test";
import {
  brokerFetch,
  defineApp,
  isHostInternalUrl,
  NotifyMethod,
  RequestMethod,
  runApp,
  type AppContext,
  type HostBridge,
  type HostMessage,
} from "../src/v1/index";

interface Recorded {
  method: string;
  params: unknown;
}

function makeBridge(): {
  bridge: HostBridge;
  notifications: Recorded[];
  requests: Recorded[];
  send(message: HostMessage): void;
  requestResult: Map<string, unknown>;
} {
  const notifications: Recorded[] = [];
  const requests: Recorded[] = [];
  const requestResult = new Map<string, unknown>();
  const handlers = new Set<(m: HostMessage) => void>();

  return {
    notifications,
    requests,
    requestResult,
    send(message) {
      for (const handler of [...handlers]) handler(message);
    },
    bridge: {
      async request(method, params) {
        requests.push({ method, params });
        return requestResult.get(method) as never;
      },
      notify(method, params) {
        notifications.push({ method, params });
      },
      subscribe(handler) {
        handlers.add(handler);
        return () => handlers.delete(handler);
      },
    },
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("1.21 越界审批只读：SDK 只列出当前会话审批，不提供批准方法", async () => {
  const harness = makeBridge();
  const approvals = [{ id: "approval-1", sessionId: "session-1", turnId: "turn-1", toolCallId: "tool-1", actionDigest: "digest", description: "write outside", paths: [{ path: "/selected/file", write: true }], status: "pending" as const, createdMs: 1, expiresMs: 2 }];
  harness.requestResult.set("agent.session.approvals.list", { approvals });
  harness.requestResult.set("agent.v2.session.approvals.list", { approvals });
  let context!: AppContext;
  const app = runApp(defineApp({ activate(ctx) { context = ctx; } }), harness.bridge);
  harness.send({ type: "activate", runtimeSessionId: "runtime-scope" });
  await tick();
  expect(await context.agent.approvals.list({ sessionId: "session-1" })).toEqual({ approvals });
  expect(harness.requests).toContainEqual({ method: "agent.session.approvals.list", params: { sessionId: "session-1" } });
  expect(await context.agent.approvals.list({ sessionId: "agent2-session" })).toEqual({ approvals });
  expect(harness.requests).toContainEqual({ method: "agent.v2.session.approvals.list", params: { sessionId: "agent2-session" } });
  expect(Object.keys(context.agent.approvals)).toEqual(["list"]);
  await app.dispose();
});

test("1.21 审批事件沿公开 local.event，只接受当前 runtime 与存活 surface", async () => {
  const harness = makeBridge();
  const observed: unknown[] = [];
  const app = runApp(defineApp({ activate(ctx) {
    ctx.surfaces.register("main", () => {});
    ctx.events.onLocalAgent(event => observed.push(event));
  } }), harness.bridge);
  harness.send({ type: "activate", runtimeSessionId: "rt-approval" });
  harness.send({ type: "surface.mount", surfaceMountId: "surface-approval", surfaceId: "main", root: {} });
  await tick();
  const event = { type: "approval.requested", id: "a", sessionId: "s", turnId: "t", toolCallId: "call", actionDigest: "digest", description: "write", paths: [{ path: "/outside", write: true }], status: "pending", createdMs: 1, expiresMs: 2 };
  harness.send({ type: "local.event", runtimeSessionId: "old", surfaceMountId: "surface-approval", event });
  harness.send({ type: "local.event", runtimeSessionId: "rt-approval", surfaceMountId: "old", event });
  expect(observed).toEqual([]);
  harness.send({ type: "local.event", runtimeSessionId: "rt-approval", surfaceMountId: "surface-approval", event });
  expect(observed).toEqual([event]);
  const resolved = { ...event, type: "approval.resolved", status: "denied" };
  harness.send({ type: "local.event", runtimeSessionId: "rt-approval", surfaceMountId: "surface-approval", event: resolved });
  expect(observed).toEqual([event, resolved]);
  await app.dispose();
  harness.send({ type: "local.event", runtimeSessionId: "rt-approval", surfaceMountId: "surface-approval", event });
  expect(observed).toHaveLength(2);
});

test.each(["pi", "dsh", "codex"] as const)("%s 1.21 direct 工作区原样编码并保留 Host 根与 scopeVersion", async backend => {
  const harness = makeBridge();
  const response = { sessionId: "direct-session", backend, workspace: { kind: "direct" as const, path: "/chosen/project" }, workspaceRoot: "/chosen/project", scopeVersion: 1 as const };
  harness.requestResult.set(RequestMethod.AgentSessionCreate, response);
  let context!: AppContext;
  const app = runApp(defineApp({ activate(ctx) { context = ctx; } }), harness.bridge);
  harness.send({ type: "activate", runtimeSessionId: "runtime-direct" });
  await tick();
  const spec = { backend, systemPrompt: "bounded", tools: ["read", "command"], skills: [], workspace: { kind: "direct" as const, path: "/chosen/project" }, memory: "session" as const, mode: "yolo" as const };
  expect(await context.agent.createSession(spec)).toEqual(response);
  expect(harness.requests.at(-1)).toEqual({ method: RequestMethod.AgentSessionCreate, params: { spec } });
  await app.dispose();
});

test("开发者模式变更只接受当前会话，关闭后立即通知且迟到快照不覆盖", async () => {
  const harness = makeBridge();
  let resolveSnapshot!: (value: { developerMode: boolean }) => void;
  harness.requestResult.set(RequestMethod.EnvironmentGet, new Promise((resolve) => { resolveSnapshot = resolve; }));
  let context!: AppContext;
  const app = runApp(defineApp({ activate(ctx) { context = ctx; } }), harness.bridge);
  harness.send({ type: "activate", runtimeSessionId: "runtime-env" });
  await tick();
  const values: boolean[] = [];
  context.environment.onChange((value) => values.push(value.developerMode));
  const pending = context.environment.get();
  harness.send({ type: "environment.changed", runtimeSessionId: "another", developerMode: true });
  expect(values).toEqual([]);
  harness.send({ type: "environment.changed", runtimeSessionId: "runtime-env", developerMode: true });
  harness.send({ type: "environment.changed", runtimeSessionId: "runtime-env", developerMode: false });
  resolveSnapshot({ developerMode: true });
  expect(await pending).toEqual({ developerMode: false });
  expect(values).toEqual([true, false]);
  await app.dispose();
  harness.send({ type: "environment.changed", runtimeSessionId: "runtime-env", developerMode: true });
  expect(values).toEqual([true, false]);
});

describe("Host 网络 Broker", () => {
  test("Windows 内部资源只认 ipc 与当前 originId 路径", () => {
    const base = "http://reai-app.localhost/s_abcd/index.html";
    expect(isHostInternalUrl("http://ipc.localhost/ping", base)).toBe(true);
    expect(isHostInternalUrl("./assets/app.js", base)).toBe(true);
    expect(isHostInternalUrl("http://reai-app.localhost/s_other/secret", base)).toBe(false);
    expect(isHostInternalUrl("https://example.com/api", base)).toBe(false);
  });

  test("ctx.http.fetch 编码请求并还原标准 Response", async () => {
    const harness = makeBridge();
    harness.requestResult.set(RequestMethod.HttpFetch, {
      status: 201,
      statusText: "Created",
      url: "https://example.com/api/tasks",
      headers: { "content-type": "application/json" },
      bodyBase64: btoa('{"ok":true}'),
    });
    let context: AppContext | undefined;
    runApp(defineApp({ activate(ctx) { context = ctx; } }), harness.bridge);
    harness.send({ type: "activate", runtimeSessionId: "rt-http" });
    await tick();
    const response = await context!.http.fetch("https://example.com/api/tasks", {
      endpointId: "api",
      method: "POST",
      body: "hello",
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ ok: true });
    expect(harness.requests[0]?.method).toBe(RequestMethod.HttpFetch);
    expect(harness.requests[0]?.params).toMatchObject({
      endpointId: "api",
      method: "POST",
      url: "https://example.com/api/tasks",
      bodyBase64: btoa("hello"),
    });
  });

  test("AbortSignal 会显式调用 http.cancel", async () => {
    const requests: Recorded[] = [];
    let rejectFetch: ((reason: unknown) => void) | undefined;
    const bridge: HostBridge = {
      request(method, params) {
        requests.push({ method, params });
        if (method === RequestMethod.HttpCancel) {
          rejectFetch?.({ code: "NETWORK_CANCELLED", message: "cancelled" });
          return Promise.resolve({ cancelled: true }) as never;
        }
        return new Promise((_, reject) => { rejectFetch = reject; });
      },
      notify() {},
      subscribe() { return () => undefined; },
    };
    const controller = new AbortController();
    const pending = brokerFetch(bridge, "https://example.com/api", { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(requests.map((item) => item.method)).toContain(RequestMethod.HttpCancel);
  });

  test("带 body 的请求在编码窗口 abort 后不会再发 http.fetch", async () => {
    const requests: Recorded[] = [];
    const bridge: HostBridge = {
      request(method, params) {
        requests.push({ method, params });
        return Promise.resolve({ cancelled: true }) as never;
      },
      notify() {},
      subscribe() { return () => undefined; },
    };
    const controller = new AbortController();
    const pending = brokerFetch(bridge, "https://example.com/api", {
      method: "POST",
      body: "will-not-send",
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(requests.map((item) => item.method)).toContain(RequestMethod.HttpCancel);
    expect(requests.map((item) => item.method)).not.toContain(RequestMethod.HttpFetch);
  });
});

describe("Host 剪贴板 Broker", () => {
  test("ctx.clipboard.writeText 只透传明确的纯文本写入", async () => {
    const harness = makeBridge();
    harness.requestResult.set(RequestMethod.ClipboardWriteText, { written: true });
    let context: AppContext | undefined;
    runApp(defineApp({ activate(ctx) { context = ctx; } }), harness.bridge);
    harness.send({ type: "activate", runtimeSessionId: "rt-clipboard" });
    await tick();

    await expect(context!.clipboard.writeText("需要复制的文字")).resolves.toEqual({ written: true });
    expect(harness.requests.at(-1)).toEqual({
      method: RequestMethod.ClipboardWriteText,
      params: { text: "需要复制的文字" },
    });
  });
});

test("codex.event 同时校验 runtimeSessionId 与 surfaceMountId", async () => {
  const harness = makeBridge();
  const observed: unknown[] = [];
  runApp(
    defineApp({
      activate(ctx) {
        ctx.surfaces.register("main", () => {});
        ctx.events.onCodex((event) => observed.push(event));
      },
    }),
    harness.bridge,
  );
  harness.send({ type: "activate", runtimeSessionId: "rt-codex" });
  harness.send({ type: "surface.mount", surfaceMountId: "m-codex", surfaceId: "main", root: {} });
  await tick();

  harness.send({
    type: "codex.event",
    runtimeSessionId: "stale",
    surfaceMountId: "m-codex",
    event: { kind: "thread_summary", thread: { threadId: "a" } },
  });
  harness.send({
    type: "codex.event",
    runtimeSessionId: "rt-codex",
    surfaceMountId: "stale-mount",
    event: { kind: "thread_summary", thread: { threadId: "b" } },
  });
  harness.send({
    type: "codex.event",
    runtimeSessionId: "rt-codex",
    surfaceMountId: "m-codex",
    event: { kind: "thread_summary", thread: { threadId: "good" } },
  });
  expect(observed).toEqual([{ kind: "thread_summary", thread: { threadId: "good" } }]);
});

test("host.pending_overflow 暴露通用重同步信号", async () => {
  const harness = makeBridge();
  const observed: unknown[] = [];
  runApp(
    defineApp({
      activate(ctx) {
        ctx.events.on((event) => observed.push(event));
      },
    }),
    harness.bridge,
  );
  harness.send({ type: "activate", runtimeSessionId: "rt-overflow" });
  await tick();
  harness.send({ type: "host.pending_overflow", dropped: 9 });
  expect(observed).toEqual([{
    eventType: "host.pending_overflow",
    payload: { dropped: 9 },
  }]);
});

test("voiceCommand.run 对已取消 signal 直接短路且不发送请求", async () => {
  const harness = makeBridge();
  let context: AppContext | undefined;
  runApp(
    defineApp({
      activate(ctx) {
        context = ctx;
      },
    }),
    harness.bridge,
  );
  harness.send({ type: "activate", runtimeSessionId: "rt-voice-command" });
  await tick();

  const controller = new AbortController();
  controller.abort();
  await expect(context?.voiceCommand.run({ text: "不会发送" }, { signal: controller.signal }))
    .rejects.toMatchObject({ code: "voice.command/CANCELLED" });
  expect(harness.requests.some((request) => request.method.startsWith("voice.command."))).toBe(false);
});

test("dshAgent 暴露稳定 turnId、按回合取消与会话删除契约", async () => {
  const harness = makeBridge();
  harness.requestResult.set(RequestMethod.DshSessionSend, { turnId: "turn-1", text: "完成", failure: null });
  harness.requestResult.set(RequestMethod.DshSessionCancel, { cancelled: true });
  harness.requestResult.set(RequestMethod.DshSessionDelete, { deleted: true });
  let context: AppContext | undefined;
  runApp(defineApp({ activate(ctx) { context = ctx; } }), harness.bridge);
  harness.send({ type: "activate", runtimeSessionId: "rt-dsh" });
  await tick();

  await context!.dshAgent.send({ sessionId: "reai-1", turnId: "turn-1", text: "读取状态" });
  await context!.dshAgent.cancel({ sessionId: "reai-1", turnId: "turn-1" });
  await context!.dshAgent.deleteSession({ sessionId: "reai-1" });

  expect(harness.requests.slice(-3)).toEqual([
    {
      method: RequestMethod.DshSessionSend,
      params: { sessionId: "reai-1", turnId: "turn-1", text: "读取状态" },
    },
    {
      method: RequestMethod.DshSessionCancel,
      params: { sessionId: "reai-1", turnId: "turn-1" },
    },
    {
      method: RequestMethod.DshSessionDelete,
      params: { sessionId: "reai-1" },
    },
  ]);
});

test("Codex Tasks 与本地文件客户端只编码类型化的 Host Broker 请求", async () => {
  const harness = makeBridge();
  harness.requestResult.set(RequestMethod.CodexTasksLoginStart, {
    loginId: "login-1",
    mode: "deviceCode",
    verificationUrl: "https://example.test/device",
    userCode: "ABCD-EFGH",
  });
  harness.requestResult.set(RequestMethod.CodexTasksFileHandoffCreate, {
    token: "handoff-1",
    expiresAt: 42,
  });
  harness.requestResult.set(RequestMethod.LocalFilesWorkspaceList, {
    workspaces: [{ id: "workspace-1", name: "资料", grantedAt: 1 }],
  });
  harness.requestResult.set(RequestMethod.LocalFilesDocumentRead, {
    workspaceId: "workspace-1",
    path: "notes.md",
    content: "# Notes",
    revision: "sha256:old",
    size: 7,
  });
  let context: AppContext | undefined;
  runApp(defineApp({ activate(ctx) { context = ctx; } }), harness.bridge);
  harness.send({ type: "activate", runtimeSessionId: "rt-owned-codex" });
  await tick();

  expect(await context!.codexTasks.startLogin("deviceCode")).toMatchObject({ loginId: "login-1" });
  expect(await context!.codexTasks.createFileHandoff("thread-1", "notes.md")).toEqual({
    token: "handoff-1",
    expiresAt: 42,
  });
  await context!.codexTasks.respondUserInput(17, {
    scope: ["只处理 App"],
  });
  expect(await context!.localFiles.listWorkspaces()).toHaveLength(1);
  expect(await context!.localFiles.readDocument("workspace-1", "notes.md")).toMatchObject({
    revision: "sha256:old",
  });
  await context!.localFiles.writeDocument({
    workspaceId: "workspace-1",
    path: "notes.md",
    content: "# Updated",
    expectedRevision: "sha256:old",
  });

  expect(harness.requests).toEqual(expect.arrayContaining([
    { method: RequestMethod.CodexTasksLoginStart, params: { mode: "deviceCode" } },
    {
      method: RequestMethod.CodexTasksFileHandoffCreate,
      params: { threadId: "thread-1", path: "notes.md" },
    },
    {
      method: RequestMethod.CodexTasksUserInputRespond,
      params: { requestId: 17, answers: { scope: ["只处理 App"] } },
    },
    { method: RequestMethod.LocalFilesWorkspaceList, params: {} },
    {
      method: RequestMethod.LocalFilesDocumentRead,
      params: { workspaceId: "workspace-1", path: "notes.md" },
    },
    {
      method: RequestMethod.LocalFilesDocumentWrite,
      params: {
        workspaceId: "workspace-1",
        path: "notes.md",
        content: "# Updated",
        expectedRevision: "sha256:old",
      },
    },
  ]));
});

test.each(["pi", "dsh", "codex"] as const)("%s Session Spec 原样编码且完整生命周期只走统一方法面", async (backend) => {
  const harness = makeBridge();
  harness.requestResult.set(RequestMethod.AgentSessionCreate, { sessionId: "agent-1", backend });
  const terminal = { turnId: "turn-1", text: "完成", failure: null, runtime: backend,
    channel: "external-brain" as const, usage: { complete: true, inputTokens: 7, outputTokens: 3, totalTokens: 10 } };
  harness.requestResult.set(RequestMethod.AgentSessionSend, terminal);
  harness.requestResult.set(RequestMethod.AgentSessionCancel, { cancelled: true });
  let context: AppContext | undefined;
  runApp(defineApp({ activate(ctx) { context = ctx; } }), harness.bridge);
  harness.send({ type: "activate", runtimeSessionId: "rt-agent" });
  await tick();

  const created = await context!.agent.createSession({
    backend,
    systemPrompt: "只回答用户的问题",
    tools: ["device_status"],
    skills: [{ id: "voice", title: "Voice", content: "保持简洁" }],
    workspace: { kind: "app-private" },
    memory: "session",
  });
  const sent = await context!.agent.send({
    sessionId: created.sessionId,
    turnId: "turn-1",
    text: "状态",
    taskPresentation: "caller",
  });
  expect(sent).toEqual(terminal);
  await context!.agent.cancel({ sessionId: created.sessionId, turnId: "turn-1" });

  expect(harness.requests.slice(-3)).toEqual([
    {
      method: RequestMethod.AgentSessionCreate,
      params: {
        spec: {
          backend,
          systemPrompt: "只回答用户的问题",
          tools: ["device_status"],
          skills: [{ id: "voice", title: "Voice", content: "保持简洁" }],
          workspace: { kind: "app-private" },
          memory: "session",
        },
      },
    },
    {
      method: RequestMethod.AgentSessionSend,
      params: {
        sessionId: "agent-1",
        turnId: "turn-1",
        text: "状态",
        taskPresentation: "caller",
      },
    },
    { method: RequestMethod.AgentSessionCancel, params: { sessionId: "agent-1", turnId: "turn-1" } },
  ]);
});

describe("activate 与注册", () => {
  test("systemTasks 只发送归一化状态查询与白名单任务意图", async () => {
    const harness = makeBridge();
    harness.requestResult.set(RequestMethod.SystemTasksVersionStatus, {
      firmware: {
        currentVersion: "1.49",
        latestVersion: "1.57",
        updateAvailable: true,
        connected: true,
        connectionType: "usb",
      },
      app: {
        currentVersion: "0.1.0",
        latestVersion: "0.20.3",
        updateAvailable: false,
        installable: false,
        blockedReason: "development-build",
      },
      source: "remote",
    });
    harness.requestResult.set(RequestMethod.SystemTasksOpen, {
      taskId: "task-1",
      accepted: true,
    });
    let context: AppContext | undefined;
    runApp(
      defineApp({
        activate(ctx) {
          context = ctx;
        },
      }),
      harness.bridge,
    );
    harness.send({ type: "activate", runtimeSessionId: "rt-system-task" });
    await tick();

    const status = await context!.systemTasks.getVersionStatus({ refresh: true });
    const opened = await context!.systemTasks.open({
      target: "firmware-upgrade",
      returnIntent: { reason: "voice-firmware-required" },
    });

    expect(status.source).toBe("remote");
    expect(opened).toEqual({ taskId: "task-1", accepted: true });
    expect(harness.requests.slice(-2)).toEqual([
      {
        method: RequestMethod.SystemTasksVersionStatus,
        params: { refresh: true },
      },
      {
        method: RequestMethod.SystemTasksOpen,
        params: {
          target: "firmware-upgrade",
          returnIntent: { reason: "voice-firmware-required" },
        },
      },
    ]);
  });

  test("notifications.post 透传最小 title/body 负载", async () => {
    const harness = makeBridge();
    harness.requestResult.set(RequestMethod.NotificationsPost, { queued: true });
    let result: unknown;
    runApp(
      defineApp({
        async activate(ctx) {
          result = await ctx.notifications.post({ title: "完成", body: "导出已经完成" });
        },
      }),
      harness.bridge,
    );
    harness.send({ type: "activate", runtimeSessionId: "rt-notification" });
    await tick();

    expect(harness.requests).toContainEqual({
      method: RequestMethod.NotificationsPost,
      params: { title: "完成", body: "导出已经完成" },
    });
    expect(result).toEqual({ queued: true });
  });

  test("注册项如实上报给 Host", async () => {
    const harness = makeBridge();
    const app = defineApp({
      activate(ctx) {
        ctx.commands.register("cmd.a", async () => ({ ok: true }));
        ctx.commands.register("cmd.hold", async () => ({ ok: true }), { supportsOperations: true });
        ctx.surfaces.register("main", () => {});
      },
    });

    runApp(app, harness.bridge);
    harness.send({ type: "activate", runtimeSessionId: "rt-1" });
    await tick();

    const registered = harness.notifications.find((n) => n.method === NotifyMethod.Registered);
    // operationCommands 决定 Host 怎么派发按住类绑定：漏报会让新版插件退回两次普通调用，
    // 多报会让旧处理器收到它不认识的 operation 而被拒。
    expect(registered?.params).toEqual({
      runtimeSessionId: "rt-1",
      surfaces: ["main"],
      commands: ["cmd.a", "cmd.hold"],
      intents: [],
      services: [],
      operationCommands: ["cmd.hold"],
    });
  });

  test("activate 之外注册会被挡住", async () => {
    const harness = makeBridge();
    let escaped: AppContext | undefined;
    runApp(
      defineApp({
        activate(ctx) {
          escaped = ctx;
        },
      }),
      harness.bridge,
    );
    harness.send({ type: "activate", runtimeSessionId: "rt-1" });
    await tick();

    expect(() => escaped?.commands.register("late", () => undefined)).toThrow(
      /REGISTRATION_CLOSED/,
    );
  });

  test("重复注册同一个 id 会被挡住", async () => {
    const harness = makeBridge();
    runApp(
      defineApp({
        activate(ctx) {
          ctx.surfaces.register("main", () => {});
          ctx.surfaces.register("main", () => {});
        },
      }),
      harness.bridge,
    );
    harness.send({ type: "activate", runtimeSessionId: "rt-1" });
    await tick();

    const failure = harness.notifications.find((n) => n.method === NotifyMethod.ActivateFailed);
    expect(failure).toBeDefined();
    expect(harness.notifications.some((n) => n.method === NotifyMethod.Registered)).toBe(false);
  });

  test("activate 抛错时只报失败、不报注册", async () => {
    const harness = makeBridge();
    runApp(
      defineApp({
        activate() {
          throw new Error("起不来");
        },
      }),
      harness.bridge,
    );
    harness.send({ type: "activate", runtimeSessionId: "rt-1" });
    await tick();

    const failure = harness.notifications.find((n) => n.method === NotifyMethod.ActivateFailed);
    expect((failure?.params as { code: string }).code).toBe("app/UNHANDLED");
  });
});

describe("App Service", () => {
  test("Provider 精确注册并结算独立 service 信封", async () => {
    const harness = makeBridge();
    runApp(defineApp({
      activate(ctx) {
        ctx.services.provide<{ text: string }, { spoken: string }>(
          "example/tts@1",
          "synthesize",
          async ({ input }) => ({ spoken: input.text }),
        );
      },
    }), harness.bridge);
    harness.send({ type: "activate", runtimeSessionId: "rt-service" });
    await tick();
    expect(harness.notifications.find((item) => item.method === NotifyMethod.Registered)?.params)
      .toMatchObject({ services: ["example/tts@1#synthesize"] });

    harness.send({
      type: "service.invoke",
      correlationId: "service-correlation",
      serviceId: "example/tts@1",
      method: "synthesize",
      input: { text: "hello" },
    });
    await tick();
    expect(harness.notifications.find((item) =>
      item.method === NotifyMethod.ServiceSettled
      && (item.params as { correlationId?: string }).correlationId === "service-correlation"
    )?.params).toMatchObject({ ok: true, output: { spoken: "hello" } });
  });

  test("Consumer call 只编码 services.call，Abort 另发 cancel", async () => {
    const requests: Recorded[] = [];
    const handlers = new Set<(message: HostMessage) => void>();
    const bridge: HostBridge = {
      request(method, params) {
        requests.push({ method, params });
        if (method === RequestMethod.ServicesCancel) return Promise.resolve(undefined) as never;
        return new Promise(() => undefined) as never;
      },
      notify() {},
      subscribe(handler) { handlers.add(handler); return () => handlers.delete(handler); },
    };
    let context: AppContext | undefined;
    runApp(defineApp({ activate(ctx) { context = ctx; } }), bridge);
    for (const handler of handlers) handler({ type: "activate", runtimeSessionId: "rt-service-caller" });
    await tick();
    const controller = new AbortController();
    void context!.services.call("example/tts@1", "synthesize", { text: "hello" }, {
      signal: controller.signal,
    });
    expect(requests.find((item) => item.method === RequestMethod.ServicesCall)?.params)
      .toMatchObject({ serviceId: "example/tts@1", method: "synthesize", input: { text: "hello" } });
    controller.abort();
    await tick();
    expect(requests.map((item) => item.method)).toContain(RequestMethod.ServicesCancel);
  });

  test("Consumer 已取消的 signal 不会把调用送进 Host", async () => {
    const requests: Recorded[] = [];
    const handlers = new Set<(message: HostMessage) => void>();
    const bridge: HostBridge = {
      request(method, params) {
        requests.push({ method, params });
        return Promise.resolve(undefined) as never;
      },
      notify() {},
      subscribe(handler) { handlers.add(handler); return () => handlers.delete(handler); },
    };
    let context: AppContext | undefined;
    runApp(defineApp({ activate(ctx) { context = ctx; } }), bridge);
    for (const handler of handlers) handler({ type: "activate", runtimeSessionId: "rt-service-caller" });
    await tick();
    const controller = new AbortController();
    controller.abort();
    await expect(context!.services.call("example/tts@1", "synthesize", {}, {
      signal: controller.signal,
    })).rejects.toMatchObject({ code: "SERVICE_CANCELLED" });
    expect(requests).toEqual([]);
  });
});

describe("Command 调用", () => {
  const activateWith = async (handler: Parameters<AppContext["commands"]["register"]>[1], supportsOperations = false) => {
    const harness = makeBridge();
    runApp(
      defineApp({
        activate(ctx) {
          ctx.commands.register("cmd", handler, { supportsOperations });
        },
      }),
      harness.bridge,
    );
    harness.send({ type: "activate", runtimeSessionId: "rt-1" });
    await tick();
    return harness;
  };

  test("operation rejects legacy handler but ordinary command remains compatible", async () => {
    let calls = 0;
    const harness = await activateWith(() => ++calls);
    harness.send({ type: "command.invoke", correlationId: "op", commandId: "cmd", input: {}, timeoutMs: 5000, operation: { id: "capture-1", phase: "end" } });
    await tick();
    expect(calls).toBe(0);
    expect(harness.notifications.find(n => n.method === NotifyMethod.CommandSettled)?.params).toMatchObject({ ok: false, error: { code: "COMMAND_OPERATION_UNSUPPORTED" } });
    harness.send({ type: "command.invoke", correlationId: "ordinary", commandId: "cmd", input: {}, timeoutMs: 5000 });
    await tick();
    expect(calls).toBe(1);
  });

  test("opted-in command receives exact generic operation identity", async () => {
    const operations: unknown[] = [];
    const harness = await activateWith(({ operation }) => operations.push(operation), true);
    for (const phase of ["start", "end"] as const) {
      harness.send({ type: "command.invoke", correlationId: phase, commandId: "cmd", input: {}, timeoutMs: 5000, operation: { id: "capture-1", phase } });
      await tick();
    }
    expect(operations).toEqual([{ id: "capture-1", phase: "start" }, { id: "capture-1", phase: "end" }]);
  });

  test("settled operation start remains cancellable until paired end", async () => {
    let aborted = 0;
    const harness = await activateWith(({ signal }) => {
      signal.addEventListener("abort", () => aborted++);
      return { phase: "listening" };
    }, true);
    harness.send({ type: "command.invoke", correlationId: "start", commandId: "cmd", input: {}, timeoutMs: 5000, operation: { id: "op", phase: "start" } });
    await tick();
    harness.send({ type: "command.cancel", correlationId: "start" });
    await tick();
    expect(aborted).toBe(1);
    harness.send({ type: "command.cancel", correlationId: "start" });
    expect(aborted).toBe(1);
  });

  // 按下走配对、松开命令是旧处理器时，Host 发普通调用并带 completesOperation：
  // 按下保留的取消句柄要就此释放，之后迟到的取消不能再 abort 已完成的按下。
  test("plain release with completesOperation releases the retained start", async () => {
    const harness = makeBridge();
    let aborted = 0;
    const plainCalls: unknown[] = [];
    runApp(defineApp({
      activate(ctx) {
        ctx.commands.register("press", ({ signal }) => {
          signal.addEventListener("abort", () => aborted++);
          return { phase: "listening" };
        }, { supportsOperations: true });
        ctx.commands.register("release", (args) => {
          plainCalls.push("operation" in args ? args.operation : "plain");
          return { phase: "idle" };
        });
      },
    }), harness.bridge);
    harness.send({ type: "activate", runtimeSessionId: "rt-mixed" });
    await tick();
    harness.send({ type: "command.invoke", correlationId: "start", commandId: "press", input: {}, timeoutMs: 5000, operation: { id: "op", phase: "start" } });
    await tick();
    harness.send({ type: "command.invoke", correlationId: "end", commandId: "release", input: {}, timeoutMs: 5000, completesOperation: "op" });
    await tick();
    expect(plainCalls).toEqual(["plain"]);
    harness.send({ type: "command.cancel", correlationId: "start" });
    await tick();
    expect(aborted).toBe(0);
  });

  test("operation cancelled during activation never reaches handler", async () => {
    const harness = makeBridge();
    let release!: () => void;
    let calls = 0;
    runApp(defineApp({ async activate(ctx) {
      ctx.commands.register("cmd", () => ++calls, { supportsOperations: true });
      await new Promise<void>(resolve => { release = resolve; });
    } }), harness.bridge);
    harness.send({ type: "activate", runtimeSessionId: "rt-operation" });
    await tick();
    harness.send({ type: "command.invoke", correlationId: "queued-op", commandId: "cmd", input: {}, timeoutMs: 3000, operation: { id: "op", phase: "start" } });
    harness.send({ type: "command.cancel", correlationId: "queued-op" });
    release();
    await tick();
    expect(calls).toBe(0);
  });

  test("成功结果带回 correlationId", async () => {
    const harness = await activateWith(async () => ({ status: "ok" }));
    harness.send({
      type: "command.invoke",
      correlationId: "c1",
      commandId: "cmd",
      input: {},
      timeoutMs: 5000,
    });
    await tick();

    const settled = harness.notifications.find((n) => n.method === NotifyMethod.CommandSettled);
    expect(settled?.params).toEqual({ correlationId: "c1", ok: true, output: { status: "ok" } });
  });

  test("未注册的 Command 返回稳定错误码", async () => {
    const harness = await activateWith(async () => ({}));
    harness.send({
      type: "command.invoke",
      correlationId: "c9",
      commandId: "不存在",
      input: {},
      timeoutMs: 5000,
    });
    await tick();

    const settled = harness.notifications.find((n) => n.method === NotifyMethod.CommandSettled);
    expect((settled?.params as { error: { code: string } }).error.code).toBe(
      "MISSING_COMMAND_HANDLER",
    );
  });

  test("取消会触发处理器的 signal", async () => {
    let aborted = false;
    const harness = await activateWith(
      ({ signal }) =>
        new Promise((resolve) => {
          signal.addEventListener("abort", () => {
            aborted = true;
            resolve({});
          });
        }),
    );

    harness.send({
      type: "command.invoke",
      correlationId: "c2",
      commandId: "cmd",
      input: {},
      timeoutMs: 5000,
    });
    await tick();
    harness.send({ type: "command.cancel", correlationId: "c2" });
    await tick();

    expect(aborted).toBe(true);
  });
});

describe("Surface 挂载", () => {
  const mountApp = async (handler: Parameters<AppContext["surfaces"]["register"]>[1]) => {
    const harness = makeBridge();
    runApp(
      defineApp({
        activate(ctx) {
          ctx.surfaces.register("main", handler);
        },
      }),
      harness.bridge,
    );
    harness.send({ type: "activate", runtimeSessionId: "rt-1" });
    await tick();
    return harness;
  };

  test("紧随 activate 到达的 mount 会等待异步注册完成", async () => {
    const harness = makeBridge();
    let finishStartup!: () => void;
    const startupGate = new Promise<void>((resolve) => {
      finishStartup = resolve;
    });

    runApp(
      defineApp({
        async activate(ctx) {
          // Voice 的真实路径会先读设置与历史，再注册 Surface。
          await startupGate;
          ctx.surfaces.register("main", (surface) => surface.ready());
        },
      }),
      harness.bridge,
    );

    // Host 创建 WebView 后会连续投递这两条，不能要求插件恰好同步注册完。
    harness.send({ type: "activate", runtimeSessionId: "rt-voice" });
    harness.send({
      type: "surface.mount",
      surfaceMountId: "m-voice",
      surfaceId: "main",
      root: {},
    });
    await tick();

    expect(harness.notifications.some((n) => n.method === NotifyMethod.SurfaceFailed)).toBe(false);
    finishStartup();
    await tick();
    await tick();

    expect(
      harness.notifications.filter((n) => n.method === NotifyMethod.SurfaceReady),
    ).toHaveLength(1);
    expect(
      harness.notifications.filter((n) => n.method === NotifyMethod.SurfaceFailed),
    ).toHaveLength(0);
  });

  test("ready 只认第一次", async () => {
    const harness = await mountApp((surface) => {
      surface.ready();
      surface.ready();
      surface.fail(new Error("这条也应该被忽略"));
    });
    harness.send({
      type: "surface.mount",
      surfaceMountId: "m1",
      surfaceId: "main",
      root: {},
    });
    await tick();

    const readies = harness.notifications.filter((n) => n.method === NotifyMethod.SurfaceReady);
    const fails = harness.notifications.filter((n) => n.method === NotifyMethod.SurfaceFailed);
    expect(readies).toHaveLength(1);
    expect(fails).toHaveLength(0);
  });

  test("挂载处理器抛错等价于 fail", async () => {
    const harness = await mountApp(() => {
      throw new Error("界面炸了");
    });
    harness.send({
      type: "surface.mount",
      surfaceMountId: "m1",
      surfaceId: "main",
      root: {},
    });
    await tick();

    expect(
      harness.notifications.filter((n) => n.method === NotifyMethod.SurfaceFailed),
    ).toHaveLength(1);
  });

  test("初始意图与后续意图都能收到", async () => {
    const seen: unknown[] = [];
    const harness = await mountApp((surface) => {
      seen.push(surface.initialIntent);
      surface.onIntent((intent) => seen.push(intent));
      surface.ready();
    });

    harness.send({
      type: "surface.mount",
      surfaceMountId: "m1",
      surfaceId: "main",
      root: {},
      initialIntent: { type: "new-task" },
    });
    await tick();
    harness.send({ type: "surface.intent", surfaceMountId: "m1", intent: { type: "focus" } });
    await tick();

    expect(seen).toEqual([{ type: "new-task" }, { type: "focus" }]);
  });

  test("卸载会跑清理，之后意图不再到达", async () => {
    const cleanup = mock(() => {});
    const seen: unknown[] = [];
    const harness = await mountApp((surface) => {
      surface.onIntent((intent) => seen.push(intent));
      surface.ready();
      return cleanup;
    });

    harness.send({
      type: "surface.mount",
      surfaceMountId: "m1",
      surfaceId: "main",
      root: {},
    });
    await tick();
    harness.send({ type: "surface.unmount", surfaceMountId: "m1" });
    await tick();
    harness.send({ type: "surface.intent", surfaceMountId: "m1", intent: { type: "late" } });
    await tick();

    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([]);
  });

  test("未注册的 Surface 返回稳定错误码", async () => {
    const harness = await mountApp(() => {});
    harness.send({
      type: "surface.mount",
      surfaceMountId: "m2",
      surfaceId: "没注册过",
      root: {},
    });
    await tick();

    const failed = harness.notifications.find((n) => n.method === NotifyMethod.SurfaceFailed);
    expect((failed?.params as { error: { code: string } }).error.code).toBe(
      "MISSING_SURFACE_HANDLER",
    );
  });

  // ---- intent 缓冲（M6.1）：handler 注册前到达的 intent 不丢 ----

  test("注册前到达的 intent 在首个 onIntent 时补发，且只补最近一次", async () => {
    const seen: unknown[] = [];
    let register: ((h: (intent: unknown) => void) => void) | null = null;
    const harness = await mountApp(async (surface) => {
      // 故意推迟注册：模拟「存储往返 + 视图挂载」之后才调 onIntent 的真实时序。
      register = (h) => surface.onIntent(h);
      surface.ready();
    });

    harness.send({ type: "surface.mount", surfaceMountId: "m1", surfaceId: "main", root: {} });
    await tick();
    // handler 还没注册，连到两条：只该留最新那条（意图是状态不是流水）。
    harness.send({ type: "surface.intent", surfaceMountId: "m1", intent: { type: "stale" } });
    harness.send({ type: "surface.intent", surfaceMountId: "m1", intent: { type: "fresh" } });
    await tick();
    expect(seen).toEqual([]);

    register!((intent) => seen.push(intent));
    // 补发且只补最近一次
    expect(seen).toEqual([{ type: "fresh" }]);
  });

  test("补发时 handler 抛错不拆界面（与直达路径同语义）", async () => {
    // 与 Todo 同款时序：mount handler 里「存储往返（一个 tick）后才注册 onIntent」，
    // intent 赶在注册前到达 → 缓冲；注册触发补发 → handler 抛错。
    // 补发的抛必须被接住——否则它会传播进 mount handler 把整个 Surface 拆掉，
    // 而直达路径同样的抛只是一条日志。
    const harness = await mountApp(async (surface) => {
      await tick(); // 模拟存储往返
      surface.onIntent(() => {
        throw new Error("handler 炸了");
      });
      surface.ready();
    });
    harness.send({ type: "surface.mount", surfaceMountId: "m1", surfaceId: "main", root: {} });
    // mount handler 还在「往返」中（intentHandlers 为空），intent 先到 → 缓冲。
    harness.send({ type: "surface.intent", surfaceMountId: "m1", intent: { type: "x" } });
    await tick(); // 往返结束 → onIntent 注册 → 补发 → 抛（必须被接住）
    await tick();

    const readies = harness.notifications.filter((n) => n.method === NotifyMethod.SurfaceReady);
    const fails = harness.notifications.filter((n) => n.method === NotifyMethod.SurfaceFailed);
    expect(readies).toHaveLength(1);
    expect(fails).toHaveLength(0);
  });

  test("注册后到达的 intent 正常直达，不经缓冲", async () => {
    const seen: unknown[] = [];
    const harness = await mountApp((surface) => {
      surface.onIntent((intent) => seen.push(intent));
      surface.ready();
    });
    harness.send({ type: "surface.mount", surfaceMountId: "m1", surfaceId: "main", root: {} });
    await tick();
    harness.send({ type: "surface.intent", surfaceMountId: "m1", intent: { type: "a" } });
    harness.send({ type: "surface.intent", surfaceMountId: "m1", intent: { type: "b" } });
    await tick();
    // 直达不丢也不并
    expect(seen).toEqual([{ type: "a" }, { type: "b" }]);
  });

  test("卸载后缓冲随挂载清除，重新挂载不收到旧 intent", async () => {
    const seen: unknown[] = [];
    let mountCount = 0;
    const harness = makeBridge();
    runApp(
      defineApp({
        activate(ctx) {
          ctx.surfaces.register("main", async (surface) => {
            mountCount += 1;
            // 只有第二次挂载才注册 onIntent——第一次故意让 intent 无人接。
            if (mountCount === 2) {
              surface.onIntent((i) => seen.push(i));
            }
            surface.ready();
          });
        },
      }),
      harness.bridge,
    );
    harness.send({ type: "activate", runtimeSessionId: "rt-1" });
    await tick();

    // 第一次挂载：intent 无人接 → 缓冲；随后卸载。
    harness.send({ type: "surface.mount", surfaceMountId: "m1", surfaceId: "main", root: {} });
    await tick();
    harness.send({ type: "surface.intent", surfaceMountId: "m1", intent: { type: "old" } });
    harness.send({ type: "surface.unmount", surfaceMountId: "m1" });
    await tick();

    // 第二次挂载（新的 mount id）：旧缓冲绝不能跟过来。
    harness.send({ type: "surface.mount", surfaceMountId: "m2", surfaceId: "main", root: {} });
    await tick();
    expect(seen).toEqual([]);
  });
});

describe("桥接错误归一（M6.1）", () => {
  const mountForError = (rejection: unknown) => {
    const harness = makeBridge();
    // 让 surfaces.open 的 request 按给定形状拒绝（模拟 Host 的桥接拒绝）。
    harness.bridge.request = async (method, params) => {
      harness.requests.push({ method, params });
      throw rejection;
    };
    runApp(
      defineApp({
        activate(ctx) {
          ctx.commands.register("cmd.a", async () => {
            await ctx.surfaces.open("main");
            return { ok: true };
          });
          ctx.surfaces.register("main", () => {});
        },
      }),
      harness.bridge,
    );
    harness.send({ type: "activate", runtimeSessionId: "rt-1" });
    return harness;
  };

  test("{code,message} 归一为 {code,userMessage}——settle 报真实原因而非兜底", async () => {
    const harness = mountForError({ code: "HOST_CAPABILITY_NOT_AVAILABLE", message: "插件只能打开自己声明的主界面" });
    await tick();
    harness.send({
      type: "command.invoke",
      correlationId: "c1",
      commandId: "cmd.a",
      input: {},
      timeoutMs: 5000,
    });
    await tick();

    const settled = harness.notifications.find((n) => n.method === NotifyMethod.CommandSettled);
    const error = (settled?.params as { error: { code: string; userMessage: string } }).error;
    expect(error.code).toBe("HOST_CAPABILITY_NOT_AVAILABLE");
    expect(error.userMessage).toBe("插件只能打开自己声明的主界面");
  });

  test("已是 AppError 形状的透传不改", async () => {
    const harness = mountForError({
      code: "com.example.todo/CUSTOM",
      userMessage: "写得清清楚楚的错误",
      retryable: true,
    });
    await tick();
    harness.send({
      type: "command.invoke",
      correlationId: "c1",
      commandId: "cmd.a",
      input: {},
      timeoutMs: 5000,
    });
    await tick();

    const settled = harness.notifications.find((n) => n.method === NotifyMethod.CommandSettled);
    const error = (settled?.params as { error: { userMessage: string } }).error;
    expect(error.userMessage).toBe("写得清清楚楚的错误");
  });
});

describe("存储与跨 App 调用", () => {
  test("store 读写带上 storeId，命名空间由 Host 强制", async () => {
    const harness = makeBridge();
    harness.requestResult.set(RequestMethod.StorageGet, { found: true, value: ["a"] });
    runApp(
      defineApp({
        async activate(ctx) {
          const tasks = ctx.storage.private("tasks");
          await tasks.get("items");
          await tasks.set("items", [1]);
        },
      }),
      harness.bridge,
    );
    harness.send({ type: "activate", runtimeSessionId: "rt-1" });
    await tick();

    expect(harness.requests).toEqual([
      { method: RequestMethod.StorageGet, params: { storeId: "tasks", key: "items" } },
      { method: RequestMethod.StorageSet, params: { storeId: "tasks", key: "items", value: [1] } },
    ]);
  });

  test("store 区分不存在与显式 null", async () => {
    const harness = makeBridge();
    const observed: unknown[] = [];
    harness.requestResult.set(RequestMethod.StorageGet, { found: true, value: null });
    runApp(
      defineApp({
        async activate(ctx) {
          observed.push(await ctx.storage.private("tasks").get("nullable"));
        },
      }),
      harness.bridge,
    );
    harness.send({ type: "activate", runtimeSessionId: "rt-1" });
    await tick();
    expect(observed).toEqual([null]);

    harness.requestResult.set(RequestMethod.StorageGet, { found: false });
    const missing = await harness.bridge.request(RequestMethod.StorageGet, {
      storeId: "tasks",
      key: "missing",
    });
    expect(missing).toEqual({ found: false });
  });

  test("apps.open 走 Host，不直接碰别的 App", async () => {
    const harness = makeBridge();
    runApp(
      defineApp({
        async activate(ctx) {
          await ctx.apps.open({ appId: "com.example.other", intent: "share" }, { text: "x" });
        },
      }),
      harness.bridge,
    );
    harness.send({ type: "activate", runtimeSessionId: "rt-1" });
    await tick();

    expect(harness.requests[0]).toEqual({
      method: RequestMethod.AppsOpen,
      params: { appId: "com.example.other", intent: "share", input: { text: "x" } },
    });
  });
});

describe("Voice Input 能力窄口", () => {
  test("SDK 只把类型化操作映射到 voice.* Bridge 请求", async () => {
    const harness = makeBridge();
    harness.requestResult.set(RequestMethod.VoiceStatus, {
      phase: "idle",
      source: "board",
      modelId: "sensevoice-small-int8",
      sourceReady: true,
    });
    harness.requestResult.set(RequestMethod.VoiceToggle, { phase: "listening" });
    harness.requestResult.set(RequestMethod.VoiceAcknowledgeResult, { acknowledged: true });
    harness.requestResult.set(RequestMethod.VoiceReportStage, { accepted: true });
    harness.requestResult.set(RequestMethod.VoiceModelsList, { models: [] });
    harness.requestResult.set(RequestMethod.VoicePermissionRequest, { state: "granted" });
    harness.requestResult.set(RequestMethod.VoiceRecoverableInputSessionsList, {
      items: [], total: 0, page: 0, perPage: 50,
    });
    harness.requestResult.set(RequestMethod.VoiceInputSessionTranscribe, { transcript: "补回文字" });

    let escaped: AppContext | undefined;
    runApp(
      defineApp({
        activate(ctx) {
          escaped = ctx;
        },
      }),
      harness.bridge,
    );
    harness.send({ type: "activate", runtimeSessionId: "rt-voice" });
    await tick();

    await escaped?.voiceInput.getStatus();
    await escaped?.voiceInput.getStatus("");
    await escaped?.voiceInput.getStatus("voice-session-async-stop");
    await escaped?.voiceInput.configure({
      source: "system",
      modelId: "sensevoice-small-int8",
      language: "zh-CN",
      vadEnabled: true,
      punctEnabled: true,
      engine: "local",
      polish: "raw",
      polishContext: { window: false, recentVoice: true, recentVoiceRangeMinutes: 5 },
    });
    await escaped?.voiceInput.toggle();
    await escaped?.voiceInput.toggle({ mode: "input", insertText: false, holdOverlayUntilAck: true });
    await escaped?.voiceInput.acknowledgeResult("voice-session-1");
    await escaped?.voiceInput.reportStage("voice-session-1", "polishing");
    await escaped?.voiceInput.listModels();
    await escaped?.voiceInput.requestPermission("microphone");
    await escaped?.voiceInput.cancel("");
    await escaped?.voiceInput.cancel("voice-session-1");
    await escaped?.voiceRecordings.listRecoverableInputSessions();
    await escaped?.voiceRecordings.transcribeInputSession("recording-1");
    await escaped?.voiceRecordings.setInputSessionTranscription(
      "recording-2",
      "complete",
      "云端文字",
    );

    expect(harness.requests).toEqual([
      { method: RequestMethod.VoiceStatus, params: {} },
      { method: RequestMethod.VoiceStatus, params: { sessionId: "" } },
      {
        method: RequestMethod.VoiceStatus,
        params: { sessionId: "voice-session-async-stop" },
      },
      {
        method: RequestMethod.VoiceConfigure,
        params: {
          source: "system",
          modelId: "sensevoice-small-int8",
          language: "zh-CN",
          vadEnabled: true,
          punctEnabled: true,
          engine: "local",
          // 纯插件侧字段（Host 的 voice.configure 不认识它们，也不需要认识）
          // 照样原样透传：SDK 这一层不做字段挑拣，挑拣会让插件加一个设置就要改 SDK。
          polish: "raw",
          polishContext: { window: false, recentVoice: true, recentVoiceRangeMinutes: 5 },
        },
      },
      { method: RequestMethod.VoiceToggle, params: { mode: "input" } },
      {
        method: RequestMethod.VoiceToggle,
        params: { mode: "input", insertText: false, holdOverlayUntilAck: true },
      },
      {
        method: RequestMethod.VoiceAcknowledgeResult,
        params: { sessionId: "voice-session-1" },
      },
      {
        method: RequestMethod.VoiceReportStage,
        params: { sessionId: "voice-session-1", stage: "polishing" },
      },
      { method: RequestMethod.VoiceModelsList, params: {} },
      { method: RequestMethod.VoicePermissionRequest, params: { kind: "microphone" } },
      { method: RequestMethod.VoiceCancel, params: { sessionId: "" } },
      { method: RequestMethod.VoiceCancel, params: { sessionId: "voice-session-1" } },
      {
        method: RequestMethod.VoiceRecoverableInputSessionsList,
        params: { page: 0, perPage: 50 },
      },
      {
        method: RequestMethod.VoiceInputSessionTranscribe,
        params: { recordingId: "recording-1" },
      },
      {
        method: RequestMethod.VoiceInputSessionSetTranscription,
        params: { recordingId: "recording-2", status: "complete", transcript: "云端文字" },
      },
    ]);
  });
});

test("saved input ASR uses typed IDs and revisions without audio bytes or injection", async () => {
  const harness = makeBridge();
  let context!: AppContext;
  const runtime = runApp(defineApp({ activate(ctx) { context = ctx; } }), harness.bridge);
  harness.send({ type: "activate", runtimeSessionId: "saved-asr" });
  await tick();
  const request = {
    recordingId: "recording-1", attemptId: "11111111-1111-4111-8111-111111111111", expectedRevision: 2,
    selection: { engine: "local" as const, modelId: "sensevoice-small-int8", modelName: "SenseVoice Small", language: "auto", punctEnabled: true },
  };
  await context.voiceRecordings.getInputSession(request.recordingId);
  await context.voiceRecordings.transcribeSavedInput(request);
  await context.voiceRecordings.cancelSavedInput({ recordingId: request.recordingId, attemptId: request.attemptId });
  await context.voiceRecordings.listRecoverableInputSessions({ includeSettledRetries: true });
  expect(harness.requests).toEqual([
    { method: "voice.recordings.get-input-session", params: { recordingId: request.recordingId } },
    { method: "voice.recordings.transcribe-saved-input", params: request },
    { method: "voice.recordings.cancel-saved-input", params: { recordingId: request.recordingId, attemptId: request.attemptId } },
    { method: "voice.recordings.input-sessions", params: { page: 0, perPage: 50, includeSettledRetries: true } },
  ]);
  await runtime.dispose();
});

describe("Audio8 本地 TTS 窄口", () => {
  test("SDK 只编码固定 tts.local.* 方法且麦克风授权返回状态值", async () => {
    const harness = makeBridge();
    harness.requestResult.set(RequestMethod.TtsLocalMicrophoneRequest, { state: "granted" });
    let context: AppContext | undefined;
    runApp(defineApp({ activate(ctx) { context = ctx; } }), harness.bridge);
    harness.send({ type: "activate", runtimeSessionId: "rt-local-tts" });
    await tick();

    await context!.localTts.getStatus();
    expect(await context!.localTts.requestMicrophonePermission()).toBe("granted");
    await context!.localTts.startRecording();
    await context!.localTts.stopRecording();
    await context!.localTts.cancelRecording();
    await context!.localTts.authorizeSamplePlayback("sample-1");
    await context!.localTts.prepareRecognition();
    await context!.localTts.confirmRecognition("sample-1", "样本文本");
    await context!.localTts.downloadModel("audio8-0.6b-int4");
    await context!.localTts.cancelModelDownload("audio8-0.6b-int4");
    await context!.localTts.deleteModel("audio8-0.1b-int8");
    await context!.localTts.registerVoice({
      modelId: "audio8-0.6b-int4",
      sampleId: "sample-1",
      name: "我的声音",
      transcript: "样本文本",
    });
    await context!.localTts.deleteVoice("audio8-0.6b-int4", "voice-1");
    await context!.localTts.getDefaultVoice();
    await context!.localTts.setDefaultVoice({ modelId: "audio8-0.6b-int4", voiceId: "voice-1" });
    await context!.localTts.synthesize({
      modelId: "audio8-0.6b-int4",
      voiceId: "voice-1",
      text: "测试语音",
    });
    await context!.localTts.cancel();

    expect(harness.requests).toEqual([
      { method: RequestMethod.TtsLocalStatus, params: {} },
      { method: RequestMethod.TtsLocalMicrophoneRequest, params: {} },
      { method: RequestMethod.TtsLocalRecordingStart, params: {} },
      { method: RequestMethod.TtsLocalRecordingStop, params: {} },
      { method: RequestMethod.TtsLocalRecordingCancel, params: {} },
      { method: RequestMethod.TtsLocalRecordingPlaybackAuthorize, params: { sampleId: "sample-1" } },
      { method: RequestMethod.TtsLocalRecognitionPrepare, params: {} },
      { method: RequestMethod.TtsLocalRecognitionConfirm, params: { sampleId: "sample-1", transcript: "样本文本" } },
      { method: RequestMethod.TtsLocalModelDownload, params: { modelId: "audio8-0.6b-int4" } },
      { method: RequestMethod.TtsLocalModelCancelDownload, params: { modelId: "audio8-0.6b-int4" } },
      { method: RequestMethod.TtsLocalModelDelete, params: { modelId: "audio8-0.1b-int8" } },
      {
        method: RequestMethod.TtsLocalVoiceRegister,
        params: { modelId: "audio8-0.6b-int4", sampleId: "sample-1", name: "我的声音", transcript: "样本文本" },
      },
      { method: RequestMethod.TtsLocalVoiceDelete, params: { modelId: "audio8-0.6b-int4", voiceId: "voice-1" } },
      { method: RequestMethod.TtsLocalDefaultGet, params: {} },
      { method: RequestMethod.TtsLocalDefaultSet, params: { modelId: "audio8-0.6b-int4", voiceId: "voice-1" } },
      { method: RequestMethod.TtsLocalSynthesize, params: { modelId: "audio8-0.6b-int4", voiceId: "voice-1", text: "测试语音" } },
      { method: RequestMethod.TtsLocalCancel, params: {} },
    ]);
  });
});

describe("Bridge 缺失", () => {
  test("不是由 Host bootstrap 加载时给出可读的错误", () => {
    expect(() => runApp(defineApp({ activate() {} }))).toThrow(/BRIDGE_MISSING/);
  });
});

test("layer invalidation rejects stale sessions and mounts, separates handlers, and disposes", async () => {
  const harness = makeBridge();
  const observed: string[] = [];
  let context!: AppContext;
  let stop!: () => void;
  const runtime = runApp(defineApp({ activate(ctx) {
    context = ctx;
    ctx.surfaces.register("main", () => {});
    stop = ctx.actionItems.onChange(() => observed.push("action"));
    ctx.tabItems.onChange(() => observed.push("tab"));
  } }), harness.bridge);
  harness.send({ type: "activate", runtimeSessionId: "rt-layer" });
  harness.send({ type: "surface.mount", surfaceMountId: "mount-layer", surfaceId: "main", root: {} });
  await tick();
  const message = { type: "layers.changed", version: 1, layer: "action", runtimeSessionId: "rt-layer", surfaceMountId: "mount-layer" } as const;
  harness.send({ ...message, runtimeSessionId: "old" });
  harness.send({ ...message, surfaceMountId: "old" });
  expect(observed).toEqual([]);
  harness.send(message);
  harness.send({ ...message, layer: "tab" });
  expect(observed).toEqual(["action", "tab"]);
  harness.requestResult.set(RequestMethod.TabItemsList, { items: [], visible: false });
  expect(await context.tabItems.isVisible()).toBe(false);
  stop();
  harness.send(message);
  harness.send({ type: "surface.unmount", surfaceMountId: "mount-layer" });
  harness.send({ ...message, layer: "tab" });
  expect(observed).toEqual(["action", "tab"]);
  await runtime.dispose();
});

test("CAS preserves missing versus null and returns Host conflict", async () => {
  const harness = makeBridge(); let context: AppContext | undefined;
  runApp(defineApp({ activate(ctx) { context = ctx; } }), harness.bridge);
  harness.send({ type: "activate", runtimeSessionId: "rt-cas" }); await tick();
  harness.requestResult.set("storage.compareAndSet", { exchanged: false });
  expect(await context!.storage.private("tasks").compareAndSet("state", undefined, { revision: 1 })).toBe(false);
  expect(harness.requests.at(-1)?.params).toEqual({ storeId: "tasks", key: "state", expected: { found: false }, value: { revision: 1 } });
  harness.requestResult.set("storage.compareAndSet", { exchanged: true });
  expect(await context!.storage.private("tasks").compareAndSet("state", null, { revision: 2 })).toBe(true);
  expect(harness.requests.at(-1)?.params).toEqual({ storeId: "tasks", key: "state", expected: { found: true, value: null }, value: { revision: 2 } });
});

test("gateway delegates only a scope and lists/revokes handles through Host", async () => {
  const h = makeBridge(); let ctx!: AppContext;
  const runtime = runApp(defineApp({ activate(context) { ctx = context; } }), h.bridge);
  h.send({ type: "activate", runtimeSessionId: "gateway" }); await tick();
  const scope = { serviceId: "com.example.tasks/agent@1", methods: ["invoke"], principal: { agentId: "W-1" } };
  h.requestResult.set("gateway.issue", { id: "issued", endpoint: "http://127.0.0.1:4321/v1/call", token: "fixture" });
  expect((await ctx.gateway.issue(scope)).id).toBe("issued");
  expect(h.requests.at(-1)?.params).toEqual(scope);
  h.requestResult.set("gateway.list", [{ id: "issued", serviceId: scope.serviceId, principal: scope.principal }]);
  expect(await ctx.gateway.list()).toHaveLength(1);
  await ctx.gateway.revoke("issued");
  expect(h.requests.at(-1)?.params).toEqual({ id: "issued" });
  await runtime.dispose();
});
