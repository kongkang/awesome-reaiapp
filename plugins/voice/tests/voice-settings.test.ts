import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { AudioTimelineStatus, VoiceModelInfo } from "@reai/app-sdk/v1";
import {
  DEFAULT_SETTINGS,
  DEFAULT_VOICE_FEATURE_SETTINGS,
  createDefaultVoiceViewState,
  type VoiceViewState,
} from "../src/data";
import { mountVoiceView, type VoiceViewActions } from "../src/voice-view";

let ownsDomRegistration = false;
beforeAll(() => {
  if (typeof document === "undefined") {
    GlobalRegistrator.register();
    ownsDomRegistration = true;
  }
});
afterAll(() => {
  if (ownsDomRegistration) GlobalRegistrator.unregister();
});
beforeEach(() => document.body.replaceChildren());

function model(state: VoiceModelInfo["state"] = "active"): VoiceModelInfo {
  return {
    id: "sensevoice-small-int8",
    name: "SenseVoice Small",
    description: "中英粤日韩本地识别",
    sizeBytes: 228 * 1024 * 1024,
    state,
    active: state === "active",
    updateAvailable: false,
  };
}

function timeline(): AudioTimelineStatus {
  return {
    state: "running",
    route: "usb_vendor_hid",
    hotRingDurationMs: 10_000,
    cacheDurationMs: 60_000,
    cacheHealth: "healthy",
    continuousRecordingEnabled: true,
    recordingState: "running",
    sttBacklog: 0,
    hostLocalDropFrames: 0,
  };
}

function mount(overrides: Partial<VoiceViewState> = {}, extra: Partial<VoiceViewActions> = {}) {
  const root = document.createElement("div");
  document.body.append(root);
  const settingsPatches: Array<Partial<VoiceViewState["settings"]>> = [];
  const featurePatches: Array<Partial<VoiceViewState["featureSettings"]>> = [];
  const calls = { mount: [] as Array<[string, boolean]> };
  const actions = {
    onToggle: async () => undefined,
    onCommandToggle: async () => undefined,
    onOpenSystemTask: async () => undefined,
    onRefresh: async () => undefined,
    onSettingsChanged: async (patch: Partial<VoiceViewState["settings"]>) => {
      settingsPatches.push(patch);
    },
    onFeatureSettingsChanged: async (patch: Partial<VoiceViewState["featureSettings"]>) => {
      featurePatches.push(patch);
    },
    onDownloadModel: async () => undefined,
    onCancelModelDownload: async () => undefined,
    onConfigureWorkflow: async () => ({ configured: true, loggedIn: true }),
    onRequestPermission: async () => undefined,
    onTimelinePaused: async () => undefined,
    onContinuousRecording: async () => undefined,
          onScreenshotConsentConfirm: async () => undefined,
          onScreenshotConsentRevoked: async () => undefined,
    onPlayRecording: async () => undefined,
    onDeleteRecording: async () => undefined,
    onSendContextToAgent: async () => undefined,
    onSynthesizeDayDigest: async () => undefined,
    onSendDayDigestToAgent: async () => undefined,
    onDeleteDayDigest: async () => undefined,
    onSendCommandFollowUp: async () => "task-follow-up",
    onLoadReplayAudio: async () => new Blob([], { type: "audio/wav" }),
    onReplayRetentionChanged: async () => undefined,
    onClearReplayCache: async () => undefined,
    onActionMountChanged: async (commandId: string, mounted: boolean) => {
      calls.mount.push([commandId, mounted]);
    },
    onOpenKeymap: async () => undefined,
    onNavigated: () => undefined,
    ...extra,
  } as unknown as VoiceViewActions;
  const state = createDefaultVoiceViewState({
    models: [model()],
    timeline: timeline(),
    replayCache: { retention: "24h", clipCount: 2, usedBytes: 12_000, retainedSinceMs: 1 },
    ...overrides,
  });
  const view = mountVoiceView(root, state, actions);
  return { root, view, state, settingsPatches, featurePatches, calls };
}

function sectionTitles(root: HTMLElement): string[] {
  return Array.from(root.querySelectorAll(".settings-section")).map(
    (section) => section.querySelector(".settings-section-title")?.textContent ?? "",
  );
}

function rowTitles(section: Element | null): string[] {
  return Array.from(section?.querySelectorAll(".settings-row-title") ?? []).map(
    (node) => node.textContent ?? "",
  );
}

describe("Voice 设置主页面", () => {
  test("本地引擎按频次排序，主页面没有测试、Agent、增益或模型说明", () => {
    const harness = mount({ commandLoggedIn: false });
    harness.view.openSettings();
    expect(sectionTitles(harness.root)).toEqual([
      "录音与识别",
      "润色",
      "语音命令",
      "记录保留",
      "每日总结",
      "系统",
      "Agent 配置",
    ]);
    const engine = harness.root.querySelector('[data-settings-target="engine"]');
    expect(rowTitles(engine)).toEqual(["引擎", "本地模型", "录音来源", "识别语言"]);
    expect(harness.root.textContent).not.toContain("测试语音识别");
    expect(harness.root.textContent).not.toContain("Agent 底层");
    expect(harness.root.textContent).not.toContain("麦克风增益");
    harness.view.dispose();
  });

  test("云端未登录：可以切到云端，第二行引导登录；润色配置保持可见", () => {
    const harness = mount({ commandLoggedIn: false, settings: { ...DEFAULT_SETTINGS, engine: "cloud" } });
    harness.view.openSettings();
    const engine = harness.root.querySelector('[data-settings-target="engine"]');
    expect(rowTitles(engine)).toEqual(["引擎", "云端状态", "录音来源", "识别语言"]);
    const cloud = Array.from(engine?.querySelectorAll<HTMLButtonElement>('[role="radio"]') ?? [])
      .find((button) => button.textContent === "云端引擎");
    expect(cloud?.disabled).toBeFalse();
    expect(sectionTitles(harness.root)).toContain("润色");
    harness.view.dispose();
  });

  test("云端已登录：未保存时不冒充默认模型已选中，润色紧跟录音与识别", () => {
    const harness = mount({
      commandLoggedIn: true,
      settings: { ...DEFAULT_SETTINGS, engine: "cloud" },
      cloudModels: [
        { id: "transcribe-free", kind: "transcribe", label: "通用语音模型" },
        { id: "transcribe-accurate", kind: "transcribe", label: "高精度语音模型" },
      ],
    });
    harness.view.openSettings();
    expect(sectionTitles(harness.root)).toEqual([
      "录音与识别",
      "润色",
      "语音命令",
      "记录保留",
      "每日总结",
      "系统",
      "Agent 配置",
    ]);
    const select = harness.root.querySelector<HTMLSelectElement>('[aria-label="选择云端模型"]')!;
    expect(select.value).toBe("cloud-unavailable");
    expect(Array.from(select.options).some(option => option.value === "")).toBeFalse();
    select.value = "transcribe-accurate";
    select.dispatchEvent(new Event("change"));
    expect(harness.featurePatches).toContainEqual({ cloudModelId: "transcribe-accurate" });
    harness.view.dispose();
  });

  test("识别语言打开当前模型支持列表，不再点击轮换", () => {
    const harness = mount();
    harness.view.openSettings();
    harness.root.querySelector<HTMLButtonElement>("[data-language-row]")!.click();
    const dialog = harness.root.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain("当前模型：SenseVoice Small");
    expect(Array.from(dialog?.querySelectorAll('[role="radio"]') ?? []).map((node) => node.textContent))
      .toEqual(["自动检测✓", "简体中文", "English"]);
    dialog?.querySelector<HTMLButtonElement>('[data-language-value="zh-CN"]')?.click();
    expect(harness.settingsPatches).toEqual([{ language: "zh-CN" }]);
    harness.view.dispose();
  });

  test("本地模型进入二级页面，说明默认折叠", () => {
    const harness = mount();
    harness.view.openSettings();
    harness.root.querySelector<HTMLButtonElement>('[data-settings-target="model"]')!.click();
    expect(harness.root.textContent).toContain("模型与识别");
    const details = harness.root.querySelector<HTMLDetailsElement>(".settings-model-details")!;
    expect(details.open).toBeFalse();
    expect(details.querySelector("summary")?.textContent).toBe("查看模型说明");
    harness.view.dispose();
  });
});

describe("记录、每日总结与权限", () => {
  test("记录保留只有保留时长、占用和清空，没有两个功能开关", () => {
    const harness = mount();
    harness.view.openSettings();
    const section = harness.root.querySelector('[data-settings-target="replay-cache"]');
    expect(rowTitles(section)).toEqual(["保留多久", "已占用", "立刻清空语音记录"]);
    expect(section?.querySelector('[role="switch"]')).toBeNull();
    expect(section?.textContent).toContain("只保存有有效文字的语音记录");
    harness.view.dispose();
  });

  test("每日总结先开云端生成；首次开启必须同时接受用量与隐私风险", () => {
    const harness = mount({ commandLoggedIn: true, featureSettings: { ...DEFAULT_VOICE_FEATURE_SETTINGS } });
    harness.view.openSettings();
    expect(harness.root.textContent).not.toContain("生成方式");
    harness.root.querySelector<HTMLButtonElement>('[data-action="summary-enabled"]')!.click();
    const dialog = harness.root.querySelector('[role="dialog"]')!;
    const checks = dialog.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    const confirm = Array.from(dialog.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === "确认并开启")!;
    expect(confirm.disabled).toBeTrue();
    checks[0]!.click();
    expect(confirm.disabled).toBeTrue();
    checks[1]!.click();
    expect(confirm.disabled).toBeFalse();
    confirm.click();
    expect(harness.featurePatches).toContainEqual({ summaryConsent: true, summaryEnabled: true });
    harness.view.dispose();
  });

  test("每日总结已开启后才出现手动/自动；权限行只用外链图标", () => {
    const openPermissions = mock(async () => undefined);
    const harness = mount({
      commandLoggedIn: true,
      featureSettings: {
        ...DEFAULT_VOICE_FEATURE_SETTINGS,
        summaryConsent: true,
        summaryEnabled: true,
      },
    }, { onOpenPermissionSettings: openPermissions });
    harness.view.openSettings();
    expect(harness.root.textContent).toContain("生成方式");
    const permissions = harness.root.querySelector<HTMLButtonElement>('[data-action="open-permission-settings"]')!;
    expect(permissions.textContent).toContain("权限与隐私");
    expect(permissions.textContent).not.toContain("权限设置");
    expect(permissions.querySelector(".settings-external-link svg")).not.toBeNull();
    permissions.click();
    expect(openPermissions).toHaveBeenCalledTimes(1);
    harness.view.dispose();
  });
});

describe("触发事件管理", () => {
  test("三条入口使用统一开关语义，文本入口走 canonical toggle-input", () => {
    const harness = mount({ mountedActionCommandIds: ["com.reai.voice.command.agent"] });
    harness.view.openSettings("commands");
    const rows = Array.from(harness.root.querySelectorAll<HTMLElement>("[data-command-event]"));
    expect(rows.map((row) => row.dataset.commandEvent)).toEqual([
      "com.reai.voice.toggle-input",
      "com.reai.voice.command.translate",
      "com.reai.voice.command.agent",
    ]);
    expect(rows.map((row) => row.querySelector(".command-event-title")?.textContent)).toEqual([
      "语音输入",
      "语音翻译",
      "语音 Agent 任务",
    ]);
    harness.root.querySelector<HTMLButtonElement>(".settings-hint-trigger")!.click();
    expect(document.body.textContent).toContain("录音中触发任意一个，都结束当前录音");
    rows[0]!.querySelector<HTMLButtonElement>('[role="switch"]')!.click();
    expect(harness.calls.mount).toEqual([["com.reai.voice.toggle-input", true]]);
    harness.view.dispose();
  });
});

test('download progress is shared between homepage and model page; installed models have no extra row', () => {
 const m={...model('downloading'), downloadedBytes:40, sizeBytes:100};
 const h=mount({models:[m]}); h.view.openSettings();
 expect(h.root.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('40');
 h.root.querySelector<HTMLButtonElement>('[data-settings-target="model"]')!.click();
 expect(h.root.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('40');
 h.view.update({...h.state,models:[model('active')]});
 expect(h.root.querySelector('.local-model-status')).toBeNull(); h.view.dispose();
});

test('retained download offers resume and preparing offers cancel', async () => {
 let resumed=0,cancelled=0;
 const m={...model('missing'),resumeAvailable:true,downloadedBytes:40,sizeBytes:100};
 const h=mount({models:[m]}, {onDownloadModel:async()=>{resumed++;},onCancelModelDownload:async()=>{cancelled++;}});
 h.view.openSettings(); h.root.querySelector<HTMLButtonElement>('.local-model-status button')!.click();
 expect(resumed).toBe(1);
 h.view.update({...h.state,models:[m],localDownloads:{[m.id]:{phase:'preparing'}}});
 h.root.querySelector<HTMLButtonElement>('.local-model-status button')!.click(); expect(cancelled).toBe(1); h.view.dispose();
});

test("current-account zero price is displayed as a numeric subscription quote in USD cents per second", () => {
  const accountModel = { id: "transcribe-account", kind: "transcribe" as const, label: "Current default", isDefault: true,
    pricingContext: "current-account" as const, billingPolicy: "free" as const,
    effectivePrice: { unit: "second" as const, unitPriceCents: "0", baseUnitPriceCents: "0.1", reason: "subscription_price" as const,
      ruleRevision: "rule-1", policyRevision: "policy-1", subscriptionRevision: "sub-1", evaluatedAt: "2026-10-02T00:00:00Z", validUntil: "2099-01-01T00:00:00Z" } };
  const h = mount({ commandLoggedIn: true, settings: { ...DEFAULT_SETTINGS, engine: "cloud" },
    featureSettings: { ...DEFAULT_VOICE_FEATURE_SETTINGS, cloudModelId: accountModel.id }, cloudModels: [accountModel] });
  try {
    h.view.openSettings();
    expect(h.root.textContent).toContain("0 美分/秒");
    expect(h.root.textContent).toContain("当前订阅价格");
    expect(h.root.textContent).not.toContain("永久免费");
  } finally { h.view.dispose(); }
});
