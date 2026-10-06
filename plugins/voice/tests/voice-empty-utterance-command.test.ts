/**
 * 空话不发请求（2026-09-29 真机反馈，2.14.4-rc.1）：Agent 命令识别出来是空的、只有标点与语气词、
 * 或只剩一个字时，不建 Agent 会话、不调模型、不写历史、不弹结果面板；中央胶囊给一句提示后收起，
 * Voice 页给一句「你刚才没有说话」，诊断只带固定码与版本，不带用户说的话。
 * 转文本（输入法）保持原样：只有完全为空才不写入，一个字照写。
 * 判定规则本身见 voice-utterance.test.ts。
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
} from "../src/data";
import { setVoiceLocale, t } from "../src/voice-i18n";
import { VOICE_PLUGIN_VERSION } from "../src/voice-diagnostics";

let ownsDom = false;
beforeAll(() => {
  if (typeof document === "undefined") { GlobalRegistrator.register(); ownsDom = true; }
  setVoiceLocale("zh");
});
afterAll(() => { if (ownsDom) GlobalRegistrator.unregister(); });

async function until(check: () => boolean, message: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  expect(check(), message).toBeTrue();
}
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

type Wire = { handleRequest(method: string, params: Record<string, unknown>): Promise<unknown> };

/** 真正「请求了 Agent」的调用：建会话、发回合（新旧两代接口）。就绪检查、列表等只读调用不算。 */
const AGENT_WORK = /^agent\.(v2\.)?(session\.create|turn\.start|session\.send)$/;

const NOT_MODEL_CALLS = new Set(["ai.audio.transcribe", "ai.models.list", "ai.cancel"]);

async function harness(settings: Partial<VoiceInputSettings> = {}) {
  document.body.replaceChildren();
  let context: AppContext | undefined;
  const host = new MockHost({
    manifest: structuredClone(manifest) as never,
    loadApp: async () => {
      const { default: app } = await import(`../src/app?empty-utterance=${crypto.randomUUID()}`);
      return { default: { ...app, async activate(ctx: AppContext) {
        context = ctx;
        const store = ctx.storage.private("voice-state");
        await store.set("recognition-engine-choice-v1", settings.engine ?? "local");
        await store.set("settings", { ...DEFAULT_SETTINGS, polish: "raw", ...settings });
        await store.set(POLISH_LIGHT_DEFAULT_MIGRATION_KEY, 1);
        await store.set("voice-feature-settings-v1", { ...DEFAULT_VOICE_FEATURE_SETTINGS, cloudModelId: "transcribe-free", translationTarget: "zh-CN" });
        return app.activate(ctx);
      } } };
    },
    createRoot: () => { const root = document.createElement("div"); document.body.append(root); return root; },
  });
  const wire = host as unknown as Wire;
  const original = wire.handleRequest.bind(host);
  const clipboard: string[] = [];
  const acks: Array<{ sessionId?: string; at: number }> = [];
  wire.handleRequest = async (method, params) => {
    if (method === "environment.get") return { developerMode: true };
    if (method === "clipboard.writeText") clipboard.push(String(params.text));
    if (method === "voice.acknowledge-result") acks.push({ sessionId: params.sessionId as string | undefined, at: Date.now() });
    return await original(method, params);
  };
  await host.installAndEnable();
  const cloud = (method: string) => host.cloudRequests.filter(request => request.method === method);
  const command = (method: string) => host.voiceCommandRequests.filter(request => request.method === method);
  return {
    host,
    clipboard,
    acks,
    agentWork: () => host.agentRequests.filter(request => AGENT_WORK.test(request.method)),
    /** 模型调用：除云端转写（识别本身）、模型清单与取消以外的一切 ai.*。 */
    modelCalls: () => host.cloudRequests.filter(request => request.method.startsWith("ai.") && !NOT_MODEL_CALLS.has(request.method)),
    transcribes: () => cloud("ai.audio.transcribe"),
    commits: () => cloud("voice.deliver.commit").map(request => request.params as { text?: string }),
    takebacks: () => cloud("voice.deliver.present-takeback"),
    answers: () => command("voice.command.present-answer"),
    tasks: () => command("voice.command.present-task"),
    history: async () => await context!.storage.private("voice-state").get<VoiceCommandHistoryItem[]>(COMMAND_HISTORY_KEY) ?? [],
    dispose: async () => { try { await host.disable(); } finally { wire.handleRequest = original; } },
  };
}
type Harness = Awaited<ReturnType<typeof harness>>;

/** 按一次开始、再按一次结束；返回这次录音的 sessionId 与结束那一刻的时间。 */
async function speak(h: Harness, eventId: string): Promise<{ sessionId: string; finishedAt: number }> {
  const started = await h.host.invokeCommand(eventId);
  expect(started.ok).toBeTrue();
  const sessionId = (started.ok ? started.output as { sessionId?: string } : undefined)?.sessionId;
  expect(sessionId).toBeString();
  const finishedAt = Date.now();
  await h.host.invokeCommand(eventId);
  return { sessionId: sessionId!, finishedAt };
}

async function expectNothingSent(h: Harness, sessionId: string) {
  await until(() => h.acks.some(ack => ack.sessionId === sessionId), "没发请求也要确认原录音会话，收起中央胶囊");
  await sleep(60);
  expect(h.agentWork()).toHaveLength(0);
  expect(h.modelCalls()).toHaveLength(0);
  expect(h.commits()).toHaveLength(0);
  expect(h.answers()).toHaveLength(0);
  expect(h.tasks()).toHaveLength(0);
  expect(h.takebacks()).toHaveLength(0);
  expect(await h.history()).toHaveLength(0);
}

for (const [label, eventId] of [
  ["Agent", "com.reai.voice.command.agent"],
  ["通用命令键（默认 Agent）", "com.reai.voice.toggle-command"],
] as const) {
  for (const [kind, transcript] of [
    ["没说话（按键很短 / 识别为空）", ""],
    ["只有标点", "。。。"],
    ["只有语气词", "嗯。"],
    ["只有叠词语气词", "噢噢"],
    ["只剩一个字", "好"],
  ] as const) {
    test(`${label}：${kind}时不请求 Agent、不调模型、不写历史、不弹面板`, async () => {
      const h = await harness();
      try {
        h.host.setNextVoiceCommandTranscript(transcript);
        const { sessionId } = await speak(h, eventId);
        await expectNothingSent(h, sessionId);
      } finally { await h.dispose(); }
    });
  }
}

test("云端识别：转写回来只有语气词时同样不请求 Agent（转写本身照常）", async () => {
  const h = await harness({ engine: "cloud" });
  try {
    h.host.setNextAiAudioTranscribeText("嗯……");
    const { sessionId } = await speak(h, "com.reai.voice.command.agent");
    await until(() => h.transcribes().length === 1, "云端先转写");
    await expectNothingSent(h, sessionId);
  } finally { await h.dispose(); }
});

test("对照：正常一句话照常请求 Agent", async () => {
  const h = await harness();
  try {
    h.host.setNextVoiceCommandTranscript("帮我查一下明天的天气");
    await speak(h, "com.reai.voice.command.agent");
    await until(() => h.answers().length === 1, "正常句子走 Agent 并出结果面板");
    expect(h.agentWork().length).toBeGreaterThan(0);
  } finally { await h.dispose(); }
});

test("对照：语气词片段拼得出来的正常英文词（mum）照常请求 Agent", async () => {
  const h = await harness();
  try {
    h.host.setNextVoiceCommandTranscript("mum");
    await speak(h, "com.reai.voice.command.agent");
    await until(() => h.answers().length === 1, "mum 不是空话，走 Agent 并出结果面板");
    expect(h.agentWork().length).toBeGreaterThan(0);
  } finally { await h.dispose(); }
});

test("转文本保持原样：一个字照写，完全为空不写", async () => {
  const h = await harness();
  try {
    h.host.setNextVoiceCommandTranscript("好");
    await speak(h, "com.reai.voice.command.transcribe");
    await until(() => h.commits().length === 1, "一个字也照常写入");
    expect(h.commits()[0]!.text).toBe("好");

    h.host.setNextVoiceCommandTranscript("");
    const { sessionId } = await speak(h, "com.reai.voice.command.transcribe");
    await until(() => h.acks.some(ack => ack.sessionId === sessionId), "空结果收起胶囊");
    await sleep(60);
    expect(h.commits()).toHaveLength(1);
    expect(h.agentWork()).toHaveLength(0);
  } finally { await h.dispose(); }
});

test("胶囊：Host 显示「没有听清」时停留一会儿再收；识别出一个字时立刻收（不让「处理中」挂着）", async () => {
  const h = await harness();
  try {
    h.host.setNextVoiceCommandTranscript("");
    const empty = await speak(h, "com.reai.voice.command.agent");
    await sleep(400);
    expect(h.acks.some(ack => ack.sessionId === empty.sessionId), "识别为空：先让「没有听清」停留，不能秒收").toBeFalse();
    await until(() => h.acks.some(ack => ack.sessionId === empty.sessionId), "提示停留后收起");
    const held = h.acks.find(ack => ack.sessionId === empty.sessionId)!.at - empty.finishedAt;
    expect(held).toBeGreaterThanOrEqual(1000);

    h.host.setNextVoiceCommandTranscript("好");
    const trivial = await speak(h, "com.reai.voice.command.agent");
    await until(() => h.acks.some(ack => ack.sessionId === trivial.sessionId), "只剩一个字立刻收起", 400);
    expect(h.agentWork()).toHaveLength(0);
  } finally { await h.dispose(); }
});

test("Voice 页：给出「你刚才没有说话」；复制诊断只有固定码与版本，不含用户说的话", async () => {
  const h = await harness();
  try {
    // Voice 页开着时说话（页面打开那一刻的状态刷新会清掉旧提示，这是既有行为）。
    const main = await h.host.openSurface("main");
    const root = main.root!;
    await sleep(100);
    // 生僻单字，好确认它没有出现在任何诊断里。
    h.host.setNextVoiceCommandTranscript("㗊");
    const { sessionId } = await speak(h, "com.reai.voice.command.agent");
    await expectNothingSent(h, sessionId);
    const message = t("app.emptyUtteranceNotSent");
    expect(message).not.toBe("app.emptyUtteranceNotSent");
    await until(() => root.querySelector(".inline-error")?.textContent === message, "Voice 页显示没有说话的提示");
    const toggle = () => root.querySelector<HTMLButtonElement>(".voice-error-block .voice-diag-toggle");
    await until(() => toggle() !== null, "提示挂诊断");
    toggle()!.click();
    const copy = () => root.querySelector<HTMLButtonElement>(".voice-error-block .voice-diag-copy");
    await until(() => copy() !== null, "诊断可复制");
    copy()!.click();
    await until(() => h.clipboard.length === 1, "复制诊断写入剪贴板");
    const copied = h.clipboard[0]!;
    expect(copied).toContain("VOICE_EMPTY_UTTERANCE");
    expect(copied).toContain(VOICE_PLUGIN_VERSION);
    expect(copied).not.toContain("㗊");
  } finally { await h.dispose(); }
});


for (const transcript of ["", " \t", "。。。", "嗯嗯嗯", "嗯，嗯", "呃…嗯…呃…", "uh um"]) {
  test(`翻译过滤纯填充 ${JSON.stringify(transcript)}，仍确认录音会话`, async () => {
    const h = await harness();
    try {
      h.host.setNextVoiceCommandTranscript(transcript);
      const { sessionId } = await speak(h, "com.reai.voice.command.translate");
      await expectNothingSent(h, sessionId);
    } finally { await h.dispose(); }
  });
}
for (const transcript of ["嗯。", "嗯嗯", "mhm", "好", "不", "I", "0", "mum", "嗯，明天开会"]) {
  test(`翻译保留确认或有效短句 ${JSON.stringify(transcript)}`, async () => {
    const h = await harness();
    try {
      h.host.setNextVoiceCommandTranscript(transcript);
      await speak(h, "com.reai.voice.command.translate");
      await until(() => h.commits().length === 1, "翻译完成后写回结果");
      const turns = h.agentWork().filter(request => /turn\.start|session\.send$/.test(request.method));
      expect(turns).toHaveLength(1);
      expect(JSON.stringify(turns[0]!.params)).toContain(transcript);
      expect(h.modelCalls()).toHaveLength(0);
      await sleep(30);
      expect((await h.history())[0]?.transcript).toBe(transcript);
    } finally { await h.dispose(); }
  });
}


test("翻译过滤填充词的提示不推断用户没有说话", async () => {
  const h = await harness();
  try {
    const main = await h.host.openSurface("main");
    await sleep(100);
    h.host.setNextVoiceCommandTranscript("呃…嗯…呃…");
    const { sessionId } = await speak(h, "com.reai.voice.command.translate");
    await expectNothingSent(h, sessionId);
    expect(main.root!.querySelector(".inline-error")?.textContent).toBe("未识别到可翻译内容，这次没有发送");
  } finally { await h.dispose(); }
});
