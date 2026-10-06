/**
 * 代码审查（C5、C7、W1–W4、W7）的回归：中断恢复不删记录、异常时间不让详情页崩、
 * 选区按字段选回、新尝试不混用旧回执、两阶段失败都在、多天总结失败互不覆盖、冻结用时跟随语言。
 */
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { KeyValueStore } from "@reai/app-sdk/v1";
import {
  COMMAND_HISTORY_KEY,
  MAX_HISTORY_STORE_BYTES,
  VoiceStateRepository,
  createDefaultVoiceViewState,
  type VoiceCommandHistoryItem,
  type VoiceHistoryItem,
  type VoiceViewState,
} from "../src/data";
import { mountVoiceView, type VoiceViewActions } from "../src/voice-view";
import { setVoiceLocale } from "../src/voice-i18n";
import { tickVoiceElapsed } from "../src/voice-diagnostics";

let ownsDom = false;
beforeAll(() => { if (typeof document === "undefined") { GlobalRegistrator.register(); ownsDom = true; } });
afterAll(() => { if (ownsDom) GlobalRegistrator.unregister(); });
beforeEach(() => { document.body.replaceChildren(); setVoiceLocale("zh"); });

function storeWith(values: Record<string, unknown> = {}): KeyValueStore {
  const data = new Map(Object.entries(values));
  return {
    async compareAndSet(key, expected, value) {
      if (data.has(key) !== (expected !== undefined)
        || (data.has(key) && JSON.stringify(data.get(key)) !== JSON.stringify(expected))) return false;
      data.set(key, structuredClone(value));
      return true;
    },
    async get<T>(key: string) { return data.get(key) as T | undefined; },
    async set(key, value) { data.set(key, structuredClone(value)); },
    async delete(key) { data.delete(key); },
    async keys() { return [...data.keys()]; },
  };
}

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;

test("C5：临界容量下中断恢复不删任何记录，放不下诊断字段就只改状态", async () => {
  const base = (index: number, size: number): VoiceCommandHistoryItem => ({
    id: `task-${index}`, transcript: "说".repeat(size), commandId: "voice.command.agent",
    status: "running", createdAt: "2026-09-27T08:00:00.000Z",
  });
  // 8 条 running 记录把整表撑到只差几十字节（单条转写不超过落盘上限，读回时不会被截短）：
  // 加中断文案 + 发现时刻必然超预算。
  const build = (size: number, last: number) => [...Array.from({ length: 7 }, (_, index) => base(index, size)), base(7, last)];
  let size = 10_000;
  while (bytes(build(size + 10, size + 10)) <= MAX_HISTORY_STORE_BYTES - 200) size += 10;
  let last = size;
  while (bytes(build(size, last + 1)) <= MAX_HISTORY_STORE_BYTES - 20) last += 1;
  const items = build(size, last);
  expect(bytes(items)).toBeGreaterThan(MAX_HISTORY_STORE_BYTES - 40);
  expect(size).toBeLessThan(10_900);
  const store = storeWith({ [COMMAND_HISTORY_KEY]: items });
  const recovered = await new VoiceStateRepository(store).recoverInterruptedCommandHistory();
  expect(recovered.map((entry) => entry.id)).toEqual(items.map((entry) => entry.id));
  expect(recovered.every((entry) => entry.status === "failed")).toBeTrue();
});

function mount(overrides: Partial<VoiceViewState>, extra: Partial<VoiceViewActions> = {}) {
  const root = document.createElement("div");
  document.body.append(root);
  const actions = new Proxy({ onCopyText: async () => { throw new Error("denied"); }, ...extra } as Record<string, unknown>, {
    get: (target, name) => Reflect.get(target, name) ?? (async () => undefined),
  }) as unknown as VoiceViewActions;
  const state = createDefaultVoiceViewState({ developerMode: true, statusLoad: "loaded", hostVersion: { state: "ready", version: "1.0.0" }, ...overrides });
  const view = mountVoiceView(root, state, actions);
  return { root, view, state };
}
const click = (element: Element | null | undefined) => (element as HTMLElement).click();
const settle = async () => { for (let index = 0; index < 12; index += 1) await Promise.resolve(); await new Promise((r) => setTimeout(r, 5)); };

function input(overrides: Partial<VoiceHistoryItem>): VoiceHistoryItem {
  return {
    id: "input-1", transcript: "明天开会", language: "zh-CN", source: "board", inserted: false, durationMs: 1000,
    createdAt: "2026-09-27T08:00:00.000Z", ...overrides,
  };
}
const selection = (engine: "cloud" | "local", modelName: string) =>
  ({ engine, modelId: engine === "cloud" ? "transcribe-free" : "sensevoice-small-int8", language: "zh-CN", punctEnabled: true, modelName });

test("C7：回执时间超出 Date 有效范围时详情页照常渲染，不冒充用时", () => {
  const h = mount({ history: [input({
    transcript: "", recordingId: "rec-1", recordingWallStartMs: Date.now(), transcriptionStatus: "failed",
    savedInput: { attemptId: "a1", revision: 1, state: "failed", startedAtMs: 1_000, finishedAtMs: 1e20, errorCode: "AI_UNAVAILABLE", selection: selection("cloud", "Free") },
  })] });
  click(h.root.querySelector(".task-item"));
  const block = h.root.querySelector<HTMLElement>(".voice-retry-panel .voice-diag")!;
  expect(block.querySelector(".voice-diag-code")?.textContent).toBe("错误码 AI_UNAVAILABLE");
  expect(block.querySelector(".voice-diag-elapsed")).toBeNull();
});

test("W2：回落本地的新尝试还在等时，诊断明细不混用上一轮云端失败的回执", () => {
  const h = mount({
    history: [input({
      transcript: "", recordingId: "rec-2", recordingWallStartMs: Date.now(), transcriptionStatus: "failed",
      savedInput: { attemptId: "cloud-a", revision: 1, state: "failed", startedAtMs: 1_000, finishedAtMs: 2_000, errorCode: "AI_TIMEOUT", selection: selection("cloud", "Cloud Model A") },
    })],
    inputRetries: { "rec-2": "fallback" },
    inputRetryAttempts: { "rec-2": { phase: "fallback", attemptId: "local-b", opSeq: 2, sinceMs: Date.now() - 4_000 } },
  });
  click(h.root.querySelector(".task-item"));
  const block = h.root.querySelector<HTMLElement>(".voice-retry-panel .voice-diag")!;
  expect(block.dataset.diagKey).toBe("retry:rec-2:local-b");
  click(block.querySelector(".voice-diag-toggle"));
  const panel = h.root.querySelector(".voice-retry-panel .voice-diag-panel")!.textContent!;
  expect(panel).toContain("local-b · fallback");
  expect(panel).toContain("识别方式: local");
  expect(panel).not.toContain("Cloud Model A");
  expect(panel).not.toContain("cloud-a");
});

test("W3：没有写回目标又润色失败时，两个阶段的诊断都在", () => {
  const h = mount({ history: [input({
    id: "input-3", warningCode: "no_input_target", polishFailed: true,
    polishFailure: { code: "AI_TIMEOUT", at: "2026-09-27T08:00:01.000Z" },
  })] });
  click(h.root.querySelector(".task-item"));
  const codes = Array.from(h.root.querySelectorAll(".input-detail .voice-diag-code")).map((node) => node.textContent);
  expect(codes).toContain("错误码 AI_TIMEOUT");
  expect(codes).toContain("错误码 no_input_target");
});

test("W4：多天总结失败按天分开，互不覆盖", () => {
  const day = (dayMs: number) => ({ id: `seg-${dayMs}`, wallStartMs: dayMs, durationMs: 60_000, transport: "usb_vendor_hid", transcriptText: "素材" });
  const today = Date.now();
  const yesterday = today - 86_400_000;
  const key = (ms: number) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
  const h = mount({
    recordings: [day(today), day(yesterday)] as VoiceViewState["recordings"],
    recordingsTotal: 2,
    dayDigestFailures: {
      [key(today)]: { step: "summaryDay", code: "DIGEST_TIMEOUT", at: "2026-09-27T08:00:00.000Z" },
      [key(yesterday)]: { step: "summaryDay", code: "AI_RATE_LIMITED", at: "2026-09-27T08:01:00.000Z" },
    },
  });
  click(h.root.querySelector('[data-voice-tab="context"]'));
  const codes = Array.from(h.root.querySelectorAll(".ctx-dg-status .voice-diag-code")).map((node) => node.textContent);
  expect(codes).toEqual(expect.arrayContaining(["错误码 DIGEST_TIMEOUT", "错误码 AI_RATE_LIMITED"]));
});

test("W1：前面的用时从 9 秒跳到 10 秒，<pre> 里的选区不错位", async () => {
  const createdAt = new Date(Date.now() - 9_500).toISOString();
  const failed: VoiceCommandHistoryItem = {
    id: "task-9", transcript: "hello", commandId: "voice.command.agent", status: "failed", createdAt,
    errorCode: "AGENT_ENGINE", failedAt: new Date().toISOString(),
  };
  const h = mount({ commandHistory: [failed] });
  click(h.root.querySelector('[data-voice-tab="command"]'));
  click(h.root.querySelector(".command-history-item"));
  click(h.root.querySelector(".voice-diag[data-diag-key='chat-failed:task-9'] .voice-diag-toggle"));
  click(h.root.querySelector(".voice-diag-copy"));
  await settle();
  const pre = h.root.querySelector(".voice-diag-fallback")!;
  const range = document.createRange();
  range.setStart(pre.firstChild!, 10);
  range.setEnd(pre.firstChild!, 30);
  document.getSelection()!.removeAllRanges();
  document.getSelection()!.addRange(range);
  const selected = document.getSelection()!.toString();
  // 状态刷新让诊断区前面的文字变长（此处用更晚的失败时间模拟「用时」多一位）。
  h.view.update({ ...h.state, commandHistory: [{ ...failed, failedAt: new Date(Date.now() + 5_000).toISOString() }] });
  expect(document.getSelection()!.toString()).toBe(selected);
  expect(h.root.querySelector(".voice-diag-fallback")!.contains(document.getSelection()!.anchorNode)).toBeTrue();
});

test("W1：选区所在字段的内容变了（用时多一位）就不选回，绝不选到错位的文字上", () => {
  const failed: VoiceCommandHistoryItem = {
    id: "task-8", transcript: "hello", commandId: "voice.command.agent", status: "failed",
    createdAt: "2026-09-27T08:00:00.000Z", errorCode: "AGENT_ENGINE", failedAt: "2026-09-27T08:00:09.000Z",
  };
  const h = mount({ commandHistory: [failed] });
  click(h.root.querySelector('[data-voice-tab="command"]'));
  click(h.root.querySelector(".command-history-item"));
  click(h.root.querySelector(".voice-diag[data-diag-key='chat-failed:task-8'] .voice-diag-toggle"));
  const current = Array.from(h.root.querySelectorAll<HTMLElement>(".voice-diag-panel dd"))
    .find((cell) => cell.textContent?.includes("用时 9 秒"))!;
  const walker = document.createTreeWalker(current, NodeFilter.SHOW_TEXT);
  const first = walker.nextNode()!;
  const range = document.createRange();
  range.setStart(first, 0);
  range.setEnd(first, Math.min(2, first.textContent!.length));
  document.getSelection()!.removeAllRanges();
  document.getSelection()!.addRange(range);
  h.view.update({ ...h.state, commandHistory: [{ ...failed, failedAt: "2026-09-27T08:00:10.000Z" }] });
  const panel = h.root.querySelector(".voice-diag-panel")!;
  expect(panel.textContent).toContain("用时 10 秒");
  expect(panel.contains(document.getSelection()!.anchorNode)).toBeFalse();
});

test("W7：冻结的「用时」切语言后立即换成英文", () => {
  const h = mount({ commandHistory: [{
    id: "task-7", transcript: "hi", commandId: "voice.command.agent", status: "failed",
    createdAt: "2026-09-27T08:00:00.000Z", errorCode: "AGENT_ENGINE", failedAt: "2026-09-27T08:00:05.000Z",
  }] });
  click(h.root.querySelector('[data-voice-tab="command"]'));
  click(h.root.querySelector(".command-history-item"));
  const elapsed = h.root.querySelector(".voice-diag[data-diag-key='chat-failed:task-7'] .voice-diag-elapsed")!;
  expect(elapsed.textContent).toBe("用时 5 秒");
  setVoiceLocale("en");
  expect(elapsed.textContent).toBe("Took 5s");
  tickVoiceElapsed(h.root);
  expect(elapsed.textContent).toBe("Took 5s");
});
