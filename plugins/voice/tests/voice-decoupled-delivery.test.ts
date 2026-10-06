/**
 * Voice 链路解耦 PR4（plans/2026-09-27-voice-pipeline-decoupling.md）的插件侧行为合同：
 * 识别只出文本，写回只由业务分支决定——输入法与翻译写回光标处，Agent 永不写回、一律弹
 * 只读结果框（含转入后台后才完成的迟到结果框），失败只弹一张 Host 取回卡。
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { MockHost } from "@reai/app-test/v1";
import type { AppContext, VoiceInputSettings } from "@reai/app-sdk/v1";
import manifest from "../app.manifest.json";
import {
  COMMAND_HISTORY_KEY,
  DEFAULT_SETTINGS,
  DEFAULT_VOICE_FEATURE_SETTINGS,
  POLISH_LIGHT_DEFAULT_MIGRATION_KEY,
  type VoiceCommandHistoryItem,
  type VoiceHistoryItem,
} from "../src/data";
import { setVoiceLocale } from "../src/voice-i18n";

let ownsDom = false;
beforeAll(() => {
  if (typeof document === "undefined") { GlobalRegistrator.register(); ownsDom = true; }
  setVoiceLocale("zh");
});
afterAll(() => { if (ownsDom) GlobalRegistrator.unregister(); });

async function until(check: () => boolean, message: string, timeoutMs = 2500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  expect(check(), message).toBeTrue();
}
const settle = () => new Promise(resolve => setTimeout(resolve, 40));

type Wire = { handleRequest(method: string, params: Record<string, unknown>): Promise<unknown> };
interface Harness {
  host: MockHost;
  context: () => AppContext;
  commits: () => Array<{ targetId?: string; text?: string }>;
  takebacks: () => Array<{ title?: string; reason?: string; text?: string; errorCode?: string }>;
  answers: () => Array<Record<string, unknown>>;
  tasks: () => Array<{ taskId?: string; state?: string }>;
  generates: () => number;
  /** 在真实 SDK → MockHost 线路上改写某个方法的返回（其余请求照常）。 */
  intercept: (method: string, respond: (result: unknown, params: Record<string, unknown>) => unknown) => void;
  /** 请求到达 MockHost **之前**先压一段延迟（模拟 Host 受理慢），返回 0 表示不延迟。 */
  delayBefore: (method: string, ms: (params: Record<string, unknown>) => number) => void;
  dispose: () => Promise<void>;
}

async function harness(options: {
  settings?: Partial<VoiceInputSettings>;
  hook?: (ctx: AppContext) => Promise<void> | void;
} = {}): Promise<Harness> {
  document.body.replaceChildren();
  let context: AppContext | undefined;
  const host = new MockHost({
    manifest: structuredClone(manifest) as never,
    loadApp: async () => {
      const { default: app } = await import(`../src/app?decoupled=${crypto.randomUUID()}`);
      return { default: { ...app, async activate(ctx: AppContext) {
        context = ctx;
        const store = ctx.storage.private("voice-state");
        await store.set("recognition-engine-choice-v1", options.settings?.engine ?? "local");
        await store.set("settings", { ...DEFAULT_SETTINGS, ...options.settings });
        await store.set(POLISH_LIGHT_DEFAULT_MIGRATION_KEY, 1);
        // MockHost 的 Agent 默认回中文：翻译目标设成简体中文，否则会被译文校验判成「不是目标语言」。
        await store.set("voice-feature-settings-v1", { ...DEFAULT_VOICE_FEATURE_SETTINGS, cloudModelId: "transcribe-free", translationTarget: "zh-CN" });
        await options.hook?.(ctx);
        return app.activate(ctx);
      } } };
    },
    createRoot: () => { const root = document.createElement("div"); document.body.append(root); return root; },
  });
  const wire = host as unknown as Wire;
  const original = wire.handleRequest.bind(host);
  const rewrites = new Map<string, (result: unknown, params: Record<string, unknown>) => unknown>();
  const delays = new Map<string, (params: Record<string, unknown>) => number>();
  wire.handleRequest = async (method, params) => {
    const delayMs = delays.get(method)?.(params) ?? 0;
    if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
    const result = await original(method, params);
    const rewrite = rewrites.get(method);
    return rewrite ? rewrite(result, params) : result;
  };
  await host.installAndEnable();
  const cloud = (method: string) => host.cloudRequests.filter(request => request.method === method);
  const command = (method: string) => host.voiceCommandRequests.filter(request => request.method === method);
  return {
    host,
    context: () => context!,
    commits: () => cloud("voice.deliver.commit").map(request => request.params as { targetId?: string; text?: string }),
    takebacks: () => cloud("voice.deliver.present-takeback").map(request => request.params as { title?: string; reason?: string; text?: string; errorCode?: string }),
    answers: () => command("voice.command.present-answer").map(request => request.params as Record<string, unknown>),
    tasks: () => command("voice.command.present-task").map(request => request.params as { taskId?: string; state?: string }),
    generates: () => cloud("ai.text.generate").length,
    intercept: (method, respond) => { rewrites.set(method, respond); },
    delayBefore: (method, ms) => { delays.set(method, ms); },
    dispose: async () => {
      try { await host.disable(); } finally { wire.handleRequest = original; }
    },
  };
}

async function runCommand(h: Harness, eventId: string): Promise<string> {
  const started = await h.host.invokeCommand(eventId);
  expect(started.ok).toBeTrue();
  const sessionId = (started.ok ? started.output as { sessionId?: string } : undefined)?.sessionId;
  expect(sessionId).toBeString();
  expect((await h.host.invokeCommand(eventId)).ok).toBeTrue();
  return sessionId!;
}

async function commandHistory(h: Harness): Promise<VoiceCommandHistoryItem[]> {
  return await h.context().storage.private("voice-state").get<VoiceCommandHistoryItem[]>(COMMAND_HISTORY_KEY) ?? [];
}

async function inputHistory(h: Harness): Promise<VoiceHistoryItem[]> {
  return await h.context().storage.private("voice-state").get<VoiceHistoryItem[]>("history") ?? [];
}

test("翻译成功：写回光标处恰好一次，不弹结果框也不弹卡，并确认原录音会话收掉中央胶囊", async () => {
  const h = await harness();
  try {
    const sessionId = await runCommand(h, "com.reai.voice.command.translate");
    await until(() => h.commits().length === 1, "翻译完成后写回一次");
    expect(h.commits()[0]!.text).toBe("这是测试 Agent 回复");
    const acknowledged = () => h.host.voiceInputRequests
      .filter(request => request.method === "voice.acknowledge-result")
      .map(request => (request.params as { sessionId?: string }).sessionId);
    await until(() => acknowledged().includes(sessionId), "3 秒内完成的翻译要确认原录音会话，收掉中央胶囊");
    await settle();
    expect(h.commits()).toHaveLength(1);
    expect(h.answers()).toHaveLength(0);
    expect(h.takebacks()).toHaveLength(0);
    expect(h.tasks()).toHaveLength(0);
    const [item] = await commandHistory(h);
    expect(item).toMatchObject({ commandId: "voice.command.translate", status: "completed", reply: "这是测试 Agent 回复" });
  } finally { await h.dispose(); }
});

test("翻译本身失败：不写原文，取回卡标题「翻译失败」、内容为原文，不弹失败结果框", async () => {
  const h = await harness();
  try {
    h.host.rejectNextAgentSend({ kind: "engine", stderr_tail: "上游错误原文（测试注入）" });
    await runCommand(h, "com.reai.voice.command.translate");
    await until(() => h.takebacks().length === 1, "翻译失败弹一张取回卡");
    const [card] = h.takebacks();
    expect(card!.title).toBe("翻译失败");
    expect(card!.text).toBe("测试语音命令");
    expect(card!.reason).toBe("暂时无法完成翻译。你的内容已保存，请稍后重试。");
    await settle();
    expect(h.commits()).toHaveLength(0);
    expect(h.answers()).toHaveLength(0);
    const [item] = await commandHistory(h);
    expect(item).toMatchObject({ commandId: "voice.command.translate", status: "failed", transcript: "测试语音命令" });
  } finally { await h.dispose(); }
});

// 翻译目标改成英文（VM 实测场景：TextEdit + 目标英文）。
const englishTarget = async (ctx: AppContext) => {
  await ctx.storage.private("voice-state").set("voice-feature-settings-v1", {
    ...DEFAULT_VOICE_FEATURE_SETTINGS, cloudModelId: "transcribe-free", translationTarget: "en-US",
  });
};
const agentCall = (h: Harness, method: string) => h.host.agentRequests
  .filter(request => request.method === method)
  .map(request => request.params as Record<string, unknown>);

test("翻译请求：一次性会话人设是只输出译文的翻译规则，回合正文是明确指令 + 随机标记包住的原文", async () => {
  const h = await harness({ hook: englishTarget });
  try {
    h.host.setNextAgentSendText("Test voice command");
    await runCommand(h, "com.reai.voice.command.translate");
    await until(() => h.commits().length === 1, "正常译文照常写回");
    const [created] = agentCall(h, "agent.v2.session.create");
    const config = created!.config as Record<string, unknown>;
    expect(config).toMatchObject({ memory: "one-shot", tools: [], skills: [] });
    const systemPrompt = String(config.systemPrompt);
    expect(systemPrompt).toContain("你是实时语音翻译器");
    expect(systemPrompt).toContain("Target language: English.");
    expect(systemPrompt).toContain("not a chat assistant");
    const [turn] = agentCall(h, "agent.v2.turn.start");
    const text = String(turn!.text);
    const markers = /^Translate the source text between (<<<SOURCE-([0-9a-f]{12})>>>) and (<<<END-SOURCE-\2>>>) into English\..*Output only the English translation\.\n\1\n([\s\S]*)\n\3$/.exec(text);
    expect(markers, text).not.toBeNull();
    expect(markers![4]).toBe("测试语音命令");
  } finally { await h.dispose(); }
});

test("翻译结果是聊天回复（VM 实测原样）：不写入，弹「翻译失败」取回卡带 TRANSLATION_CHAT_REPLY，内容是原话", async () => {
  const h = await harness({ hook: englishTarget });
  try {
    h.host.setNextAgentSendText("I'd love to go for a walk in the park with you! However, I'm an AI assistant, so I can't physically join you.");
    await runCommand(h, "com.reai.voice.command.translate");
    await until(() => h.takebacks().length === 1, "不是译文按翻译失败弹取回卡");
    const [card] = h.takebacks();
    expect(card!.title).toBe("翻译失败");
    expect(card!.text).toBe("测试语音命令");
    expect(card!.reason).toBe("翻译服务回了一段对话，而不是译文，所以没有写入。你的内容已保存，请重试。");
    expect(card!.errorCode).toBe("TRANSLATION_CHAT_REPLY");
    await settle();
    expect(h.commits()).toHaveLength(0);
    expect(h.answers()).toHaveLength(0);
    const [item] = await commandHistory(h);
    expect(item).toMatchObject({ commandId: "voice.command.translate", status: "failed", transcript: "测试语音命令" });
  } finally { await h.dispose(); }
});

test("翻译结果不是目标语言（原话原样交回）：不写入，弹「翻译失败」取回卡带 TRANSLATION_WRONG_LANGUAGE", async () => {
  const h = await harness({ hook: englishTarget });
  try {
    h.host.setNextAgentSendText("测试语音命令");
    await runCommand(h, "com.reai.voice.command.translate");
    await until(() => h.takebacks().length === 1, "不是目标语言按翻译失败弹取回卡");
    const [card] = h.takebacks();
    expect(card!.title).toBe("翻译失败");
    expect(card!.text).toBe("测试语音命令");
    expect(card!.errorCode).toBe("TRANSLATION_WRONG_LANGUAGE");
    expect(card!.reason).toContain("翻译结果不是目标语言");
    await settle();
    expect(h.commits()).toHaveLength(0);
  } finally { await h.dispose(); }
});

test("翻译写回失败：取回卡内容为译文，原因用新失败原因的文案", async () => {
  const h = await harness();
  try {
    h.intercept("voice.deliver.commit", () => ({ committed: false, reason: "not_received" }));
    await runCommand(h, "com.reai.voice.command.translate");
    await until(() => h.takebacks().length === 1, "写回失败弹一张取回卡");
    expect(h.takebacks()[0]).toEqual({
      // 卡里是译文：标题标明「翻译好了」，且不得出现任何「已写入」类成功字样。
      title: "翻译好了，但没能写入",
      reason: "目标应用没有接收文字",
      text: "这是测试 Agent 回复",
      // Host API 1.22（#953）：结构化错误码另给一份；原始原因不传。
      errorCode: "not_received",
    });
    await settle();
    expect(h.commits()).toHaveLength(1);
    expect(h.answers()).toHaveLength(0);
  } finally { await h.dispose(); }
});

test("翻译成功但 Host 事前判断确定不可输入（not_editable）：不算写入，弹取回卡（译文 + 真实原因与码）", async () => {
  const h = await harness();
  try {
    // Host 在 commit 内做事前判断：确定不可输入时不粘贴、直接回 not_editable（拿不准照常粘贴，
    // 由取件回执兜底——那是 Host 的 insert_policy 合同，这里只看插件如何呈现这份回执）。
    h.intercept("voice.deliver.commit", () => ({ committed: false, reason: "not_editable" }));
    await runCommand(h, "com.reai.voice.command.translate");
    await until(() => h.takebacks().length === 1, "确定不可输入时弹一张取回卡");
    expect(h.takebacks()[0]).toEqual({
      title: "翻译好了，但没能写入",
      reason: "光标不在可输入的位置",
      text: "这是测试 Agent 回复",
      errorCode: "not_editable",
    });
    await settle();
    expect(h.commits()).toHaveLength(1);
    expect(h.answers()).toHaveLength(0);
    for (const card of h.takebacks()) expect(`${card.title}${card.reason}`).not.toContain("已写入");
    const [item] = await commandHistory(h);
    expect(item).toMatchObject({ commandId: "voice.command.translate", status: "completed", reply: "这是测试 Agent 回复" });
  } finally { await h.dispose(); }
});

test("翻译成功但没有写入目标（no_input_target）：不调用写回，弹取回卡（译文 + 真实原因与码）", async () => {
  const h = await harness();
  try {
    // Host 没给写回目标：插件不做任何写入尝试，直接把译文交给取回卡。
    h.intercept("voice.toggle", (result) => {
      const { deliveryTarget: _dropped, ...rest } = result as Record<string, unknown>;
      return rest;
    });
    await runCommand(h, "com.reai.voice.command.translate");
    await until(() => h.takebacks().length === 1, "没有写入目标时弹一张取回卡");
    expect(h.takebacks()[0]).toEqual({
      title: "翻译好了，但没能写入",
      reason: "没有可写入的位置",
      text: "这是测试 Agent 回复",
      errorCode: "no_input_target",
    });
    await settle();
    expect(h.commits()).toHaveLength(0);
    expect(h.answers()).toHaveLength(0);
  } finally { await h.dispose(); }
});

/** Host 对 `voice.deliver.*` 共用一道权限门：写回权限被拒时，commit 与取回卡被同一个码拒绝。 */
const rejectWith = (code: string) => () => { throw Object.assign(new Error(`${code}（测试注入）`), { code }); };

test("写回权限被拒（commit 与取回卡都被拒）：改弹失败结果面板——译文、原因与真实码，不含「已写入」", async () => {
  const h = await harness();
  try {
    h.intercept("voice.deliver.commit", rejectWith("VOICE_DELIVER_PERMISSION_DENIED"));
    h.intercept("voice.deliver.present-takeback", rejectWith("VOICE_DELIVER_PERMISSION_DENIED"));
    await runCommand(h, "com.reai.voice.command.translate");
    await until(() => h.answers().length === 1, "取回卡被拒时必须改弹失败结果面板");
    await settle();
    expect(h.commits()).toHaveLength(1);
    expect(h.takebacks()).toHaveLength(1);
    const [answer] = h.answers();
    expect(answer).toMatchObject({
      title: "翻译好了，但没能写入",
      status: "failed",
      text: "这是测试 Agent 回复",
      originalText: "测试语音命令",
      errorCode: "VOICE_DELIVER_PERMISSION_DENIED",
      canCopy: true,
    });
    expect(answer!.deferred).toBeUndefined();
    expect(answer!.sections).toEqual([
      { label: "原文", text: "测试语音命令" },
      { label: "翻译结果", text: "这是测试 Agent 回复" },
      { label: "错误", text: h.takebacks()[0]!.reason },
    ]);
    expect(h.takebacks()[0]!.reason).not.toContain(h.takebacks()[0]!.errorCode!);
    expect(JSON.stringify(answer)).not.toContain("已写入");
  } finally { await h.dispose(); }
});

test("写回抛出登记过的真实码：取回卡原因与 errorCode 保留原码，不抹成 insert_failed", async () => {
  const h = await harness();
  try {
    h.intercept("voice.deliver.commit", rejectWith("VOICE_DELIVER_INVALID_REQUEST"));
    await runCommand(h, "com.reai.voice.command.translate");
    await until(() => h.takebacks().length === 1, "写回异常弹一张取回卡");
    const [card] = h.takebacks();
    expect(card!.errorCode).toBe("VOICE_DELIVER_INVALID_REQUEST");
    expect(card!.reason).not.toContain(card!.errorCode!);
    expect(card!.reason).not.toContain("insert_failed");
    await settle();
    expect(h.answers()).toHaveLength(0);
  } finally { await h.dispose(); }
});

test("等取回卡回执期间用户按了停止：取回卡被拒后不再弹兜底面板，也不记成完成", async () => {
  const h = await harness();
  let releaseTakeback!: () => void;
  const takebackHeld = new Promise<void>(resolve => { releaseTakeback = resolve; });
  try {
    h.intercept("voice.deliver.commit", () => ({ committed: false, reason: "not_received" }));
    h.intercept("voice.deliver.present-takeback", async () => {
      await takebackHeld;
      throw Object.assign(new Error("VOICE_DELIVER_PERMISSION_DENIED（测试注入）"), { code: "VOICE_DELIVER_PERMISSION_DENIED" });
    });
    await runCommand(h, "com.reai.voice.command.translate");
    await until(() => h.takebacks().length === 1, "写回失败后请求取回卡");
    const surface = await h.host.openSurface("main");
    const root = surface.root!;
    root.querySelector<HTMLButtonElement>('[data-voice-tab="command"]')!.click();
    await until(() => !!root.querySelector(".command-history-item"), "命令历史里有这条运行中的翻译");
    root.querySelector<HTMLButtonElement>(".command-history-item")!.click();
    await until(() => !!root.querySelector(".chat-cancel"), "运行中的翻译有「停止翻译」");
    root.querySelector<HTMLButtonElement>(".chat-cancel")!.click();
    await settle();
    releaseTakeback();
    await until(() => h.commits().length === 1 && root.querySelector(".chat-cancel") === null, "停止收尾完成");
    await settle();
    expect(h.answers()).toHaveLength(0);
    const [item] = await commandHistory(h);
    expect(item!.status).not.toBe("completed");
  } finally {
    releaseTakeback();
    await h.dispose();
  }
});

for (const route of ["写回失败", "翻译本身失败"] as const) {
  test(`${route}、取回卡被拒后落历史期间用户按了停止：不再弹兜底面板`, async () => {
    const h = await harness();
    let releaseTakeback!: () => void;
    const takebackHeld = new Promise<void>(resolve => { releaseTakeback = resolve; });
    let releaseStorage!: () => void;
    const storageHeld = new Promise<void>(resolve => { releaseStorage = resolve; });
    let storageArmed = false;
    let storageBlocked = false;
    try {
      if (route === "写回失败") h.intercept("voice.deliver.commit", () => ({ committed: false, reason: "not_received" }));
      else h.host.rejectNextAgentSend({ kind: "engine", stderr_tail: "上游错误原文（测试注入）" });
      h.intercept("voice.deliver.present-takeback", async () => {
        await takebackHeld;
        storageArmed = true; // 取回卡被拒之后的下一次存储读写（落历史）被拖住
        throw Object.assign(new Error("VOICE_DELIVER_PERMISSION_DENIED（测试注入）"), { code: "VOICE_DELIVER_PERMISSION_DENIED" });
      });
      for (const method of ["storage.get", "storage.compareAndSet"]) {
        h.intercept(method, async (result) => {
          if (storageArmed) { storageBlocked = true; await storageHeld; }
          return result;
        });
      }
      await runCommand(h, "com.reai.voice.command.translate");
      await until(() => h.takebacks().length === 1, "请求取回卡");
      const surface = await h.host.openSurface("main");
      const root = surface.root!;
      root.querySelector<HTMLButtonElement>('[data-voice-tab="command"]')!.click();
      await until(() => !!root.querySelector(".command-history-item"), "命令历史里有这条运行中的翻译");
      root.querySelector<HTMLButtonElement>(".command-history-item")!.click();
      await until(() => !!root.querySelector(".chat-cancel"), "运行中的翻译有「停止翻译」");
      releaseTakeback();
      await until(() => storageBlocked, "取回卡被拒后进入落历史");
      root.querySelector<HTMLButtonElement>(".chat-cancel")!.click();
      await settle();
      releaseStorage();
      await until(() => root.querySelector(".chat-cancel") === null, "停止收尾完成");
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(h.answers()).toHaveLength(0);
    } finally {
      releaseTakeback();
      releaseStorage();
      await h.dispose();
    }
  });
}

test("翻译本身失败且取回卡被拒：改弹失败结果面板（内容为原文），仍不写原文", async () => {
  const h = await harness();
  try {
    h.host.rejectNextAgentSend({ kind: "engine", stderr_tail: "上游错误原文（测试注入）" });
    h.intercept("voice.deliver.present-takeback", rejectWith("VOICE_DELIVER_PERMISSION_DENIED"));
    await runCommand(h, "com.reai.voice.command.translate");
    await until(() => h.answers().length === 1, "取回卡被拒时必须改弹失败结果面板");
    await settle();
    expect(h.commits()).toHaveLength(0);
    const [answer] = h.answers();
    expect(answer).toMatchObject({ title: "翻译失败", status: "failed", text: "测试语音命令", errorCode: "AGENT_ENGINE" });
    expect(answer!.sections).toEqual([
      { label: "原文", text: "测试语音命令" },
      { label: "错误", text: "暂时无法完成翻译。你的内容已保存，请稍后重试。" },
    ]);
    expect(JSON.stringify(answer)).not.toContain("上游错误原文");
  } finally { await h.dispose(); }
});

test("Agent 3 秒内完成：只弹前台只读结果框，永不写回", async () => {
  const h = await harness();
  try {
    await runCommand(h, "com.reai.voice.command.agent");
    await until(() => h.answers().length === 1, "Agent 结果弹只读结果框");
    const answer = h.answers()[0]!;
    expect(answer.text).toBe("这是测试 Agent 回复");
    expect(answer.deferred).toBeUndefined();
    await settle();
    expect(h.commits()).toHaveLength(0);
    expect(h.takebacks()).toHaveLength(0);
    expect(h.tasks()).toHaveLength(0);
  } finally { await h.dispose(); }
});

test("Agent 超过 3 秒转入后台：先报终态帧，再弹迟到结果框（deferred，runId=taskId），永不写回", async () => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const h = await harness({
    hook: (ctx) => {
      const wait = ctx.agent.waitForTurn.bind(ctx.agent);
      Object.assign(ctx.agent, {
        waitForTurn: async (...args: Parameters<typeof wait>) => { await held; return await wait(...args); },
      });
    },
  });
  try {
    await runCommand(h, "com.reai.voice.command.agent");
    // 3 秒前后台分流保留：到点仍未完成就转入后台胶囊（running 首帧）。
    await until(() => h.tasks().some(task => task.state === "running"), "超过 3 秒没有转入后台", 5000);
    expect(h.answers()).toHaveLength(0);
    release();
    await until(() => h.answers().length === 1, "转入后台后完成仍要弹结果框");
    const taskId = h.tasks()[0]!.taskId;
    const answer = h.answers()[0]!;
    expect(answer).toMatchObject({ deferred: true, runId: taskId, text: "这是测试 Agent 回复", status: "succeeded" });
    // Host 合同：runId 须为后台任务 taskId，且先上报任务终态再请求迟到结果框。
    const order = h.host.voiceCommandRequests
      .filter(request => request.method === "voice.command.present-task" || request.method === "voice.command.present-answer")
      .map(request => request.method === "voice.command.present-answer"
        ? "answer"
        : (request.params as { state?: string }).state);
    expect(order).toEqual(["running", "succeeded", "answer"]);
    await settle();
    expect(h.commits()).toHaveLength(0);
    expect(h.takebacks()).toHaveLength(0);
  } finally {
    release();
    await h.dispose();
  }
}, 15_000);

for (const writeBack of ["committed", "not_received"] as const) {
  // 翻译不使用后台预算；写回成功不弹窗，失败取回。
  test(`翻译超过 3 秒仍在中央等待完成（写回 ${writeBack}）：写进去不弹窗，没写进去才弹取回卡`, async () => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const h = await harness({
      hook: (ctx) => {
        const wait = ctx.agent.waitForTurn.bind(ctx.agent);
        Object.assign(ctx.agent, {
          waitForTurn: async (...args: Parameters<typeof wait>) => { await held; return await wait(...args); },
        });
      },
    });
    try {
      if (writeBack !== "committed") h.intercept("voice.deliver.commit", () => ({ committed: false, reason: writeBack }));
      await runCommand(h, "com.reai.voice.command.translate");
      await new Promise(resolve => setTimeout(resolve, 3100));
      expect(h.tasks()).toHaveLength(0);
      release();
      await until(() => h.commits().length === 1, "完成后写回");
      await settle();
      expect(h.commits()).toHaveLength(1);
      // 听写/翻译不创建后台任务。
      expect(h.tasks()).toHaveLength(0);
      // 翻译成功不弹只读结果框（取回卡被拒时的兜底另测）。
      expect(h.answers()).toHaveLength(0);
      if (writeBack === "committed") {
        expect(h.takebacks()).toHaveLength(0);
      } else {
        expect(h.takebacks()).toEqual([{
          title: "翻译好了，但没能写入",
          reason: "目标应用没有接收文字",
          text: "这是测试 Agent 回复",
          errorCode: "not_received",
        }]);
      }
    } finally {
      release();
      await h.dispose();
    }
  }, 15_000);
}

test("翻译超过3秒写回失败且取回卡被拒：前台失败结果框", async () => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const h = await harness({
    hook: (ctx) => {
      const wait = ctx.agent.waitForTurn.bind(ctx.agent);
      Object.assign(ctx.agent, {
        waitForTurn: async (...args: Parameters<typeof wait>) => { await held; return await wait(...args); },
      });
    },
  });
  try {
    h.intercept("voice.deliver.commit", () => ({ committed: false, reason: "not_received" }));
    h.intercept("voice.deliver.present-takeback", rejectWith("VOICE_DELIVER_PERMISSION_DENIED"));
    await runCommand(h, "com.reai.voice.command.translate");
    await new Promise(resolve => setTimeout(resolve, 3100));
      expect(h.tasks()).toHaveLength(0);
    release();
    await until(() => h.answers().length === 1, "后台完成后取回卡被拒，必须弹迟到失败结果框");

    const answerIndex = h.host.voiceCommandRequests.findIndex(request => request.method === "voice.command.present-answer");
    const terminalIndex = h.host.voiceCommandRequests.findIndex(request => request.method === "voice.command.present-task"
      && (request.params as { state?: string }).state === "succeeded");
    expect(terminalIndex).toBe(-1);
    expect(answerIndex).toBeGreaterThanOrEqual(0);
    expect(h.answers()[0]).toMatchObject({
      status: "failed",
      title: "翻译好了，但没能写入",
      text: "这是测试 Agent 回复",
      errorCode: "not_received",
    });
    expect(JSON.stringify(h.answers()[0])).not.toContain("已写入");
  } finally {
    release();
    await h.dispose();
  }
}, 15_000);

test("Agent 与翻译不润色也不采上下文；转文本与输入法按默认「轻度」润色后写回", async () => {
  // 开着窗口上下文：润色会读前台输入框文字，不润色的方向一个字都不该读。
  const h = await harness({ settings: { polishContext: { ...DEFAULT_SETTINGS.polishContext, window: true } } });
  try {
    expect(DEFAULT_SETTINGS.polish).toBe("light");
    const contextReads = () => h.host.voiceInputRequests.filter(request => request.method === "voice.context.capture"
      && (request.params as { includeWindowText?: boolean }).includeWindowText === true).length;
    const contextBefore = contextReads();
    for (const eventId of ["com.reai.voice.command.translate", "com.reai.voice.command.agent"]) {
      const before = h.host.agentRequests.filter(request => request.method === "agent.v2.turn.start").length;
      await runCommand(h, eventId);
      await until(() => h.host.agentRequests.filter(request => request.method === "agent.v2.turn.start").length > before, `${eventId} 没有发起 Agent`);
      const turn = h.host.agentRequests.filter(request => request.method === "agent.v2.turn.start").at(-1);
      const text = (turn?.params as { text?: string }).text;
      // 翻译把识别原文（未润色）放在随机标记之间；Agent 直接收识别原文。
      if (eventId.endsWith(".translate")) expect(text).toMatch(/\n<<<SOURCE-[0-9a-f]{12}>>>\n测试语音命令\n<<<END-SOURCE-[0-9a-f]{12}>>>$/);
      else expect(text).toBe("测试语音命令");
    }
    await until(() => h.answers().length === 1, "Agent 结果框");
    await settle();
    expect(h.generates()).toBe(0);
    expect(contextReads()).toBe(contextBefore);

    // 转文本是语音输入法的命令形态：按档位润色后写回润色稿。
    h.host.setNextAiTextGenerateText("测试语音命令。");
    await runCommand(h, "com.reai.voice.command.transcribe");
    await until(() => h.commits().length === 2, "转文本写回");
    expect(h.generates()).toBe(1);
    expect(contextReads()).toBeGreaterThan(contextBefore);
    expect(h.commits().at(-1)!.text).toBe("测试语音命令。");

    h.host.setNextAiTextGenerateText("测试语音输入。");
    await runCommand(h, "com.reai.voice.toggle-input");
    await until(() => h.commits().length === 3, "输入法写回");
    expect(h.generates()).toBe(2);
    expect(h.commits().at(-1)!.text).toBe("测试语音输入。");
  } finally { await h.dispose(); }
});

test("转文本写回成功：只写回一次，不弹结果框也不弹卡", async () => {
  const h = await harness({ settings: { polish: "raw" } });
  try {
    await runCommand(h, "com.reai.voice.command.transcribe");
    await until(() => h.commits().length === 1, "转文本写回");
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(h.commits()).toHaveLength(1);
    expect(h.commits()[0]!.text).toBe("测试语音命令");
    expect(h.answers()).toHaveLength(0);
    expect(h.takebacks()).toHaveLength(0);
  } finally { await h.dispose(); }
});

test("转文本润色超过3秒仍等待写回，不转后台", async () => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const h = await harness({
    hook: (ctx) => {
      const generate = ctx.aiApi.generateText.bind(ctx.aiApi);
      Object.assign(ctx.aiApi, {
        generateText: async (...args: Parameters<typeof generate>) => { await held; return await generate(...args); },
      });
    },
  });
  try {
    h.host.setNextAiTextGenerateText("测试语音命令。");
    await runCommand(h, "com.reai.voice.command.transcribe");
    await new Promise(resolve => setTimeout(resolve, 3100));
    expect(h.tasks()).toHaveLength(0);
    release();
    await until(() => h.commits().length === 1, "完成后写回");
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(h.commits()).toHaveLength(1);
    expect(h.commits()[0]!.text).toBe("测试语音命令。");
    expect(h.answers()).toHaveLength(0);
    expect(h.takebacks()).toHaveLength(0);
  } finally {
    release();
    await h.dispose();
  }
}, 15_000);

test("转文本写回失败、取回卡被接下：只弹取回卡，不弹结果框", async () => {
  const h = await harness({ settings: { polish: "raw" } });
  try {
    h.intercept("voice.deliver.commit", () => ({ committed: false, reason: "not_received" }));
    await runCommand(h, "com.reai.voice.command.transcribe");
    await until(() => h.takebacks().length === 1, "转文本写回失败请求取回卡");
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(h.commits()).toHaveLength(1);
    expect(h.answers()).toHaveLength(0);
  } finally { await h.dispose(); }
});

// 2026-09-28 放宽（rc.8）：写回权限被拒时取回卡跟着被拒，转文本同样改弹失败结果面板，
// 不能「没写进去」还一个窗口都没有。
test("转文本写回失败且取回卡被拒：改弹失败结果面板——润色稿、原因与真实码，不含「已写入」", async () => {
  const h = await harness();
  try {
    h.host.setNextAiTextGenerateText("测试语音命令。");
    h.intercept("voice.deliver.commit", rejectWith("VOICE_DELIVER_PERMISSION_DENIED"));
    h.intercept("voice.deliver.present-takeback", rejectWith("VOICE_DELIVER_PERMISSION_DENIED"));
    await runCommand(h, "com.reai.voice.command.transcribe");
    await until(() => h.answers().length === 1, "取回卡被拒时必须改弹失败结果面板");
    await settle();
    expect(h.commits()).toHaveLength(1);
    expect(h.takebacks()).toHaveLength(1);
    const [answer] = h.answers();
    expect(answer).toMatchObject({
      badge: "转文本",
      title: "文字没有写入成功",
      status: "failed",
      text: "测试语音命令。",
      originalText: "测试语音命令",
      errorCode: "VOICE_DELIVER_PERMISSION_DENIED",
      canCopy: true,
    });
    expect(answer!.deferred).toBeUndefined();
    expect(answer!.sections).toEqual([
      { label: "原文", text: "测试语音命令" },
      { label: "转文本结果", text: "测试语音命令。" },
      { label: "错误", text: h.takebacks()[0]!.reason },
    ]);
    expect(h.takebacks()[0]!.reason).not.toContain(h.takebacks()[0]!.errorCode!);
    expect(JSON.stringify(answer)).not.toContain("已写入");
  } finally { await h.dispose(); }
});

test("转文本润色超过3秒写回失败且取回卡被拒：前台失败结果框", async () => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const h = await harness({
    hook: (ctx) => {
      const generate = ctx.aiApi.generateText.bind(ctx.aiApi);
      Object.assign(ctx.aiApi, {
        generateText: async (...args: Parameters<typeof generate>) => { await held; return await generate(...args); },
      });
    },
  });
  try {
    h.host.setNextAiTextGenerateText("测试语音命令。");
    h.intercept("voice.deliver.commit", () => ({ committed: false, reason: "not_received" }));
    h.intercept("voice.deliver.present-takeback", rejectWith("VOICE_DELIVER_PERMISSION_DENIED"));
    await runCommand(h, "com.reai.voice.command.transcribe");
    await new Promise(resolve => setTimeout(resolve, 3100));
    expect(h.tasks()).toHaveLength(0);
    release();
    await until(() => h.answers().length === 1, "后台完成后取回卡被拒，必须弹迟到失败结果框");

    const answerIndex = h.host.voiceCommandRequests.findIndex(request => request.method === "voice.command.present-answer");
    const terminalIndex = h.host.voiceCommandRequests.findIndex(request => request.method === "voice.command.present-task"
      && (request.params as { state?: string }).state === "succeeded");
    expect(terminalIndex).toBe(-1);
    expect(answerIndex).toBeGreaterThanOrEqual(0);
    expect(h.answers()[0]).toMatchObject({
      status: "failed",
      title: "文字没有写入成功",
      text: "测试语音命令。",
      errorCode: "not_received",
    });
    expect(JSON.stringify(h.answers()[0])).not.toContain("已写入");
  } finally {
    release();
    await h.dispose();
  }
}, 15_000);

// 原文回退分支（try 内抛错后转文本用原文顶上）：现实里能把转文本推进这条分支的，是润色途中
// 账号会话变了（AI_SESSION_CHANGED 不降级、原样抛出）。原文也写不进去时弹取回卡；卡被接下就只有卡。
test("转文本走原文回退、原文也没写进去、取回卡被接下：只弹取回卡，不弹结果框", async () => {
  const h = await harness();
  try {
    h.host.failNextAiTextGenerate("AI_SESSION_CHANGED");
    h.intercept("voice.deliver.commit", () => ({ committed: false, reason: "not_received" }));
    await runCommand(h, "com.reai.voice.command.transcribe");
    await until(() => h.takebacks().length === 1, "原文回退写回失败请求取回卡");
    expect(h.commits()).toHaveLength(1);
    expect(h.commits()[0]!.text).toBe("测试语音命令");
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(h.answers()).toHaveLength(0);
  } finally { await h.dispose(); }
});

test("转文本走原文回退、原文也没写进去且取回卡被拒：改弹失败结果面板（内容为原文）", async () => {
  const h = await harness();
  try {
    h.host.failNextAiTextGenerate("AI_SESSION_CHANGED");
    h.intercept("voice.deliver.commit", () => ({ committed: false, reason: "not_received" }));
    h.intercept("voice.deliver.present-takeback", rejectWith("VOICE_DELIVER_PERMISSION_DENIED"));
    await runCommand(h, "com.reai.voice.command.transcribe");
    await until(() => h.answers().length === 1, "取回卡被拒时必须改弹失败结果面板");
    await settle();
    // 确认走的是原文回退分支：只写过一次、写的是原文，卡里也是原文。
    expect(h.commits()).toHaveLength(1);
    expect(h.commits()[0]!.text).toBe("测试语音命令");
    expect(h.takebacks()[0]).toMatchObject({ title: "文字没有写入成功", text: "测试语音命令" });
    const [answer] = h.answers();
    expect(answer).toMatchObject({
      title: "文字没有写入成功",
      status: "failed",
      text: "测试语音命令",
      errorCode: "not_received",
      canCopy: true,
    });
    expect(answer!.deferred).toBeUndefined();
    expect(answer!.sections).toEqual([
      { label: "原文", text: "测试语音命令" },
      { label: "错误", text: h.takebacks()[0]!.reason },
    ]);
    expect(JSON.stringify(answer)).not.toContain("已写入");
  } finally { await h.dispose(); }
});

// 2026-09-29（Codex 复审 #983 的 P2）：没写进去时先 await「文字没有写入」的胶囊上报，再请求取回卡。
// 用户正好在这段等待里按停止：controller 已 abort、运行记录还没删，只看 isRunActive() 拦不住。
// 三条路径都必须走停止收尾——不弹取回卡、不弹结果面板、不记成完成。
for (const route of ["翻译写回失败", "转文本写回失败", "转文本原文回退也写不进去"] as const) {
  test(`${route}：报「没写入」阶段期间用户按了停止，不再弹取回卡`, async () => {
    const h = await harness();
    let releaseCommit!: () => void;
    const commitHeld = new Promise<void>(resolve => { releaseCommit = resolve; });
    let releaseReport!: () => void;
    const reportHeld = new Promise<void>(resolve => { releaseReport = resolve; });
    let reportArrived = false;
    try {
      if (route === "转文本原文回退也写不进去") h.host.failNextAiTextGenerate("AI_SESSION_CHANGED");
      // 先拖住写回，好在写回失败之前把「停止」按钮准备好。
      h.intercept("voice.deliver.commit", async () => {
        await commitHeld;
        return { committed: false, reason: "not_received" };
      });
      h.intercept("voice.report-stage", async (result, params) => {
        if (params.stage === "insert_failed") { reportArrived = true; await reportHeld; }
        return result;
      });
      const eventId = route === "翻译写回失败" ? "com.reai.voice.command.translate" : "com.reai.voice.command.transcribe";
      await runCommand(h, eventId);
      await until(() => h.commits().length === 1, "请求写回");
      const surface = await h.host.openSurface("main");
      const root = surface.root!;
      root.querySelector<HTMLButtonElement>('[data-voice-tab="command"]')!.click();
      await until(() => !!root.querySelector(".command-history-item"), "命令历史里有这条运行中的命令");
      root.querySelector<HTMLButtonElement>(".command-history-item")!.click();
      await until(() => !!root.querySelector(".chat-cancel"), "运行中的命令有停止按钮");
      releaseCommit();
      await until(() => reportArrived, "写回失败后先报「没写入」阶段");
      root.querySelector<HTMLButtonElement>(".chat-cancel")!.click();
      await settle();
      releaseReport();
      await until(() => root.querySelector(".chat-cancel") === null, "停止收尾完成");
      await new Promise(resolve => setTimeout(resolve, 150));
      if (route === "转文本原文回退也写不进去") expect(h.commits()[0]!.text).toBe("测试语音命令");
      expect(h.takebacks()).toHaveLength(0);
      expect(h.answers()).toHaveLength(0);
      const [item] = await commandHistory(h);
      expect(item!.status).not.toBe("completed");
    } finally {
      releaseCommit();
      releaseReport();
      await h.dispose();
    }
  });
}

test("插件间 request-text：只返回文本，不写回、不弹卡、不落 Voice 历史", async () => {
  const h = await harness({ settings: { polish: "raw" } });
  try {
    h.host.setVoiceContextCapture({ sessionEpoch: "epoch-a" });
    const serviceId = "com.reai.voice/request-text@1";
    const caller = { appId: "com.example.consumer", surfaceMountId: "consumer-mount", runtimeSessionId: "consumer-runtime", accountGeneration: "epoch-a" };
    const input = { requestId: `${Date.now()}:${crypto.randomUUID()}` };
    const pending = h.host.invokeService(serviceId, "request-text", input, caller);
    await until(() => h.host.voiceInputRequests.some(request => request.method === "voice.toggle"), "request-text 没有开始录音");
    const start = h.host.voiceInputRequests.find(request => request.method === "voice.toggle")!.params as Record<string, unknown>;
    expect(start).toMatchObject({ insertText: false, captureDeliveryTarget: false });
    await h.host.invokeService(serviceId, "finish", input, caller);
    const settled = await pending as { ok?: boolean; output?: { text?: string; kind?: string } };
    expect(settled.output).toMatchObject({ text: "测试语音输入", kind: "raw" });
    await settle();
    expect(h.commits()).toHaveLength(0);
    expect(h.takebacks()).toHaveLength(0);
    expect(h.answers()).toHaveLength(0);
    expect(await inputHistory(h)).toHaveLength(0);
  } finally { await h.dispose(); }
});

test("Tab 层消费了这段识别（consumedBy）：不润色、不写回、不弹卡", async () => {
  const h = await harness();
  try {
    h.host.consumeNextVoiceResultByTabLayer();
    await runCommand(h, "com.reai.voice.toggle-input");
    await until(() => h.host.storageKeys().includes("com.reai.voice/voice-state/history"), "识别结果仍留在历史");
    await settle();
    expect(h.generates()).toBe(0);
    expect(h.commits()).toHaveLength(0);
    expect(h.takebacks()).toHaveLength(0);
    const [item] = await inputHistory(h);
    expect(item).toMatchObject({ transcript: "测试语音输入", inserted: false });
    expect(item!.warningCode).toBeUndefined();
  } finally { await h.dispose(); }
});

test("输入法写回失败（not_editable）：弹一张取回卡，历史详情只留一行新文案提示", async () => {
  const h = await harness({ settings: { polish: "raw" } });
  try {
    h.host.setNextVoiceDeliverCommitReason("not_editable");
    const surface = await h.host.openSurface("main");
    await runCommand(h, "com.reai.voice.toggle-input");
    await until(() => h.takebacks().length === 1, "写回失败弹取回卡");
    expect(h.takebacks()[0]).toEqual({ title: "文字没有写入成功", reason: "光标不在可输入的位置", text: "测试语音输入", errorCode: "not_editable" });
    await until(() => !!surface.root!.querySelector(".task-item"), "历史出现这一条");
    surface.root!.querySelector<HTMLButtonElement>(".task-item")!.click();
    const warnings = Array.from(surface.root!.querySelectorAll(".inline-warning"), node => node.textContent);
    expect(warnings).toEqual(["插入时光标不在可输入的位置，文字没有写入，已保留在这条历史里。"]);
    // 页内不再渲染任何「写入失败 / 复制全文」卡片：失败窗口只有 Host 取回卡一张。
    expect(surface.root!.querySelector(".undelivered-text-panel")).toBeNull();
    expect(surface.root!.textContent).not.toContain("复制全文");
  } finally { await h.dispose(); }
});

test("输入法写回成功：不弹取回卡，也不弹结果框", async () => {
  const h = await harness({ settings: { polish: "raw" } });
  try {
    await runCommand(h, "com.reai.voice.toggle-input");
    await until(() => h.commits().length === 1, "输入法写回");
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(h.takebacks()).toHaveLength(0);
    expect(h.answers()).toHaveLength(0);
  } finally { await h.dispose(); }
});

test("输入法写回失败、取回卡被接下：只有取回卡，不弹结果框", async () => {
  const h = await harness({ settings: { polish: "raw" } });
  try {
    h.host.setNextVoiceDeliverCommitReason("not_editable");
    await runCommand(h, "com.reai.voice.toggle-input");
    await until(() => h.takebacks().length === 1, "写回失败弹取回卡");
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(h.answers()).toHaveLength(0);
  } finally { await h.dispose(); }
});

// 2026-09-28（rc.8）：写回权限被拒时 commit 与取回卡被同一道门拒绝，输入法改弹失败结果面板。
test("输入法写回权限被拒（commit 与取回卡都被拒）：改弹失败结果面板——润色稿、原因与真实码，不含「已写入」", async () => {
  const h = await harness();
  try {
    h.host.setNextAiTextGenerateText("测试语音输入。");
    h.intercept("voice.deliver.commit", rejectWith("VOICE_DELIVER_PERMISSION_DENIED"));
    h.intercept("voice.deliver.present-takeback", rejectWith("VOICE_DELIVER_PERMISSION_DENIED"));
    await runCommand(h, "com.reai.voice.toggle-input");
    await until(() => h.answers().length === 1, "取回卡被拒时必须改弹失败结果面板");
    await settle();
    expect(h.commits()).toHaveLength(1);
    expect(h.takebacks()).toHaveLength(1);
    const [card] = h.takebacks();
    expect(card).toMatchObject({ title: "文字没有写入成功", text: "测试语音输入。", errorCode: "VOICE_DELIVER_PERMISSION_DENIED" });
    expect(card!.reason).not.toContain(card!.errorCode!);
    const [answer] = h.answers();
    expect(answer).toMatchObject({
      badge: "语音输入",
      title: "文字没有写入成功",
      status: "failed",
      text: "测试语音输入。",
      originalText: "测试语音输入",
      errorCode: "VOICE_DELIVER_PERMISSION_DENIED",
      canCopy: true,
      canContinue: false,
    });
    expect(answer!.deferred).toBeUndefined();
    expect(answer!.sections).toEqual([
      { label: "原文", text: "测试语音输入" },
      { label: "语音输入结果", text: "测试语音输入。" },
      { label: "错误", text: card!.reason },
    ]);
    expect(JSON.stringify(answer)).not.toContain("已写入");
    // 文字仍照常落历史（兜底面板不等回执、不挡落盘）。
    const [item] = await inputHistory(h);
    expect(item).toMatchObject({ transcript: "测试语音输入。", inserted: false });
  } finally { await h.dispose(); }
});

test("未登录时润色静默按原文写回，不记 polish_failed", async () => {
  const h = await harness();
  try {
    h.host.failNextAiTextGenerate("AI_NOT_LOGGED_IN");
    await runCommand(h, "com.reai.voice.toggle-input");
    await until(() => h.commits().length === 1, "未登录也照常写回原文");
    expect(h.commits()[0]!.text).toBe("测试语音输入");
    await until(() => h.host.storageKeys().includes("com.reai.voice/voice-state/history"), "历史落盘");
    const [item] = await inputHistory(h);
    expect(item!.warningCode).toBeUndefined();
    expect(item!.polishFailed).toBeUndefined();
    expect(h.takebacks()).toHaveLength(0);
  } finally { await h.dispose(); }
});

test("命令录音带回 replayClip 时，命令历史保存回听引用（终态沿用 running 登记）", async () => {
  const h = await harness();
  try {
    const clip = { id: "command-clip-1", wallStartMs: 1_700_000_100_000, durationMs: 1_200, effectiveStartMs: 1_700_000_100_100, effectiveEndMs: 1_700_000_101_000 };
    h.intercept("voice.toggle", (result) => {
      const value = result as { phase?: string; mode?: string };
      return value.phase === "idle" && value.mode === "command" ? { ...value, replayClip: clip } : result;
    });
    await runCommand(h, "com.reai.voice.command.agent");
    await until(() => h.answers().length === 1, "Agent 结果框");
    const [item] = await commandHistory(h);
    expect(item).toMatchObject({
      status: "completed",
      recordingId: "command-clip-1",
      recordingWallStartMs: 1_700_000_100_100,
      recordingDurationMs: 900,
    });
  } finally { await h.dispose(); }
});

test("识别只出文本：输入法与命令的每一次 toggle 都显式传 insertText:false", async () => {
  const h = await harness({ settings: { polish: "raw" } });
  try {
    await runCommand(h, "com.reai.voice.toggle-input");
    await until(() => h.commits().length === 1, "输入法写回由插件完成");
    await runCommand(h, "com.reai.voice.command.transcribe");
    await until(() => h.commits().length === 2, "转文本写回由插件完成");
    const toggles = h.host.voiceInputRequests.filter(request => request.method === "voice.toggle");
    expect(toggles.length).toBe(4);
    for (const toggle of toggles) {
      expect((toggle.params as { insertText?: unknown }).insertText).toBe(false);
    }
  } finally { await h.dispose(); }
});

function transcriptionWrites(h: Harness): Array<{ recordingId?: string; status?: string; transcript?: string }> {
  return h.host.voiceInputRequests
    .filter(request => request.method === "voice.recordings.set-input-transcription")
    .map(request => request.params as { recordingId?: string; status?: string; transcript?: string });
}

const cloudSettings: Partial<VoiceInputSettings> = { engine: "cloud", polish: "raw" };

test("云端识别的输入法录音：识别结束按 replayClip.id 回写转写结果，失败也回写", async () => {
  const h = await harness({ settings: cloudSettings });
  try {
    const sessionId = await runCommand(h, "com.reai.voice.toggle-input");
    await until(() => h.commits().length === 1, "云端识别后写回");
    expect(transcriptionWrites(h)).toEqual([
      { recordingId: `mock-replay-${sessionId}`, status: "complete", transcript: "测试云端转写" },
    ]);

    h.host.failNextAiAudioTranscribe("AI_UNAVAILABLE");
    const failedSession = await runCommand(h, "com.reai.voice.toggle-input");
    await until(() => transcriptionWrites(h).length === 2, "云端识别失败也要回写");
    expect(transcriptionWrites(h)[1]).toEqual({ recordingId: `mock-replay-${failedSession}`, status: "failed" });
    expect(h.commits()).toHaveLength(1);
  } finally { await h.dispose(); }
});

test("云端识别的命令录音（翻译）：回写转写结果；云端识别失败回写 failed", async () => {
  const h = await harness({ settings: cloudSettings });
  try {
    const sessionId = await runCommand(h, "com.reai.voice.command.translate");
    await until(() => h.commits().length === 1, "翻译写回");
    expect(transcriptionWrites(h)).toEqual([
      { recordingId: `mock-replay-${sessionId}`, status: "complete", transcript: "测试云端转写" },
    ]);
    const [item] = await commandHistory(h);
    expect(item!.recordingId).toBe(`mock-replay-${sessionId}`);

    h.host.failNextAiAudioTranscribe("AI_UNAVAILABLE");
    const failedSession = await runCommand(h, "com.reai.voice.command.agent");
    await until(() => transcriptionWrites(h).length === 2, "命令云端识别失败也要回写");
    expect(transcriptionWrites(h)[1]).toEqual({ recordingId: `mock-replay-${failedSession}`, status: "failed" });
  } finally { await h.dispose(); }
});

test("云端识别的翻译 3 秒内完成：按原录音会话确认，Host 认账并收掉中央胶囊", async () => {
  const h = await harness({ settings: cloudSettings });
  try {
    const answered: Array<{ sessionId?: string; acknowledged?: boolean }> = [];
    h.intercept("voice.acknowledge-result", (result, params) => {
      answered.push({ sessionId: params.sessionId as string, acknowledged: (result as { acknowledged?: boolean }).acknowledged });
      return result;
    });
    const sessionId = await runCommand(h, "com.reai.voice.command.translate");
    await until(() => h.commits().length === 1, "云端翻译写回");
    await until(() => answered.some(entry => entry.sessionId === sessionId), "要确认原录音会话");
    expect(answered.find(entry => entry.sessionId === sessionId)?.acknowledged).toBeTrue();
    expect(h.answers()).toHaveLength(0);
    expect(h.tasks()).toHaveLength(0);
  } finally { await h.dispose(); }
});

test("插件间 request-text 走云端识别：同样回写 Host 落下的录音", async () => {
  const h = await harness({ settings: cloudSettings });
  try {
    h.host.setVoiceContextCapture({ sessionEpoch: "epoch-a" });
    const serviceId = "com.reai.voice/request-text@1";
    const caller = { appId: "com.example.consumer", surfaceMountId: "consumer-mount", runtimeSessionId: "consumer-runtime", accountGeneration: "epoch-a" };
    const input = { requestId: `${Date.now()}:${crypto.randomUUID()}` };
    const pending = h.host.invokeService(serviceId, "request-text", input, caller);
    await until(() => h.host.voiceInputRequests.some(request => request.method === "voice.toggle"), "request-text 没有开始录音");
    await h.host.invokeService(serviceId, "finish", input, caller);
    const settled = await pending as { output?: { text?: string } };
    expect(settled.output?.text).toBe("测试云端转写");
    await until(() => transcriptionWrites(h).length === 1, "request-text 云端识别后回写");
    expect(transcriptionWrites(h)[0]).toMatchObject({ status: "complete", transcript: "测试云端转写" });
    expect(h.commits()).toHaveLength(0);
  } finally { await h.dispose(); }
});

test("replayClipStatus 不是 saved：历史只留文字、不挂回听入口，也不回写转写", async () => {
  const h = await harness({ settings: { ...cloudSettings } });
  try {
    for (const status of ["failed", "not_retained"] as const) {
      h.intercept("voice.toggle", (result) => {
        const value = result as { phase?: string };
        return value.phase === "idle" ? { ...value, replayClipStatus: status } : result;
      });
      await runCommand(h, "com.reai.voice.toggle-input");
      await runCommand(h, "com.reai.voice.command.agent");
    }
    await until(() => h.answers().length === 2, "两次 Agent 都完成");
    await until(() => h.commits().length === 2, "两次输入都写回");
    await settle();
    expect(transcriptionWrites(h)).toHaveLength(0);
    for (const item of await inputHistory(h)) expect(item.recordingId).toBeUndefined();
    for (const item of await commandHistory(h)) expect(item.recordingId).toBeUndefined();
  } finally { await h.dispose(); }
});

// ---- 中央胶囊停到写入那一刻（Host API 1.22 holdOverlayUntilAck / voice.report-stage） ----

type OverlayEvent = { method: string; sessionId?: string; stage?: string; outcome?: unknown };

/** 把胶囊相关请求与写回 / 取回卡按真实发生顺序记进同一条时间线。 */
function recordOverlay(h: Harness): OverlayEvent[] {
  const events: OverlayEvent[] = [];
  const log = (method: string, pick: (result: unknown) => unknown) =>
    h.intercept(method, (result, params) => {
      events.push({
        method,
        sessionId: params.sessionId as string | undefined,
        stage: params.stage as string | undefined,
        outcome: pick(result),
      });
      return result;
    });
  log("voice.report-stage", result => (result as { accepted?: boolean }).accepted);
  log("voice.acknowledge-result", result => (result as { acknowledged?: boolean }).acknowledged);
  log("voice.deliver.commit", result => (result as { committed?: boolean }).committed);
  log("voice.deliver.present-takeback", () => true);
  return events;
}

const indexOf = (events: OverlayEvent[], match: (event: OverlayEvent) => boolean) => events.findIndex(match);

test("胶囊：输入法录音声明 holdOverlayUntilAck，写入成功那一刻按会话确认收起", async () => {
  const h = await harness({ settings: { polish: "raw" } });
  try {
    const events = recordOverlay(h);
    const sessionId = await runCommand(h, "com.reai.voice.toggle-input");
    await until(() => events.some(event => event.method === "voice.acknowledge-result" && event.sessionId === sessionId), "写入后要确认收起胶囊");
    const starts = h.host.voiceInputRequests
      .filter(request => request.method === "voice.toggle")
      .map(request => request.params as { mode?: string; holdOverlayUntilAck?: unknown });
    expect(starts.filter(start => start.mode === "input").length).toBeGreaterThan(0);
    expect(starts.filter(start => start.mode === "input").every(start => start.holdOverlayUntilAck === true)).toBeTrue();
    const commit = indexOf(events, event => event.method === "voice.deliver.commit" && event.outcome === true);
    const ack = indexOf(events, event => event.method === "voice.acknowledge-result" && event.sessionId === sessionId);
    expect(commit).toBeGreaterThanOrEqual(0);
    expect(ack).toBeGreaterThan(commit);
    expect(events[ack]!.outcome).toBeTrue();
    // raw 不润色：途中不换句子，也没有失败句。
    expect(events.filter(event => event.method === "voice.report-stage")).toEqual([]);
  } finally { await h.dispose(); }
});

test("胶囊：输入法润色时报 polishing，写入成功再确认", async () => {
  const h = await harness();
  try {
    const events = recordOverlay(h);
    h.host.setNextAiTextGenerateText("测试语音输入。");
    const sessionId = await runCommand(h, "com.reai.voice.toggle-input");
    await until(() => events.some(event => event.method === "voice.acknowledge-result"), "写入后确认");
    const polishing = indexOf(events, event => event.method === "voice.report-stage" && event.stage === "polishing");
    expect(polishing).toBeGreaterThanOrEqual(0);
    expect(events[polishing]).toMatchObject({ sessionId, outcome: true });
    expect(polishing).toBeLessThan(indexOf(events, event => event.method === "voice.deliver.commit"));
  } finally { await h.dispose(); }
});

test("胶囊：输入法写入失败先报 insert_failed 再弹取回卡，之后的确认不会收起失败句", async () => {
  const h = await harness({ settings: { polish: "raw" } });
  try {
    const events = recordOverlay(h);
    h.host.setNextVoiceDeliverCommitReason("not_editable");
    const sessionId = await runCommand(h, "com.reai.voice.toggle-input");
    await until(() => h.takebacks().length === 1, "写回失败弹取回卡");
    await settle();
    const failed = indexOf(events, event => event.method === "voice.report-stage" && event.stage === "insert_failed");
    expect(failed).toBeGreaterThanOrEqual(0);
    expect(events[failed]).toMatchObject({ sessionId, outcome: true });
    expect(failed).toBeLessThan(indexOf(events, event => event.method === "voice.deliver.present-takeback"));
    // 失败句必须留在胶囊上：不能再有一次成功的确认把它收掉。
    expect(events.some(event => event.method === "voice.acknowledge-result" && event.outcome === true)).toBeFalse();
  } finally { await h.dispose(); }
});

test("胶囊：云端识别出文字报 transcribed；识别为空直接确认收起", async () => {
  const h = await harness({ settings: cloudSettings });
  try {
    const events = recordOverlay(h);
    const sessionId = await runCommand(h, "com.reai.voice.toggle-input");
    await until(() => h.commits().length === 1, "云端识别后写回");
    const transcribed = indexOf(events, event => event.method === "voice.report-stage" && event.stage === "transcribed");
    expect(transcribed).toBeGreaterThanOrEqual(0);
    expect(events[transcribed]).toMatchObject({ sessionId, outcome: true });
    expect(transcribed).toBeLessThan(indexOf(events, event => event.method === "voice.deliver.commit"));

    h.host.setNextAiAudioTranscribeText("");
    const emptySession = await runCommand(h, "com.reai.voice.toggle-input");
    await until(() => events.some(event => event.method === "voice.acknowledge-result" && event.sessionId === emptySession), "空结果要收起胶囊");
    expect(events.find(event => event.method === "voice.acknowledge-result" && event.sessionId === emptySession)!.outcome).toBeTrue();
    expect(h.commits()).toHaveLength(1);
  } finally { await h.dispose(); }
});

test("胶囊：翻译报 translating；翻译写入失败先报 insert_failed 再弹取回卡", async () => {
  const h = await harness({ settings: { polish: "raw" } });
  try {
    const events = recordOverlay(h);
    const sessionId = await runCommand(h, "com.reai.voice.command.translate");
    await until(() => h.commits().length === 1, "翻译写回");
    await until(() => events.some(event => event.method === "voice.acknowledge-result" && event.sessionId === sessionId), "写回后确认");
    const translating = indexOf(events, event => event.method === "voice.report-stage" && event.stage === "translating");
    expect(translating).toBeGreaterThanOrEqual(0);
    expect(events[translating]).toMatchObject({ sessionId, outcome: true });
    expect(translating).toBeLessThan(indexOf(events, event => event.method === "voice.deliver.commit"));

    h.host.setNextVoiceDeliverCommitReason("not_editable");
    const failedSession = await runCommand(h, "com.reai.voice.command.translate");
    await until(() => h.takebacks().length === 1, "翻译写回失败弹取回卡");
    const failed = indexOf(events, event => event.method === "voice.report-stage" && event.stage === "insert_failed" && event.sessionId === failedSession);
    expect(failed).toBeGreaterThanOrEqual(0);
    expect(events[failed]!.outcome).toBeTrue();
    expect(failed).toBeLessThan(indexOf(events, event => event.method === "voice.deliver.present-takeback"));
  } finally { await h.dispose(); }
});

for (const [label, eventId] of [
  ["翻译", "com.reai.voice.command.translate"],
  ["转文本", "com.reai.voice.command.transcribe"],
] as const) {
  test(`胶囊：${label}写入失败时 Host 受理 insert_failed 慢于等待上限，收尾确认也不会抢先收掉失败句`, async () => {
    const h = await harness({ settings: { polish: "raw" } });
    try {
      const events = recordOverlay(h);
      // 超过插件对单个上报的 500 毫秒等待：收尾确认若直连 Host，会先于失败句被受理。
      h.delayBefore("voice.report-stage", params => (params.stage === "insert_failed" ? 750 : 0));
      h.host.setNextVoiceDeliverCommitReason("not_editable");
      const sessionId = await runCommand(h, eventId);
      await until(() => h.takebacks().length === 1, `${label}写回失败弹取回卡`);
      await until(
        () => events.some(event => event.method === "voice.report-stage" && event.stage === "insert_failed" && event.sessionId === sessionId),
        "失败句最终送达 Host",
        3000,
      );
      await settle();
      const failed = indexOf(events, event => event.method === "voice.report-stage" && event.stage === "insert_failed" && event.sessionId === sessionId);
      expect(events[failed]!.outcome).toBeTrue();
      const acks = events
        .map((event, index) => ({ event, index }))
        .filter(({ event }) => event.method === "voice.acknowledge-result" && event.sessionId === sessionId);
      for (const { event, index } of acks) {
        expect(index).toBeGreaterThan(failed);
        expect(event.outcome).not.toBeTrue();
      }
    } finally { await h.dispose(); }
  });
}

test("胶囊：旧 Host 拒绝 voice.report-stage 时写回与取回卡照常", async () => {
  const h = await harness();
  try {
    h.intercept("voice.report-stage", () => { throw new Error("unknown method voice.report-stage"); });
    h.host.setNextAiTextGenerateText("测试语音输入。");
    await runCommand(h, "com.reai.voice.toggle-input");
    await until(() => h.commits().length === 1, "润色报阶段失败也照常写回");
    h.host.setNextVoiceDeliverCommitReason("not_editable");
    await runCommand(h, "com.reai.voice.toggle-input");
    await until(() => h.takebacks().length === 1, "报失败句失败也照常弹取回卡");
  } finally { await h.dispose(); }
});

test("听写取回窗口未确认可见时不ACK，确认后才隐藏", async () => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const h = await harness({ settings: { polish: "raw" } });
  try {
    h.intercept("voice.deliver.commit", () => ({ committed: false, reason: "not_received" }));
    h.intercept("voice.deliver.present-takeback", async (result) => { await held; return result; });
    const sessionId = await runCommand(h, "com.reai.voice.toggle-input");
    await until(() => h.takebacks().length === 1, "取回请求已发出");
    const ack = () => h.host.voiceInputRequests.filter(request => request.method === "voice.acknowledge-result"
      && (request.params as {sessionId?: string}).sessionId === sessionId);
    await new Promise(resolve => setTimeout(resolve, 1100));
    expect((await inputHistory(h))).toHaveLength(1);
    expect(ack()).toHaveLength(0);
    release();
    await until(() => ack().length > 0, "窗口确认可见后才ACK");
  } finally { release(); await h.dispose(); }
});

test("取回与兜底都失败：听写保留文字历史，不假确认交付", async () => {
  const h = await harness({ settings: { polish: "raw" } });
  try {
    h.intercept("voice.deliver.commit", () => ({ committed: false, reason: "not_received" }));
    h.intercept("voice.deliver.present-takeback", rejectWith("TEST_WINDOW_UNAVAILABLE"));
    h.intercept("voice.command.present-answer", rejectWith("TEST_WINDOW_UNAVAILABLE"));
    const sessionId = await runCommand(h, "com.reai.voice.toggle-input");
    await until(() => h.answers().length === 1, "取回失败已尝试兜底");
    await settle();
    expect(h.host.voiceInputRequests.filter(request => request.method === "voice.acknowledge-result"
      && (request.params as {sessionId?: string}).sessionId === sessionId)).toHaveLength(0);
    expect((await inputHistory(h))[0]!.transcript).toBeTruthy();
  } finally { await h.dispose(); }
});
