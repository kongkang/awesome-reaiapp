import { afterAll, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { MockHost } from "@reai/app-test/v1";
import type { AppContext, AgentServiceEvent, AgentSessionClient, AgentTurnRef, AgentTurnResult } from "@reai/app-sdk/v1";
import manifest from "../app.manifest.json";
import { COMMAND_HISTORY_KEY, DEFAULT_SETTINGS, type VoiceCommandHistoryItem } from "../src/data";
import { setVoiceLocale } from "../src/voice-i18n";

type VoiceTaskSnapshot = Parameters<AppContext["voiceCommand"]["presentTask"]>[0];

/*
  回合等你拍板（Host wait.started / wait.ended）：Voice 自己呈现胶囊（caller），
  等人旗与「等待你授权：…」只能由本插件的 present-task 帧带上；对话页写明在等什么、已等多久；
  回合结束（同意后完成 / 拒绝后失败）时终态帧不带等人旗，对话页的等待提示随之消失。
*/
let ownsDom = false;
beforeAll(() => { if (typeof document === "undefined") { GlobalRegistrator.register(); ownsDom = true; } });
afterAll(() => { if (ownsDom) GlobalRegistrator.unregister(); });

const SESSION = "agent2-voice-wait";
const LABEL = "启用浏览器插件以联网";
const doneFor = (ref: AgentTurnRef): AgentTurnResult => ({ schemaVersion: 2, ...ref, runtime: "dsh", channel: "external-brain", status: "completed", text: "Weather answer", content: [{ type: "text", text: "Weather answer" }], usage: null, toolAttempts: [], failure: null } as AgentTurnResult);
const declinedFor = (ref: AgentTurnRef) => ({ ...doneFor(ref), status: "failed", text: null, content: [], failure: { kind: "engine", code: "WEB_ACCESS_DECLINED", stage: "tool", retry: "new-turn", message: "user declined" } } as unknown as AgentTurnResult);

async function until(predicate: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 2500;
  while (!await predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  expect(await predicate()).toBeTrue();
}

interface Options {
  /** 首个 presentTask 调用挂住，直到测试手动放行。 */
  holdFirstPresent?: boolean;
}

async function setup(options: Options = {}) {
  document.body.replaceChildren();
  let context!: AppContext;
  let emitAgentEvent: Parameters<AppContext["events"]["onLocalAgent"]>[0] | undefined;
  const turns: AgentTurnRef[] = [];
  const finishers = new Map<string, (value: AgentTurnResult) => void>();
  const frames: VoiceTaskSnapshot[] = [];
  let releaseFirstPresent: (() => void) | undefined;
  let presentCalls = 0;
  // 同一模块跨停用 / 再激活复用：模块级状态才会被真正检验。
  let appModule: Promise<{ default: Record<string, unknown> }> | undefined;
  const host = new MockHost({
    manifest: structuredClone(manifest) as never,
    loadApp: async () => {
      appModule ??= import("../src/app?agent-wait=" + crypto.randomUUID());
      const { default: app } = await appModule as { default: { activate(ctx: AppContext): Promise<void> } };
      return { default: { ...app, async activate(ctx: AppContext) {
        context = ctx;
        const onLocalAgent = ctx.events.onLocalAgent.bind(ctx.events);
        ctx.events.onLocalAgent = (handler) => { emitAgentEvent = handler; return onLocalAgent(handler); };
        const store = ctx.storage.private("voice-state");
        await store.set("recognition-engine-choice-v1", "local");
        await store.set("settings", { ...DEFAULT_SETTINGS, polish: "raw" });
        const running = (ref: AgentTurnRef) => ({ schemaVersion: 2 as const, ...ref, runtime: "dsh" as const, status: "running" as const, expired: false, result: null, createdAt: 1, updatedAt: 1 });
        Object.assign(ctx.agent, {
          createSession: async () => ({ schemaVersion: 2, sessionId: SESSION, runtime: "dsh", backend: "dsh" }),
          listSessions: async () => ({ sessions: [{ sessionId: SESSION, runtime: "dsh", backend: "dsh", memory: "session", createdMs: 1, updatedMs: 1, stale: false }] }),
          startTurn: async (_input: Parameters<AgentSessionClient["startTurn"]>[0]) => {
            const ref = { sessionId: SESSION, turnId: `native-wait-turn-${turns.length + 1}` };
            turns.push(ref);
            return running(ref);
          },
          events: async (ref: AgentTurnRef) => ({ ...running(ref), events: [], gap: false, nextSequence: 0 }),
          waitForTurn: async (ref: AgentTurnRef) => new Promise<AgentTurnResult>(resolve => { finishers.set(ref.turnId, resolve); }),
          cancel: async () => ({ cancelled: true }),
        });
        Object.assign(ctx.voiceCommand, {
          presentTask: async (frame: VoiceTaskSnapshot) => {
            presentCalls += 1;
            if (options.holdFirstPresent && presentCalls === 1) await new Promise<void>(resolve => { releaseFirstPresent = resolve; });
            frames.push(structuredClone(frame));
          },
          dismissTask: async () => undefined,
        });
        return app.activate(ctx);
      } } };
    },
    createRoot: () => { const root = document.createElement("div"); document.body.append(root); return root; },
  });
  await host.installAndEnable();
  let sequence = 0;
  const emit = (ref: AgentTurnRef, event: Record<string, unknown>) => {
    expect(emitAgentEvent).toBeDefined();
    sequence += 1;
    emitAgentEvent!({ schemaVersion: 2, ...ref, runtime: "dsh", sequence, timestamp: Date.now(), ...event } as unknown as AgentServiceEvent as never);
  };
  const turn = (index = 0) => turns[index]!;
  const waitStarted = (waitId: string, ref = turn()) => emit(ref, {
    type: "wait.started", kind: "waiting_user", waitId, reason: "browser_plugin_required", label: LABEL,
    action: { type: "tool-dependency", toolName: "web_search", appId: "com.reai.browser" }, startedAt: Date.now() - 42_000,
  });
  const waitEnded = (waitId: string, outcome: "granted" | "declined" | "cancelled", ref = turn()) => emit(ref, {
    type: "wait.ended", kind: "waiting_user", waitId, reason: "browser_plugin_required", outcome, waitedMs: 42_000,
  });
  const history = async () => await context.storage.private("voice-state").get<VoiceCommandHistoryItem[]>(COMMAND_HISTORY_KEY) ?? [];
  const openChat = async (index = 0) => {
    const { root } = await host.openSurface("main");
    root!.querySelector<HTMLButtonElement>('[data-voice-tab="command"]')!.click();
    await until(() => root!.querySelectorAll(".command-history-item").length > index);
    root!.querySelectorAll<HTMLButtonElement>(".command-history-item")[index]!.click();
    return root!;
  };
  const finish = (result: (ref: AgentTurnRef) => AgentTurnResult, index = 0) => finishers.get(turn(index).turnId)!(result(turn(index)));
  const framesOf = (index = 0) => {
    // 第 index 个回合的帧：按首次出现的 taskId 顺序对应回合顺序。
    const ids = [...new Set(frames.map(frame => frame.taskId))];
    return frames.filter(frame => frame.taskId === ids[index]);
  };
  return {
    host, frames, framesOf, waitStarted, waitEnded, history, openChat, finish, turns,
    ready: (count = 1) => finishers.size >= count,
    releaseFirstPresent: () => releaseFirstPresent?.(),
    firstPresentHeld: () => releaseFirstPresent !== undefined,
  };
}

type Fixture = Awaited<ReturnType<typeof setup>>;

async function startAgent(f: Fixture, count = 1) {
  f.host.setNextVoiceCommandTranscript("weather question");
  await f.host.invokeCommand("com.reai.voice.command.agent");
  await f.host.invokeCommand("com.reai.voice.command.agent");
  await until(() => f.ready(count));
  // 回合被 Host 受理后事件才会路由到这次运行。
  await new Promise(resolve => setTimeout(resolve, 20));
}

async function startBackgroundedAgent(f: Fixture, beforeBackground?: () => void, count = 1) {
  await startAgent(f, count);
  beforeBackground?.();
  await new Promise(resolve => setTimeout(resolve, 3100)); // 3 秒闸：转入后台，Host 胶囊出现。
  await until(() => f.framesOf(count - 1).some(frame => frame.state === "running"));
}

test("等你拍板期间胶囊带等人旗并写明在等什么，同意后恢复原阶段，完成帧不带等人旗", async () => {
  const f = await setup();
  try {
    // 3 秒内就开始等：转后台那一帧直接带上等人旗。
    await startBackgroundedAgent(f, () => f.waitStarted("wait-1"));
    const backgrounded = f.frames.find(frame => frame.state === "running")!;
    expect(backgrounded).toMatchObject({ waiting: true, stageLabel: `等待你授权：${LABEL}` });

    // 对话页：写明在等什么与已等时长的状态；入口仍是既有的安装卡片。
    const root = await f.openChat();
    await until(() => root.querySelector(".chat-approval-status")?.textContent === `等待你授权：${LABEL}`);
    expect(root.textContent).toContain("等你拍板（不计入超时）");

    f.waitEnded("wait-1", "granted");
    await until(() => f.frames.at(-1)?.waiting === false);
    expect(f.frames.at(-1)).toMatchObject({ state: "running", waiting: false, stageLabel: "Agent 正在处理" });
    await until(() => root.querySelector(".chat-approval-status") === null);

    f.finish(doneFor);
    await until(() => f.frames.at(-1)?.state === "succeeded");
    expect(f.frames.at(-1)!.waiting).toBe(false);
  } finally { await f.host.disable(); }
});

test("拒绝后回合以真实原因失败：终态帧不带等人旗，未收到 wait.ended 的等待提示随回合结束消失", async () => {
  const f = await setup();
  try {
    await startBackgroundedAgent(f);
    expect(f.frames.find(frame => frame.state === "running")!.waiting).not.toBe(true);
    const root = await f.openChat();
    // 已在后台时开始等：立即补一帧等人旗。
    f.waitStarted("wait-2");
    await until(() => f.frames.at(-1)?.waiting === true);
    expect(f.frames.at(-1)).toMatchObject({ state: "running", stageLabel: `等待你授权：${LABEL}` });
    await until(() => root.querySelector(".chat-approval-status") !== null);

    // Host 来不及补发 wait.ended 就给出失败结果：插件侧同样视为等待结束。
    f.finish(declinedFor);
    await until(() => f.frames.at(-1)?.state === "failed");
    expect(f.frames.at(-1)!.waiting).toBe(false);
    await until(async () => (await f.history()).some(item => item.status === "failed"));
    await until(() => root.querySelector(".chat-approval-status") === null);
  } finally { await f.host.disable(); }
});

test("首帧还在发送时开始等：等待变化排在首帧之后补上，不会丢", async () => {
  const f = await setup({ holdFirstPresent: true });
  try {
    await startAgent(f);
    await new Promise(resolve => setTimeout(resolve, 3100));
    await until(f.firstPresentHeld);
    f.waitStarted("wait-1");
    f.releaseFirstPresent();
    await until(() => f.frames.length >= 2);
    expect(f.frames[0]!.waiting).not.toBe(true);
    expect(f.frames.at(-1)).toMatchObject({ state: "running", waiting: true, stageLabel: `等待你授权：${LABEL}` });
  } finally { await f.host.disable(); }
});

test("结束事件先到、开始事件晚到：同一等待不会复活", async () => {
  const f = await setup();
  try {
    await startBackgroundedAgent(f);
    const before = f.frames.length;
    f.waitEnded("wait-1", "granted");
    f.waitStarted("wait-1");
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(f.frames.slice(before).some(frame => frame.waiting === true)).toBeFalse();
    const root = await f.openChat();
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(root.querySelector(".chat-approval-status")).toBeNull();
  } finally { await f.host.disable(); }
});

test("两个回合各自的 wait-1 互不覆盖：一个结束不影响另一个仍在等", async () => {
  const f = await setup();
  try {
    await startBackgroundedAgent(f);
    f.waitStarted("wait-1", f.turns[0]);
    await until(() => f.framesOf(0).at(-1)?.waiting === true);
    await startBackgroundedAgent(f, undefined, 2);
    f.waitStarted("wait-1", f.turns[1]);
    await until(() => f.framesOf(1).at(-1)?.waiting === true);

    f.waitEnded("wait-1", "granted", f.turns[0]);
    await until(() => f.framesOf(0).at(-1)?.waiting === false);
    expect(f.framesOf(1).at(-1)!.waiting).toBe(true);
    // 第二个回合（列表最新在前）的对话页仍写着在等。
    const root = await f.openChat(0);
    await until(() => root.querySelector(".chat-approval-status")?.textContent === `等待你授权：${LABEL}`);
  } finally { await f.host.disable(); }
}, 20_000);

test("停用后再激活：上一个 Surface 的等待提示不残留", async () => {
  const f = await setup();
  try {
    await startBackgroundedAgent(f);
    f.waitStarted("wait-1");
    await until(() => f.frames.at(-1)?.waiting === true);
    await f.host.disable();
    await f.host.installAndEnable();
    const root = await f.openChat();
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(root.querySelector(".chat-approval-status")).toBeNull();
  } finally { await f.host.disable(); }
});

test("英文界面：已知原因用插件自己的文案，不显示 Host 的中文说明", async () => {
  const f = await setup();
  setVoiceLocale("en");
  try {
    await startBackgroundedAgent(f, () => f.waitStarted("wait-1"));
    expect(f.frames.find(frame => frame.state === "running")).toMatchObject({
      waiting: true, stageLabel: "Waiting for you: Enable the Browser plugin to go online",
    });
  } finally {
    setVoiceLocale("zh-CN");
    await f.host.disable();
  }
});
