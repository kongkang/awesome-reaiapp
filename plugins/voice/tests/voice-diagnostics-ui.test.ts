/**
 * §6.0（#waiting-failure-minimum）在 Voice 页面上的呈现：等待说清步骤与已用时间，失败给真实错误码、
 * 原文、两端版本与「查看诊断」，诊断能一键复制（口径照 #941 KernelDiagnostics）。
 */
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  createDefaultVoiceViewState,
  type VoiceCommandHistoryItem,
  type VoiceHistoryItem,
  type VoiceViewState,
} from "../src/data";
import { mountVoiceView, type VoiceViewActions } from "../src/voice-view";
import { setVoiceLocale } from "../src/voice-i18n";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { tickVoiceElapsed, VOICE_PLUGIN_VERSION } from "../src/voice-diagnostics";
import { createVoiceDiagnosticsStore, voiceDiagnosticsBlock } from "../src/voice-diagnostics-view";

let ownsDom = false;
beforeAll(() => { if (typeof document === "undefined") { GlobalRegistrator.register(); ownsDom = true; } });
afterAll(() => { if (ownsDom) GlobalRegistrator.unregister(); });
beforeEach(() => { document.body.replaceChildren(); setVoiceLocale("zh"); });

const HOST = { state: "ready" as const, version: "1.0.0-rc.1" };

function mount(overrides: Partial<VoiceViewState>, extra: Partial<VoiceViewActions> = {}) {
  const root = document.createElement("div");
  document.body.append(root);
  const copies: string[] = [];
  let copyFailure: unknown;
  const actions = {
    onCopyText: async (text: string) => {
      if (copyFailure) throw copyFailure;
      copies.push(text);
    },
    onToggle: async () => undefined,
    onCommandToggle: async () => undefined,
    onOpenSystemTask: async () => undefined,
    onRefresh: async () => undefined,
    onSettingsChanged: async () => undefined,
    onDownloadModel: async () => undefined,
    onCancelModelDownload: async () => undefined,
    onMarkCommandRead: async () => undefined,
    onSendCommandFollowUp: async () => "task",
    onDictateDraft: async () => ({ phase: "listening" }),
    onDictationResultConsumed: async () => undefined,
    onDictateCancel: async () => undefined,
    onRetryInputTranscription: async () => undefined,
    onLoadReplayAudio: async () => new Blob([new Uint8Array([1])], { type: "audio/wav" }),
    ...extra,
  } as unknown as VoiceViewActions;
  const state = createDefaultVoiceViewState({ hostVersion: HOST, statusLoad: "loaded", ...overrides });
  const view = mountVoiceView(root, state, actions);
  return {
    root, view, state, copies,
    failCopies(cause: unknown) { copyFailure = cause; },
  };
}

const settle = async () => { for (let index = 0; index < 12; index += 1) await Promise.resolve(); await new Promise((r) => setTimeout(r, 5)); };
const click = (element: Element | null | undefined) => (element as HTMLElement).click();

function command(overrides: Partial<VoiceCommandHistoryItem>): VoiceCommandHistoryItem {
  return {
    id: "task-1",
    transcript: "把这句话翻成英文",
    commandId: "voice.command.translate",
    status: "failed",
    createdAt: "2026-09-27T08:00:00.000Z",
    ...overrides,
  };
}

function openChat(root: HTMLElement) {
  click(root.querySelector('[data-voice-tab="command"]'));
  click(root.querySelector(".command-history-item"));
}

test("失败命令：错误码 · 两端版本 · 查看诊断；复制全文只有白名单字段，原文只在展开区", async () => {
  const RAW = "gateway timeout after 30000ms";
  const h = mount({
    commandHistory: [command({
      errorCode: "AI_TIMEOUT",
      userMessage: "翻译没有在 App 限定的时间内完成（超时）。",
      errorRawLength: RAW.length,
      errorSource: "cloud",
      errorHttpStatus: 504,
      failedAt: "2026-09-27T08:00:30.000Z",
    })],
    failureRaw: { "command:task-1": RAW },
  });
  openChat(h.root);
  const block = h.root.querySelector<HTMLElement>(".voice-diag[data-diag-key='chat-failed:task-1']")!;
  expect(block.querySelector(".voice-diag-code")?.textContent).toBe("错误码 AI_TIMEOUT");
  expect(block.querySelector(".voice-diag-versions")?.textContent).toBe(`Voice ${VOICE_PLUGIN_VERSION} · App 1.0.0-rc.1`);
  expect(block.dataset.diagState).toBe("timeout");
  click(block.querySelector(".voice-diag-toggle"));
  const panel = h.root.querySelector<HTMLElement>(".voice-diag[data-diag-key='chat-failed:task-1'] .voice-diag-panel")!;
  // 字段区与复制全文同口径：只写字符数；原文在默认收起的展开区里。
  expect(panel.querySelector("dl")?.textContent).not.toContain(RAW);
  expect(panel.querySelector(".voice-diag-raw")?.textContent).toBe(`原始信息可能含用户内容，已省略（${RAW.length} 字符）`);
  const expander = panel.querySelector<HTMLDetailsElement>(".voice-diag-rawbox")!;
  expect(expander.open).toBeFalse();
  expect(expander.querySelector(".voice-diag-rawtext")?.textContent).toBe(RAW);
  click(panel.querySelector(".voice-diag-copy"));
  await settle();
  expect(h.copies).toHaveLength(1);
  const text = h.copies[0]!;
  expect(text).toContain("当前步骤: 翻译 · 用时 30 秒");
  expect(text).toContain("错误码: AI_TIMEOUT");
  expect(text).toContain(`原始原因: 原始信息可能含用户内容，已省略（${RAW.length} 字符）`);
  expect(text).toContain("错误来源: 云端 (cloud)");
  expect(text).toContain("HTTP 状态码: 504");
  expect(text).toContain("原因（按错误码）: ");
  expect(text).not.toContain(RAW);
  expect(text).toContain(`插件版本: com.reai.voice ${VOICE_PLUGIN_VERSION}`);
  expect(text).toContain("App 版本: 1.0.0-rc.1");
  expect(text).toContain("发生时间: 2026-09-27T08:00:30.000Z");
  expect(text).not.toContain("把这句话翻成英文");
  expect(h.root.querySelector(".voice-diag-feedback")?.textContent).toBe("已复制，可直接粘贴给支持人员");
});

test("复制失败：给出剪贴板异常的码与原因，<pre> 是这次点击时的全文快照", async () => {
  const h = mount({ commandHistory: [command({ errorCode: "AGENT_ENGINE", failedAt: "2026-09-27T08:00:30.000Z" })] });
  h.failCopies(Object.assign(new Error("Document is not focused."), { name: "NotAllowedError" }));
  openChat(h.root);
  click(h.root.querySelector(".voice-diag[data-diag-key='chat-failed:task-1'] .voice-diag-toggle"));
  click(h.root.querySelector(".voice-diag-copy"));
  await settle();
  // 只写异常名（结构化值），不写异常原文。
  expect(h.root.querySelector(".voice-diag-feedback-error")?.textContent).toContain("（NotAllowedError）");
  expect(h.root.querySelector(".voice-diag-feedback-error")?.textContent).not.toContain("Document is not focused.");
  const pre = h.root.querySelector(".voice-diag-fallback")!;
  expect(pre.textContent).toContain("错误码: AGENT_ENGINE");
  expect(pre.textContent).toContain("原始原因: 未记录（旧版本条目）");
  // 被动刷新不收起诊断、不丢快照。
  h.view.update({ ...h.state, commandHistory: [...h.state.commandHistory] });
  expect(h.root.querySelector(".voice-diag-fallback")?.textContent).toBe(pre.textContent);
});

test("运行中不再画成「执行失败」：翻译说「停止翻译」并显示步骤与已用时间，Agent 仍是「停止回答」", () => {
  const since = Date.now() - 12_000;
  const h = mount({
    commandHistory: [command({ status: "running", createdAt: new Date(since).toISOString() })],
  }, { onCancelCommand: async () => undefined } as Partial<VoiceViewActions>);
  openChat(h.root);
  expect(h.root.textContent).not.toContain("执行失败");
  expect(h.root.querySelector(".chat-cancel")?.textContent).toBe("停止翻译");
  const running = h.root.querySelector<HTMLElement>(".chat-run-status .voice-diag")!;
  expect(running.dataset.diagState).toBe("waiting");
  expect(running.querySelector(".voice-diag-step")?.textContent).toBe("翻译");
  expect(running.querySelector(".voice-diag-elapsed")?.textContent).toBe("已用 12 秒");
  tickVoiceElapsed(h.root, since + 75_000);
  expect(running.querySelector(".voice-diag-elapsed")?.textContent).toBe("已用 1 分 15 秒");
  expect(running.querySelector(".voice-diag-versions")?.textContent).toContain("App 1.0.0-rc.1");

  const agent = mount({
    commandHistory: [command({ id: "task-2", status: "running", commandId: "voice.command.agent" })],
  }, { onCancelCommand: async () => undefined } as Partial<VoiceViewActions>);
  openChat(agent.root);
  expect(agent.root.querySelector(".chat-cancel")?.textContent).toBe("停止回答");
  setVoiceLocale("en");
  expect(h.root.querySelector(".chat-cancel")?.textContent).toBe("Stop translation");
  expect(agent.root.querySelector(".chat-cancel")?.textContent).toBe("Stop response");
});

test("停止失败按翻译场景说，并带停止请求的真实码", async () => {
  const h = mount({ commandHistory: [command({ status: "running" })] }, {
    onCancelCommand: async () => { throw { code: "AGENT_SESSION_NOT_FOUND" }; },
  } as Partial<VoiceViewActions>);
  openChat(h.root);
  click(h.root.querySelector(".chat-cancel"));
  await settle();
  expect(h.root.querySelector(".chat-send-error")?.textContent).toBe("无法停止翻译，请重试");
  const diag = h.root.querySelector<HTMLElement>(".voice-diag[data-diag-key^='chat-inline:stop']")!;
  expect(diag.querySelector(".voice-diag-code")?.textContent).toBe("错误码 AGENT_SESSION_NOT_FOUND");
});

test("状态读取超时：warn 行带真实码、两端版本与诊断，不只说「请重试」", () => {
  const h = mount({
    statusLoad: "failed",
    statusLoadError: "读取语音状态 8 秒内没有返回（超时），可以重新检查。",
    statusLoadErrorDetail: { step: "statusLoad", code: "VOICE_STATUS_REFRESH_TIMEOUT", at: "2026-09-27T08:00:00.000Z" },
  });
  const row = h.root.querySelector<HTMLElement>(".voice-warn[data-warn='refresh']")!;
  expect(row.querySelector(".voice-diag-code")?.textContent).toBe("错误码 VOICE_STATUS_REFRESH_TIMEOUT");
  expect(row.querySelector<HTMLElement>(".voice-diag")?.dataset.diagState).toBe("timeout");
  expect(row.querySelector(".voice-diag-versions")?.textContent).toBe(`Voice ${VOICE_PLUGIN_VERSION} · App 1.0.0-rc.1`);
});

test("云端选项：请求被拒（无码）不说成「列表为空」；只有真的收到空列表才写这条说明", () => {
  const base = {
    settings: { ...createDefaultVoiceViewState().settings, engine: "cloud" as const },
    commandLoggedIn: true, cloudModelsLoading: false, cloudModelsUnavailable: true, cloudModels: [],
  };
  const rejected = mount({ ...base,
    cloudModelsErrorDetail: { step: "cloudModels", at: "2026-09-27T08:00:00.000Z", raw: "socket closed", rawLength: 13 } });
  click(rejected.root.querySelector(".voice-warn-row .voice-diag-toggle, [data-diag-key^='warn:cloud-models'] .voice-diag-toggle"));
  const rejectedPanel = rejected.root.querySelector("[data-diag-key^='warn:cloud-models'] .voice-diag-panel")?.textContent ?? "";
  expect(rejectedPanel).not.toContain("列表为空");
  expect(rejectedPanel).toContain("已省略（13 字符）");

  const empty = mount({ ...base,
    cloudModelsErrorDetail: { step: "cloudModels", at: "2026-09-27T08:00:00.000Z", noteKey: "diagnostics.cloudModelsEmpty" } });
  click(empty.root.querySelector("[data-diag-key^='warn:cloud-models'] .voice-diag-toggle"));
  expect(empty.root.querySelector("[data-diag-key^='warn:cloud-models'] .voice-diag-panel")?.textContent)
    .toContain("App 返回的云端识别选项列表为空");
});

test("没有诊断来源的旧错误如实写「未记录」；屏幕上的主句不进复制全文", async () => {
  const h = mount({ error: "发给 agent 失败" });
  const block = h.root.querySelector<HTMLElement>(".voice-error-block .voice-diag")!;
  expect(block.querySelector(".voice-diag-code")?.textContent).toBe("错误码 无");
  click(block.querySelector(".voice-diag-toggle"));
  click(h.root.querySelector(".voice-diag-copy"));
  await settle();
  expect(h.copies[0]).toContain("原始原因: 未记录（旧版本条目）");
  // 主句可能是上游 userMessage（会回显用户内容）：复制全文只收白名单字段。
  expect(h.copies[0]).not.toContain("发给 agent 失败");
});

function input(overrides: Partial<VoiceHistoryItem>): VoiceHistoryItem {
  return {
    id: "input-1", transcript: "明天下午三点开会", language: "zh-CN", source: "board", inserted: false,
    durationMs: 2000, createdAt: "2026-09-27T08:00:00.000Z", ...overrides,
  };
}

test("输入历史：写回与润色两个阶段分别给出真实码；原文只在本次运行可展开，旧条目写「未记录」", async () => {
  const h = mount({
    history: [input({
      warningCode: "not_editable",
      polishFailed: true,
      deliveryFailure: { code: "not_editable", at: "2026-09-27T08:00:02.000Z" },
      polishFailure: { code: "AI_TIMEOUT", rawLength: 28, omittedCodes: 1, at: "2026-09-27T08:00:01.000Z" },
    })],
    failureRaw: { "polish:input-1": "upstream 504 while polishing" },
  });
  click(h.root.querySelector(".task-item"));
  const codes = Array.from(h.root.querySelectorAll(".input-detail .voice-diag-code")).map((node) => node.textContent);
  expect(codes).toEqual(["错误码 not_editable", "错误码 AI_TIMEOUT"]);
  click(h.root.querySelector(".voice-diag[data-diag-key='stage:input-1:polish'] .voice-diag-toggle"));
  const polishPanel = h.root.querySelector(".voice-diag[data-diag-key='stage:input-1:polish'] .voice-diag-panel");
  expect(polishPanel?.querySelector(".voice-diag-rawtext")?.textContent).toBe("upstream 504 while polishing");
  expect(polishPanel?.querySelector("dl")?.textContent).not.toContain("upstream 504");
  expect(polishPanel?.querySelector("dl")?.textContent).toContain("未登记的错误码1 个");

  // 重启后（内存表为空）：只剩字符数，并如实说明原文没保留。
  const restarted = mount({ history: [input({ id: "input-3", polishFailed: true, warningCode: "polish_failed",
    polishFailure: { code: "AI_TIMEOUT", rawLength: 28, at: "2026-09-27T08:00:01.000Z" } })] });
  click(restarted.root.querySelector(".task-item"));
  click(restarted.root.querySelector(".voice-diag[data-diag-key='stage:input-3:polish'] .voice-diag-toggle"));
  expect(restarted.root.querySelector(".voice-diag-rawbox")).toBeNull();
  expect(restarted.root.querySelector(".voice-diag-raw")?.textContent).toContain("重启后不能再展开");

  const legacy = mount({ history: [input({ id: "input-2", warningCode: "focus_changed" })] });
  click(legacy.root.querySelector(".task-item"));
  click(legacy.root.querySelector(".voice-diag[data-diag-key='stage:input-2:legacy'] .voice-diag-toggle"));
  expect(legacy.root.querySelector(".voice-diag-panel")?.textContent).toContain("未记录（旧版本条目）");
});

test("重新转写失败：Host 回执的码与用时；Host 不给原文时如实写「App 未提供」", () => {
  const h = mount({
    history: [input({
      id: "input-3", transcript: "", recordingId: "rec-3", recordingWallStartMs: Date.now() - 1000, transcriptionStatus: "failed",
      savedInput: {
        attemptId: "attempt-9", revision: 2, state: "failed", startedAtMs: 1_000, finishedAtMs: 8_000, errorCode: "AI_UNAVAILABLE",
        selection: { engine: "cloud", modelId: "transcribe-free", language: "zh-CN", punctEnabled: true, modelName: "Free" },
      },
    })],
  });
  click(h.root.querySelector(".task-item"));
  const block = h.root.querySelector<HTMLElement>(".voice-retry-panel .voice-diag")!;
  expect(block.querySelector(".voice-diag-code")?.textContent).toBe("错误码 AI_UNAVAILABLE");
  expect(block.querySelector(".voice-diag-elapsed")?.textContent).toBe("用时 7 秒");
  click(block.querySelector(".voice-diag-toggle"));
  expect(h.root.querySelector(".voice-retry-panel .voice-diag-panel")?.textContent).toContain("App 未提供原始原因");
  // §6.0 ④：展开的诊断区与复制全文一样列出日志位置。
  const terms = Array.from(h.root.querySelectorAll(".voice-retry-panel .voice-diag-panel dt")).map((node) => node.textContent);
  expect(terms).toContain("日志位置");
});

test("页头活动行：等待从第 0 秒就有版本与诊断入口，10 秒后由计时器切到强调样式", () => {
  const h = mount({ phase: "recognizing", sessionId: "s-1" });
  const row = h.root.querySelector<HTMLElement>(".voice-activity")!;
  expect(row.querySelector(".voice-diag-step")?.textContent).toBe("识别中");
  expect(row.querySelector(".voice-diag-versions")?.textContent).toContain("App 1.0.0-rc.1");
  expect(row.querySelector(".voice-diag-toggle")).not.toBeNull();
  expect(row.dataset.slow).toBeUndefined();
  const since = Number(row.querySelector<HTMLElement>("[data-voice-elapsed-since]")!.dataset.voiceElapsedSince);
  tickVoiceElapsed(h.root, since + 11_000);
  expect(row.dataset.slow).toBe("true");
  expect(row.querySelector(".voice-diag-elapsed")?.textContent).toBe("已等待至少 11 秒（自打开页面起）");
  expect(h.root.querySelector(".voice-cap-elapsed")?.textContent).toBe(" · 11 秒");
});

test("活动行默认安静：版本与诊断入口带隐藏类、CSS 只在慢阈值后显出（2026-09-30 用户反馈）", () => {
  const h = mount({ phase: "recognizing", sessionId: "s-1" });
  const row = h.root.querySelector<HTMLElement>(".voice-activity")!;
  // 版本、分隔点与「查看诊断」都标安静类：DOM 常在（慢时无需重渲染），平时由 CSS 藏起。
  expect(row.querySelector(".voice-diag-versions")?.classList.contains("voice-diag-quiet")).toBeTrue();
  expect(row.querySelector(".voice-diag-toggle")?.classList.contains("voice-diag-quiet")).toBeTrue();
  expect(row.dataset.voiceSlowScope).toBe("true");
  const css = readFileSync(resolve(import.meta.dir, "../src/voice.css"), "utf8");
  expect(css).toMatch(/\.voice-diag-quiet\s*\{\s*display:\s*none;/);
  expect(css).toContain('.voice-diag[data-slow="true"] .voice-diag-quiet');
});

test("录音中的活动行永不弹诊断入口：没有慢阈值，录再久也不强调", () => {
  const h = mount({ phase: "listening", sessionId: "s-2" });
  const row = h.root.querySelector<HTMLElement>(".voice-activity")!;
  expect(row.querySelector(".voice-diag-step")?.textContent).toBe("录音中");
  expect(row.querySelector(".voice-diag-versions")?.classList.contains("voice-diag-quiet")).toBeTrue();
  expect(row.querySelector(".voice-diag-toggle")?.classList.contains("voice-diag-quiet")).toBeTrue();
  // 录音不是卡住的等待：没有慢阈值作用域，计时器扫一分钟也不会打 data-slow。
  expect(row.dataset.voiceSlowScope).toBeUndefined();
  const since = Number(row.querySelector<HTMLElement>("[data-voice-elapsed-since]")!.dataset.voiceElapsedSince);
  tickVoiceElapsed(h.root, since + 61_000);
  expect(row.dataset.slow).toBeUndefined();
});

test("安静模式只对等待态生效：失败态即使传了 quiet，版本与入口也立刻可见（§6.0 底线）", () => {
  const store = createVoiceDiagnosticsStore();
  const block = voiceDiagnosticsBlock({
    key: "unit:failed",
    entry: { state: "failed", step: () => "识别", code: "AI_UNAVAILABLE", sinceMs: 1_000, endMs: 8_000 },
    host: () => HOST,
    store,
    copy: async () => undefined,
    rerender: () => undefined,
    quiet: true,
  });
  expect(block.querySelector(".voice-diag-versions")?.classList.contains("voice-diag-quiet")).toBeFalse();
  expect(block.querySelector(".voice-diag-toggle")?.classList.contains("voice-diag-quiet")).toBeFalse();
});

test("诊断区里手动选中的文字，被动刷新后按同一诊断 key 选回", async () => {
  const h = mount({ commandHistory: [command({ errorCode: "AGENT_ENGINE", failedAt: "2026-09-27T08:00:30.000Z" })] });
  h.failCopies(new Error("clipboard denied"));
  openChat(h.root);
  click(h.root.querySelector(".voice-diag[data-diag-key='chat-failed:task-1'] .voice-diag-toggle"));
  click(h.root.querySelector(".voice-diag-copy"));
  await settle();
  const pre = h.root.querySelector(".voice-diag-fallback")!;
  const range = document.createRange();
  range.setStart(pre.firstChild!, 5);
  range.setEnd(pre.firstChild!, 25);
  document.getSelection()!.removeAllRanges();
  document.getSelection()!.addRange(range);
  const selected = document.getSelection()!.toString();
  h.view.update({ ...h.state, commandHistory: [...h.state.commandHistory] });
  const next = h.root.querySelector(".voice-diag-fallback")!;
  expect(next).not.toBe(pre);
  // 选区落在新的 <pre> 里（不是已被替换掉的旧节点），且选中的是同一段文字。
  expect(next.contains(document.getSelection()!.anchorNode)).toBeTrue();
  expect(document.getSelection()!.toString()).toBe(selected);
});
