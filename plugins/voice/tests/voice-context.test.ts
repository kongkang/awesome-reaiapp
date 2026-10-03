import { describe, expect, test } from "bun:test";
import type { VoiceContextCapture } from "@reai/app-sdk/v1";
import {
  MAX_NEARBY_TEXT_CHARS,
  MAX_SOURCE_TEXT_CHARS,
  VOICE_CONTEXT_SOURCES,
  VoiceContextRegistry,
  createDefaultContextRegistry,
  createRecentVoiceProvider,
  createWindowScreenshotProvider,
  createWindowTextProvider,
  type VoiceContextHost,
  type VoiceContextProvider,
  type VoiceContextSettings,
} from "../src/voice-context";

const ALL_ON: VoiceContextSettings = {
  windowEnabled: true,
  recentVoiceEnabled: true,
  recentVoiceRangeMinutes: 5,
};

const GRANT = { sessionId: "voice-session", consentEpoch: "epoch", isCurrent: () => true };
const WITH_SCREENSHOT = { settings: { ...ALL_ON, screenshotEnabled: true }, screenshot: GRANT };

const NOW = Date.UTC(2026, 7, 17, 12, 0, 0);

function host(
  capture: Partial<VoiceContextCapture> | (() => never),
  seen?: Array<{ includeWindowText?: boolean }>,
): VoiceContextHost {
  return {
    async capture(options) {
      seen?.push({ includeWindowText: options?.includeWindowText });
      if (typeof capture === "function") capture();
      return {
        windowTextStatus: "unavailable",
        screenRecording: "denied",
        sessionEpoch: "epoch",
        ...(capture as Partial<VoiceContextCapture>),
      } as VoiceContextCapture;
    },
  };
}

function stubProvider(id: string, text: string): VoiceContextProvider {
  return {
    id,
    label: id,
    async collect() {
      return { status: "collected", text };
    },
  };
}

describe("provider 注册表：增删与顺序", () => {
  test("注册顺序即拼接顺序，先注册的先出现在 nearbyText 里", async () => {
    const registry = new VoiceContextRegistry()
      .register(stubProvider("a", "第一段"))
      .register(stubProvider("b", "第二段"));
    const { envelope } = await registry.assemble({ settings: ALL_ON, now: NOW });
    expect(envelope?.nearbyText?.indexOf("第一段")).toBeLessThan(
      envelope?.nearbyText?.indexOf("第二段") ?? -1,
    );
  });

  test("同 id 覆盖而不是并存", async () => {
    const registry = new VoiceContextRegistry()
      .register(stubProvider("a", "旧的"))
      .register(stubProvider("a", "新的"));
    expect(registry.list()).toHaveLength(1);
    const { envelope } = await registry.assemble({ settings: ALL_ON, now: NOW });
    expect(envelope?.nearbyText).toContain("新的");
    expect(envelope?.nearbyText).not.toContain("旧的");
  });

  test("unregister 摘掉一个源之后它不再参与组装", async () => {
    const registry = new VoiceContextRegistry()
      .register(stubProvider("a", "留下"))
      .register(stubProvider("b", "拿掉"));
    expect(registry.unregister("b")).toBeTrue();
    expect(registry.unregister("b")).toBeFalse();
    const { envelope, outcomes } = await registry.assemble({ settings: ALL_ON, now: NOW });
    expect(outcomes.map((item) => item.id)).toEqual(["a"]);
    expect(envelope?.nearbyText).not.toContain("拿掉");
  });

  test("加一个新源不需要改组装逻辑", async () => {
    const registry = new VoiceContextRegistry().register(stubProvider("a", "原有"));
    registry.register({
      id: "acme.calendar",
      label: "下一场会",
      async collect() {
        return { status: "collected", text: "14:00 产品评审" };
      },
    });
    const { envelope } = await registry.assemble({ settings: ALL_ON, now: NOW });
    expect(envelope?.nearbyText).toContain("14:00 产品评审");
    expect(envelope?.nearbyText).toContain("【下一场会】");
  });

  test("一个 provider 抛错只算它自己 unavailable，不带崩整次组装", async () => {
    const registry = new VoiceContextRegistry()
      .register({
        id: "broken",
        label: "坏的",
        async collect() {
          throw new Error("provider 写错了");
        },
      })
      .register(stubProvider("ok", "仍然拿得到"));
    const { envelope, outcomes } = await registry.assemble({ settings: ALL_ON, now: NOW });
    expect(outcomes[0]?.outcome).toEqual({ status: "skipped", reason: "unavailable" });
    expect(envelope?.nearbyText).toContain("仍然拿得到");
  });

  test("一个源都没内容时不产出空壳 envelope", async () => {
    const registry = new VoiceContextRegistry().register({
      id: "empty",
      label: "空",
      async collect() {
        return { status: "skipped", reason: "empty" };
      },
    });
    const { envelope, outcomes } = await registry.assemble({ settings: ALL_ON, now: NOW });
    expect(envelope).toBeUndefined();
    expect(outcomes).toHaveLength(1);
  });

  test("两个源都吃满时按份额平分，后面的源不会被整段挤掉", async () => {
    // 素材必须两个源都超预算，否则测不到它宣称的东西：单源上限 1200 × 2
    // 已经超过总上限 2000，写死单源上限的话第一个源就能把额度吃光。
    const registry = new VoiceContextRegistry()
      .register(stubProvider("a", "甲".repeat(MAX_SOURCE_TEXT_CHARS * 2)))
      .register(stubProvider("b", "乙".repeat(MAX_SOURCE_TEXT_CHARS * 2)));
    const { envelope } = await registry.assemble({ settings: ALL_ON, now: NOW });
    const nearbyText = envelope?.nearbyText ?? "";
    expect(nearbyText.length).toBeLessThanOrEqual(MAX_NEARBY_TEXT_CHARS + 1);
    const jia = (nearbyText.match(/甲/g) ?? []).length;
    const yi = (nearbyText.match(/乙/g) ?? []).length;
    expect(jia).toBeGreaterThan(0);
    expect(yi).toBeGreaterThan(0);
    // 平分：两边拿到的字数应当接近，而不是一头吃光。
    expect(Math.abs(jia - yi)).toBeLessThanOrEqual(2);
    // 截断处要留痕，别让模型以为原文就到这儿。
    expect(nearbyText).toContain("…");
  });

  test("标题特别长时每源配额仍是正数，不会算出 0 或负数", async () => {
    const registry = new VoiceContextRegistry();
    for (let index = 0; index < 5; index += 1) {
      registry.register(stubProvider("超长源名".repeat(60) + index, "内容".repeat(50)));
    }
    const { envelope } = await registry.assemble({ settings: ALL_ON, now: NOW });
    // 开销吃掉预算时下界兜住 1，每个源至少留一个字符，而不是整块消失或抛错。
    expect((envelope?.nearbyText?.match(/内/g) ?? []).length).toBeGreaterThanOrEqual(5);
  });

  test("单个源也不许超过单源硬上限", async () => {
    const registry = new VoiceContextRegistry().register(
      stubProvider("a", "甲".repeat(MAX_NEARBY_TEXT_CHARS * 2)),
    );
    const { envelope } = await registry.assemble({ settings: ALL_ON, now: NOW });
    expect((envelope?.nearbyText?.match(/甲/g) ?? []).length).toBe(MAX_SOURCE_TEXT_CHARS);
  });
});

describe("窗口文字源：权限缺失只降级，不阻断", () => {
  test("关掉这一档时既不采集也不调用宿主", async () => {
    const seen: Array<{ includeWindowText?: boolean }> = [];
    const provider = createWindowTextProvider(host({}, seen));
    const outcome = await provider.collect({
      settings: { ...ALL_ON, windowEnabled: false },
      now: NOW,
    });
    expect(outcome).toEqual({ status: "skipped", reason: "disabled" });
    expect(seen).toHaveLength(0);
  });

  test("缺辅助功能权限时降级为 permission_denied，但应用分类仍然带回", async () => {
    const provider = createWindowTextProvider(
      host({ windowTextStatus: "accessibility_denied", appCategory: "editor" }),
    );
    const outcome = await provider.collect({ settings: ALL_ON, now: NOW });
    // 没读到文字不代表「用户在用什么类别的应用」也不成立——那正是分类的全部用途。
    expect(outcome).toEqual({
      status: "skipped",
      reason: "permission_denied",
      appCategory: "editor",
    });
  });

  test("宿主不采集名单（终端 / 密码管理器）走独立的 app_excluded", async () => {
    const provider = createWindowTextProvider(
      host({ windowTextStatus: "app_excluded", appCategory: "terminal" }),
    );
    const outcome = await provider.collect({ settings: ALL_ON, now: NOW });
    // 「我们不读」和「读不到」是两回事，压成一档就没法向用户解释。
    expect(outcome).toEqual({
      status: "skipped",
      reason: "app_excluded",
      appCategory: "terminal",
    });
  });

  test("只查到分类、没有文字时，envelope 里仍然带上分类", async () => {
    const registry = new VoiceContextRegistry().register(
      createWindowTextProvider(host({ windowTextStatus: "unavailable", appCategory: "chat" })),
    );
    const { envelope } = await registry.assemble({ settings: ALL_ON, now: NOW });
    expect(envelope).toEqual({ version: "1", appCategory: "chat" });
  });

  test("插件权限页没授权（宿主抛错）同样只是降级", async () => {
    const provider = createWindowTextProvider(
      host(() => {
        throw Object.assign(new Error("nope"), { code: "VOICE_CONTEXT_PERMISSION_REQUIRED" });
      }),
    );
    const outcome = await provider.collect({ settings: ALL_ON, now: NOW });
    expect(outcome).toEqual({ status: "skipped", reason: "permission_denied" });
  });

  test("读到文字时带回文字与应用分类，并显式向宿主要窗口文字", async () => {
    const seen: Array<{ includeWindowText?: boolean }> = [];
    const provider = createWindowTextProvider(
      host({ windowTextStatus: "captured", windowText: "Dear team,", appCategory: "email" }, seen),
    );
    const outcome = await provider.collect({ settings: ALL_ON, now: NOW });
    expect(outcome).toEqual({
      status: "collected",
      text: "Dear team,",
      appCategory: "email",
    });
    expect(seen).toEqual([{ includeWindowText: true }]);
  });
});

describe("截图源：权限与采集失败都只降级", () => {
  test("没有屏幕录制权限 → permission_denied，且从不请求权限", async () => {
    const seen: Array<{ includeWindowText?: boolean }> = [];
    const provider = createWindowScreenshotProvider(host({ screenRecording: "denied" }, seen));
    const outcome = await provider.collect({ ...WITH_SCREENSHOT, now: NOW });
    expect(outcome).toEqual({ status: "skipped", reason: "permission_denied" });
    // 探权限时绝不能顺手把窗口文字也读走。
    expect(seen).toEqual([{ includeWindowText: false }]);
  });

  test("有权限但 Host 没拿到焦点窗口截图时是 unavailable", async () => {
    const provider = createWindowScreenshotProvider(host({ screenRecording: "granted" }));
    const outcome = await provider.collect({ ...WITH_SCREENSHOT, now: NOW });
    expect(outcome).toEqual({ status: "skipped", reason: "unavailable" });
  });

  test("关闭独立截图开关时不问宿主", async () => {
    const seen: Array<{ includeWindowText?: boolean }> = [];
    const provider = createWindowScreenshotProvider(host({ screenRecording: "granted" }, seen));
    const outcome = await provider.collect({
      settings: { ...ALL_ON, screenshotEnabled: false },
      screenshot: GRANT,
      now: NOW,
    });
    expect(outcome).toEqual({ status: "skipped", reason: "disabled" });
    expect(seen).toHaveLength(0);
  });

  test("Host 没返回截图时不产出空壳 envelope", async () => {
    const registry = new VoiceContextRegistry().register(
      createWindowScreenshotProvider(host({ screenRecording: "granted" })),
    );
    const { envelope } = await registry.assemble({ ...WITH_SCREENSHOT, now: NOW });
    expect(envelope).toBeUndefined();
  });
});

describe("一次组装内不重复问宿主", () => {
  test("窗口文字与截图两个 provider 合并成一次 capture", async () => {
    const seen: Array<{ includeWindowText?: boolean }> = [];
    const registry = createDefaultContextRegistry(
      host(
        {
          windowTextStatus: "captured",
          windowText: "窗口里的文字",
          appCategory: "editor",
          screenRecording: "granted",
        },
        seen,
      ),
      { segments: () => [] },
    );
    await registry.assemble({ ...WITH_SCREENSHOT, now: NOW });
    // 两个 provider 消费同一 session/epoch 的快照。
    expect(seen).toEqual([{ includeWindowText: true }]);
  });

  test("跨组装不复用缓存：这一次读的必须是这一次的窗口", async () => {
    const seen: Array<{ includeWindowText?: boolean }> = [];
    const registry = createDefaultContextRegistry(
      host({ windowTextStatus: "captured", windowText: "文字", screenRecording: "granted" }, seen),
      { segments: () => [] },
    );
    await registry.assemble({ ...WITH_SCREENSHOT, now: NOW });
    await registry.assemble({ ...WITH_SCREENSHOT, now: NOW });
    expect(seen).toHaveLength(2);
  });

  test("关掉窗口这一档时，两个 provider 都不问宿主", async () => {
    const seen: Array<{ includeWindowText?: boolean }> = [];
    const registry = createDefaultContextRegistry(
      host({ windowTextStatus: "captured", windowText: "文字" }, seen),
      { segments: () => [] },
    );
    await registry.assemble({
      settings: { ...ALL_ON, windowEnabled: false },
      now: NOW,
    });
    expect(seen).toHaveLength(0);
  });
});

describe("voice:context 源：按分钟窗口取近期语音", () => {
  const segments = [
    { wallStartMs: NOW - 20 * 60_000, transcriptText: "二十分钟前" },
    { wallStartMs: NOW - 6 * 60_000, transcriptText: "六分钟前" },
    { wallStartMs: NOW - 3 * 60_000, transcriptText: "三分钟前" },
    { wallStartMs: NOW - 30_000, transcriptText: "半分钟前" },
    { wallStartMs: NOW - 10_000, transcriptText: "   " },
    { wallStartMs: NOW - 5_000, transcriptText: null },
  ];

  test("只取窗口内的段，且按时间正序", async () => {
    const provider = createRecentVoiceProvider({ segments: () => segments });
    const outcome = await provider.collect({ settings: ALL_ON, now: NOW });
    expect(outcome).toEqual({ status: "collected", text: "三分钟前\n半分钟前" });
  });

  test("换一档时间范围就换一批素材", async () => {
    const provider = createRecentVoiceProvider({ segments: () => segments });
    const wide = await provider.collect({
      settings: { ...ALL_ON, recentVoiceRangeMinutes: 10 },
      now: NOW,
    });
    expect(wide).toEqual({ status: "collected", text: "六分钟前\n三分钟前\n半分钟前" });
    const narrow = await provider.collect({
      settings: { ...ALL_ON, recentVoiceRangeMinutes: 1 },
      now: NOW,
    });
    expect(narrow).toEqual({ status: "collected", text: "半分钟前" });
  });

  test("用时现拉：每次组装都重新问一次，不读只在开界面时更新的缓存", async () => {
    let calls = 0;
    const provider = createRecentVoiceProvider({
      segments: async () => {
        calls += 1;
        return [{ wallStartMs: NOW - 1_000, transcriptText: "刚说的" }];
      },
    });
    await provider.collect({ settings: ALL_ON, now: NOW });
    await provider.collect({ settings: ALL_ON, now: NOW });
    expect(calls).toBe(2);
  });

  test("拉取失败只降级，不把语音输入拖下水", async () => {
    const provider = createRecentVoiceProvider({
      segments: async () => {
        throw new Error("Host 不给");
      },
    });
    expect(await provider.collect({ settings: ALL_ON, now: NOW })).toEqual({
      status: "skipped",
      reason: "unavailable",
    });
  });

  test("关掉时不取；窗口内没有可用转写时是 empty", async () => {
    const provider = createRecentVoiceProvider({ segments: () => segments });
    expect(
      await provider.collect({
        settings: { ...ALL_ON, recentVoiceEnabled: false },
        now: NOW,
      }),
    ).toEqual({ status: "skipped", reason: "disabled" });

    const silent = createRecentVoiceProvider({
      segments: () => [{ wallStartMs: NOW - 1_000, transcriptText: "  " }],
    });
    expect(await silent.collect({ settings: ALL_ON, now: NOW })).toEqual({
      status: "skipped",
      reason: "empty",
    });
  });
});

describe("默认注册表：voice:context 与窗口文字一起组装成 envelope", () => {
  test("三源齐备时窗口文字排在近期语音之前，appCategory 一并带上", async () => {
    const registry = createDefaultContextRegistry(
      host({
        windowTextStatus: "captured",
        windowText: "Hi Alex, about the launch plan",
        appCategory: "email",
        screenRecording: "granted",
      }),
      { segments: () => [{ wallStartMs: NOW - 60_000, transcriptText: "刚才说的发布节奏" }] },
    );
    const { envelope, outcomes } = await registry.assemble({ settings: ALL_ON, now: NOW });

    expect(outcomes.map((item) => item.id)).toEqual([
      VOICE_CONTEXT_SOURCES.windowText,
      VOICE_CONTEXT_SOURCES.windowScreenshot,
      VOICE_CONTEXT_SOURCES.recentVoice,
    ]);
    expect(envelope?.version).toBe("1");
    expect(envelope?.appCategory).toBe("email");
    expect(envelope?.nearbyText).toContain("Hi Alex, about the launch plan");
    expect(envelope?.nearbyText).toContain("刚才说的发布节奏");
    expect(envelope?.nearbyText?.indexOf("Hi Alex")).toBeLessThan(
      envelope?.nearbyText?.indexOf("刚才说的") ?? -1,
    );
  });

  test("窗口这一档整体关掉时，envelope 里只剩 voice:context", async () => {
    const registry = createDefaultContextRegistry(
      host({ windowTextStatus: "captured", windowText: "不该出现", appCategory: "editor" }),
      { segments: () => [{ wallStartMs: NOW - 60_000, transcriptText: "只剩这句" }] },
    );
    const { envelope } = await registry.assemble({
      settings: { ...ALL_ON, windowEnabled: false },
      now: NOW,
    });
    expect(envelope?.nearbyText).toBe("【最近说过的话】\n只剩这句");
    expect(envelope?.appCategory).toBeUndefined();
  });

  test("两档都关时不产出 envelope（也就不会有任何上下文被发出去）", async () => {
    const registry = createDefaultContextRegistry(
      host({ windowTextStatus: "captured", windowText: "不该出现" }),
      { segments: () => [{ wallStartMs: NOW, transcriptText: "也不该出现" }] },
    );
    const { envelope } = await registry.assemble({
      settings: { windowEnabled: false, recentVoiceEnabled: false, recentVoiceRangeMinutes: 5 },
      now: NOW,
    });
    expect(envelope).toBeUndefined();
  });
});

test("并发 assemble 的窗口文字和截图各自来自同一快照", async () => {
  const pending: Array<(capture: VoiceContextCapture) => void> = [];
  const registry = createDefaultContextRegistry({
    capture: () => new Promise((resolve) => pending.push(resolve)),
  }, { segments: () => [] });
  const input = { ...WITH_SCREENSHOT, now: NOW };
  const first = registry.assemble(input);
  const second = registry.assemble(input);
  expect(pending).toHaveLength(2);
  const snapshot = (text: string, dataBase64: string): VoiceContextCapture => ({
    windowTextStatus: "captured", windowText: text, screenRecording: "granted", sessionEpoch: "epoch",
    windowScreenshot: { mime: "image/jpeg", dataBase64, width: 10, height: 10 },
  });
  pending[0]!(snapshot("fixture-A", "QQ=="));
  // Let the first assembly advance to its screenshot provider while B is pending.
  await new Promise((resolve) => setTimeout(resolve, 0));
  pending[1]!(snapshot("fixture-B", "Qg=="));
  const [a, b] = await Promise.all([first, second]);
  expect(a.envelope?.nearbyText).toContain("fixture-A");
  expect(a.envelope?.images?.[0]?.dataBase64).toBe("QQ==");
  expect(b.envelope?.nearbyText).toContain("fixture-B");
  expect(b.envelope?.images?.[0]?.dataBase64).toBe("Qg==");
  expect(pending).toHaveLength(2);
});

test("旧 window=true 无独立截图同意时，Host 请求与输出均不带图", async () => {
  const seen: unknown[] = [];
  const registry = createDefaultContextRegistry({ async capture(options) {
    seen.push(options);
    return { windowTextStatus: "captured", windowText: "fixture", screenRecording: "granted", sessionEpoch: "epoch",
      windowScreenshot: { mime: "image/jpeg", width: 10, height: 10, dataBase64: "QQ==" } };
  } }, { segments: () => [] });
  const result = await registry.assemble({ settings: ALL_ON, now: NOW });
  expect(seen).toEqual([{ includeWindowText: true, includeWindowScreenshot: false }]);
  expect(result.envelope?.images).toBeUndefined();
  expect(JSON.stringify(result)).not.toContain("QQ==");
});

test("截图开关与窗口文字独立，但必须核原 Host epoch", async () => {
  let received: unknown;
  const registry = createDefaultContextRegistry({ async capture(options) {
    received = options;
    return { windowTextStatus: "not_requested", screenRecording: "granted", sessionEpoch: "other-epoch",
      windowScreenshot: { mime: "image/jpeg", width: 10, height: 10, dataBase64: "QQ==" } };
  } }, { segments: () => [] });
  const result = await registry.assemble({ ...WITH_SCREENSHOT, settings: { ...WITH_SCREENSHOT.settings, windowEnabled: false }, now: NOW });
  expect(received).toEqual({ includeWindowText: false, includeWindowScreenshot: true, sessionId: "voice-session", consentEpoch: "epoch" });
  expect(result.envelope?.images).toBeUndefined();
  expect(JSON.stringify(result)).not.toContain("QQ==");
});

test("截图等待返回时撤销，或后续源等待时撤销，都不保留图片", async () => {
  for (const revokeInCapture of [true, false]) {
    let allowed = true;
    const registry = createDefaultContextRegistry({ async capture() {
      if (revokeInCapture) allowed = false;
      return { windowTextStatus: "captured", windowText: "fixture", screenRecording: "granted", sessionEpoch: "epoch",
        windowScreenshot: { mime: "image/jpeg", width: 10, height: 10, dataBase64: "QQ==" } };
    } }, { segments: async () => { allowed = false; return []; } });
    const result = await registry.assemble({ ...WITH_SCREENSHOT, screenshot: { ...GRANT, isCurrent: () => allowed }, now: NOW });
    expect(result.envelope?.images).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("QQ==");
  }
});
