/**
 * 缺陷3：Voice 页 Context 段详情的「重新转写」入口。转写缺失 / 失败 / 积压中
 * 的分片必须有一个手动重新入队本地转写的按钮（锁屏后引擎没跑、用户想手动补），
 * 排队期间如实说明，已转好的段不给入口。
 */
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { VoiceRecordingSegment } from "@reai/app-sdk/v1";
import { createDefaultVoiceViewState, type VoiceViewState } from "../src/data";
import { mountVoiceView, type VoiceViewActions } from "../src/voice-view";

let ownsDomRegistration = false;
beforeAll(() => {
  if (typeof document === "undefined") {
    GlobalRegistrator.register();
    ownsDomRegistration = true;
  }
});
afterAll(() => { if (ownsDomRegistration) GlobalRegistrator.unregister(); });
beforeEach(() => document.body.replaceChildren());

const SEGMENT_START = new Date(2026, 7, 18, 14, 3, 0);

function emptyTranscriptSegment(): VoiceRecordingSegment {
  return {
    id: "rec-backlog",
    wallStartMs: SEGMENT_START.getTime(),
    durationMs: 38 * 60_000,
    transport: "usb_vendor_hid",
    transcriptText: null,
    transcribedAtMs: null,
    transcriptStatus: "pending",
  } as VoiceRecordingSegment;
}

interface Harness {
  root: HTMLElement;
  update(state: VoiceViewState): void;
  dispose(): void;
  retranscribed: string[];
}

function mount(overrides: Partial<VoiceViewState> = {}, withAction = true): Harness {
  const root = document.createElement("div");
  document.body.append(root);
  const harness: Harness = { root, update: () => undefined, dispose: () => undefined, retranscribed: [] };
  const base = {
    onToggle: async () => undefined,
    onCommandToggle: async () => undefined,
    onOpenSystemTask: async () => undefined,
    onRefresh: async () => undefined,
    onNavigated: () => undefined,
    onSettingsChanged: async () => undefined,
    onDownloadModel: async () => undefined,
    onCancelModelDownload: async () => undefined,
    onRequestPermission: async () => undefined,
    onContinuousRecording: async () => undefined,
    onScreenshotConsentConfirm: async () => undefined,
    onScreenshotConsentRevoked: async () => undefined,
    onSendCommandFollowUp: async () => "task-follow-up",
    onRegenerateDayDigest: async () => undefined,
    onSendDayDigestToAgent: async () => undefined,
    onSummarizeSegment: async () => undefined,
    onMarkCommandRead: async () => undefined,
    onLoadReplayAudio: async () => new Blob([new Uint8Array([1])], { type: "audio/wav" }),
    onReplayRetentionChanged: async () => undefined,
    onClearReplayCache: async () => undefined,
    onActionMountChanged: async () => undefined,
    onOpenKeymap: async () => undefined,
    ...(withAction
      ? { onRetranscribeSegment: async (recordingId: string) => { harness.retranscribed.push(recordingId); } }
      : {}),
  };
  const view = mountVoiceView(root, createDefaultVoiceViewState(overrides), base as unknown as VoiceViewActions);
  harness.update = (next) => view.update(next);
  harness.dispose = () => view.dispose();
  return harness;
}

function openEmptySegmentDetail(harness: Harness): void {
  (harness.root.querySelector('[data-voice-tab="context"]') as HTMLButtonElement).click();
  // 空转写分片在 Context 档是 .ctx-seg-empty 行（没有 recording-copy 类）。
  (harness.root.querySelector(".ctx-seg-empty") as HTMLButtonElement).click();
}

function button(harness: Harness): HTMLButtonElement | null {
  return harness.root.querySelector<HTMLButtonElement>("[data-action='retranscribe-segment']");
}

test("转写缺失的分片：详情页出现「重新转写」按钮，点击带着段 id 回调", () => {
  const harness = mount({ recordings: [emptyTranscriptSegment()], recordingsTotal: 1 });
  openEmptySegmentDetail(harness);
  const node = button(harness);
  expect(node).not.toBeNull();
  expect(node!.dataset.recordingId).toBe("rec-backlog");
  expect(node!.textContent).toBe("重新转写");
  expect(node!.disabled).toBeFalse();
  node!.click();
  expect(harness.retranscribed).toEqual(["rec-backlog"]);
  harness.dispose();
});

test("排队中如实说明：running 防连点、queued 给已排队提示", () => {
  const harness = mount({
    recordings: [emptyTranscriptSegment()],
    recordingsTotal: 1,
    retranscribingSegments: { "rec-backlog": "running" },
  });
  openEmptySegmentDetail(harness);
  const running = button(harness)!;
  expect(running.disabled).toBeTrue();
  expect(running.textContent).toBe("正在重新入队…");

  harness.update(createDefaultVoiceViewState({
    recordings: [emptyTranscriptSegment()],
    recordingsTotal: 1,
    retranscribingSegments: { "rec-backlog": "queued" },
  }));
  const queued = button(harness)!;
  expect(queued.disabled).toBeFalse();
  expect(harness.root.querySelector(".ctx-retranscribe-note")?.textContent)
    .toContain("已重新排进本地转写队列");
  harness.dispose();
});

test("已转好的分片与未提供动作的旧 app 都不出现按钮", () => {
  const harness = mount({
    recordings: [{
      id: "rec-done",
      wallStartMs: SEGMENT_START.getTime(),
      durationMs: 38 * 60_000,
      transport: "usb_vendor_hid",
      transcriptText: "这段已经转好了。",
      transcribedAtMs: 1,
    } as VoiceRecordingSegment],
    recordingsTotal: 1,
  });
  (harness.root.querySelector('[data-voice-tab="context"]') as HTMLButtonElement).click();
  (harness.root.querySelector(".recording-copy") as HTMLButtonElement).click();
  (harness.root.querySelector(".ctx-tab[data-ctx-pane='raw']") as HTMLButtonElement).click();
  expect(button(harness), "有文字的分片不需要重新转写入口").toBeNull();
  harness.dispose();

  const legacy = mount({ recordings: [emptyTranscriptSegment()], recordingsTotal: 1 }, false);
  openEmptySegmentDetail(legacy);
  expect(button(legacy), "旧 app 没实现动作时不画按钮").toBeNull();
  legacy.dispose();
});
