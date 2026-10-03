import { t } from "./voice-i18n";
/**
 * 润色上下文的**可插拔 provider**（拍板结论 6）。
 *
 * ## 为什么是注册表而不是三个 if
 *
 * 上下文源会长：今天是窗口文字 / 窗口截图 / 近期语音，明天可能是选中的文件、当前
 * 分支的 diff、日历上的下一场会。写成三个分支的话，每加一个源就要改一次组装逻辑、
 * 改一次设置页、改一次测试。做成注册表之后，加一个源 = 写一个 provider 并注册，
 * 组装与呈现一行不动。
 *
 * ## 每个 provider 都必须能「说清楚自己为什么没给」
 *
 * `collect()` 不允许抛错，只能返回 `collected` 或带原因的 `skipped`。原因是这层的
 * 失败**绝不能反过来阻断用户的语音输入**——上下文是锦上添花，为它把输入卡住是本
 * 末倒置。而原因要留着，设置页才能告诉用户「这一档现在为什么是灰的」。
 *
 * 截图独立默认关闭，只在显式同意的登录代际与原 Voice 会话仍有效时请求；Host
 * 验证原窗口并做尺寸与编码上限。图片只用于当次润色，不落盘、不写进历史。
 */

import type { VoiceContextCapture, VoiceContextClient } from "@reai/app-sdk/v1";
import type { VoiceContextEnvelope } from "./voice-ai-contract";
import type { VoiceScreenshotGrant } from "./voice-screenshot-consent";

/** 组装进 envelope 的 `nearbyText` 总上限（字符）。 */
export const MAX_NEARBY_TEXT_CHARS = 2_000;
/**
 * 单个源在 `nearbyText` 里能占的上限（字符）。
 *
 * 实际配额取「这个常量」与「总上限按本次真正有内容的源数平分」两者的**较小值**——
 * 写死一个固定值时，源多起来的话第一个源就能吃光总额度，后面的源在总裁剪那一步被
 * 整段砍掉，而它们本来该有自己的份额。
 */
export const MAX_SOURCE_TEXT_CHARS = 1_200;

export const VOICE_CONTEXT_SOURCES = {
  windowText: "voice.context.window-text",
  windowScreenshot: "voice.context.window-screenshot",
  recentVoice: "voice.context.recent-voice",
} as const;

/** 一个源没给出内容的原因。全部会原样带到设置页与诊断里。 */
export type VoiceContextSkipReason =
  /** 用户在设置里关掉了这一档。 */
  | "disabled"
  /** 缺少宿主权限（辅助功能 / 屏幕录制 / 插件权限页未授权）。 */
  | "permission_denied"
  /** 有权限，但这次确实没有可用内容。 */
  | "empty"
  /** 前台应用在宿主的不采集名单里（终端、密码管理器）。有权限也不读。 */
  | "app_excluded"
  /** 采集本身失败（Host 报错、平台不支持）。 */
  | "unavailable";

export type VoiceContextOutcome =
  | {
      status: "collected";
      /** 拼进 `nearbyText` 的文字块；空串视为 `empty`。 */
      text?: string;
      /** 独立图片内容，不得拼进 nearbyText。 */
      images?: VoiceContextEnvelope["images"];
      appCategory?: VoiceContextEnvelope["appCategory"];
    }
  | {
      status: "skipped";
      reason: VoiceContextSkipReason;
      /**
       * 即使这一源没给出文字，它顺带查到的应用分类仍然有效。
       *
       * 焦点落在画布、按钮、没有 AX 文本的 WebView 上很常见——那时窗口文字是空的，
       * 但「用户正在用的是聊天软件还是邮件」照样成立，而这正是 `appCategory` 的全部用途。
       * 把它绑在 collected 上会让这条信息在最常见的场景里被白白扔掉。
       */
      appCategory?: VoiceContextEnvelope["appCategory"];
    };

export interface VoiceContextCollectInput {
  /** 只读的采集设置快照。provider 自己判断该不该参与。 */
  settings: VoiceContextSettings;
  /** 现在时刻（毫秒）。测试注入固定值，不读全局时钟。 */
  now: number;
  /** 只由显式同意控制器生成；撤销或原请求取消后立即失效。 */
  screenshot?: VoiceScreenshotGrant;
  signal?: AbortSignal;
}

export interface VoiceContextSettings {
  /** 窗口文字；不授予截图权限。 */
  windowEnabled: boolean;
  /** 独立截图开关；旧设置缺省始终关闭。 */
  screenshotEnabled?: boolean;
  /** 带上近期语音上下文（voice:context）。 */
  recentVoiceEnabled: boolean;
  /** 近期语音的时间范围（分钟）。 */
  recentVoiceRangeMinutes: number;
}

export interface VoiceContextProvider {
  /** 稳定 ID。设置页与诊断按它寻址，改名等于换一个源。 */
  id: string;
  /** 给人看的名字。 */
  label: string;
  /** Stable source caption in AI input, independent of interface language. */
  promptLabel?: string;
  collect(input: VoiceContextCollectInput): Promise<VoiceContextOutcome>;
}

export interface VoiceContextAssembly {
  /** 一个源都没给出内容时是 `undefined`——不发一个空壳 envelope 上去。 */
  envelope?: VoiceContextEnvelope;
  /** 每个源这次的结果，按注册顺序。 */
  outcomes: Array<{ id: string; label: string; outcome: VoiceContextOutcome }>;
}

/**
 * provider 注册表。
 *
 * 顺序即拼接顺序：先注册的先出现在 `nearbyText` 里。这一点是刻意暴露的——
 * 「当前窗口」比「十分钟前说过的话」更贴近此刻的语境，该排在前面。
 */
export class VoiceContextRegistry {
  private readonly providers: VoiceContextProvider[] = [];

  /**
   * 每次 `assemble` 开始前跑一次的钩子。
   *
   * 存在的唯一理由是让「一次组装内 Host 只被问一次」这种跨 provider 的合并有个
   * 明确的边界——没有边界的记忆化要么永不失效（读到陈旧的窗口内容），
   * 要么形同虚设。
   */
  constructor(private readonly beforeAssemble: () => void = () => {}) {}

  register(provider: VoiceContextProvider): this {
    const existing = this.providers.findIndex((item) => item.id === provider.id);
    // 同 id 覆盖而不是并存：并存会让同一个源出现两次，且没有任何界面能表达它。
    if (existing >= 0) this.providers[existing] = provider;
    else this.providers.push(provider);
    return this;
  }

  unregister(id: string): boolean {
    const index = this.providers.findIndex((item) => item.id === id);
    if (index < 0) return false;
    this.providers.splice(index, 1);
    return true;
  }

  list(): readonly VoiceContextProvider[] {
    return [...this.providers];
  }

  /**
   * 跑一遍全部 provider 并拼出 envelope。
   *
   * 任何 provider 抛错都会被当成 `unavailable` 记下来——provider 契约上不该抛，
   * 但一个写错的 provider 不能有本事让整条语音输入挂掉。
   */
  async assemble(input: VoiceContextCollectInput): Promise<VoiceContextAssembly> {
    this.beforeAssemble();
    // Callers may reuse the same options object concurrently. The collection
    // identity and settings snapshot belong to this assembly alone.
    const collection = { ...input, settings: { ...input.settings } };
    const outcomes: VoiceContextAssembly["outcomes"] = [];
    for (const provider of this.providers) {
      let outcome: VoiceContextOutcome;
      try {
        outcome = collection.signal?.aborted ? { status: "skipped", reason: "disabled" } : await provider.collect(collection);
      } catch {
        outcome = { status: "skipped", reason: "unavailable" };
      }
      outcomes.push({ id: provider.id, label: provider.label, outcome });
    }

    if (collection.signal?.aborted) return { outcomes: outcomes.map(({ id, label }) => ({ id, label, outcome: { status: "skipped", reason: "disabled" } })) };
    if (!screenshotOptions(collection)) {
      for (const item of outcomes) if (item.outcome.status === "collected" && item.outcome.images) {
        item.outcome = { status: "skipped", reason: "disabled" };
      }
    }
    let appCategory: VoiceContextEnvelope["appCategory"] | undefined;
    const texts: Array<{ label: string; text: string }> = [];
    const images: NonNullable<VoiceContextEnvelope["images"]> = [];
    for (const { id, label, outcome } of outcomes) {
      // 分类不看 status：没给出文字的源照样可能查到了应用类别。
      if (outcome.appCategory && !appCategory) appCategory = outcome.appCategory;
      if (outcome.status !== "collected") continue;
      if (outcome.images && images.length === 0 && screenshotOptions(collection)) images.push(...outcome.images.slice(0, 1));
      const text = outcome.text?.trim();
      if (!text) continue;
      texts.push({ label: this.providers.find((provider) => provider.id === id)?.promptLabel ?? label, text });
    }

    // 配额按**真正有内容的源数**平分，再与单源硬上限取小。写死单源上限时，
    // 第一个源能把总额度吃光，后面的源在最后那道总裁剪里整段消失。
    //
    // 标题与分隔符也要从预算里先扣掉，否则平分完再被总裁剪削一刀，削的又只是
    // 排在后面的源——那等于把「平分」白做了。
    const overhead = texts.reduce((sum, { label }) => sum + label.length + 3, 0)
      + Math.max(0, texts.length - 1) * 2;
    const share = texts.length > 0
      ? Math.floor((MAX_NEARBY_TEXT_CHARS - overhead) / texts.length)
      : 0;
    const perSource = Math.max(1, Math.min(MAX_SOURCE_TEXT_CHARS, share));
    const blocks = texts.map(({ label, text }) => `【${label}】\n${clampChars(text, perSource)}`);

    const nearbyText = clampChars(blocks.join("\n\n"), MAX_NEARBY_TEXT_CHARS);
    if (!nearbyText && !appCategory && images.length === 0) return { outcomes };
    return {
      envelope: {
        version: "1",
        ...(nearbyText ? { nearbyText } : {}),
        ...(appCategory ? { appCategory } : {}),
        ...(images.length > 0 ? { images } : {}),
      },
      outcomes,
    };
  }
}

/** 按字符裁剪。截断处补省略号，让模型知道这段是被截过的，不是原文就这么结束。 */
function clampChars(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…`;
}

/** 宿主采集口的窄依赖。测试注入假的，不必起一个 Mock Host。 */
export interface VoiceContextHost {
  capture: VoiceContextClient["capture"];
}

export interface MemoizedVoiceContextHost extends VoiceContextHost {
  /** 开始新一次组装：丢掉上一次的缓存。 */
  reset(): void;
}

/**
 * 把一次组装内的重复 capture 合并成一次。
 *
 * 窗口文字与截图两个 provider 都要问 Host，而截图那次只是为了读一个权限位——
 * 那个字段在第一次的返回里就有。这两次都压在「说完话到文字落地」的路上，合并掉一半
 * 是纯赚。缓存**必须**按组装边界失效：跨组装复用等于把上一次的窗口内容当成这一次的。
 *
 * 只要过 `includeWindowText: true`，`false` 的请求就复用它——但返回的是**剥掉窗口
 * 文字**的副本：没要文字的调用方不该顺手拿到文字，哪怕它自己不看。
 */
export function memoizeCapture(host: VoiceContextHost): MemoizedVoiceContextHost {
  const pending = new Map<string, Promise<VoiceContextCapture>>();
  const keyOf = (text: boolean, screenshot: boolean, sessionId?: string, consentEpoch?: string) => JSON.stringify([text, screenshot, sessionId, consentEpoch]);
  const strip = (
    capture: VoiceContextCapture,
    includeText: boolean,
    includeScreenshot: boolean,
  ): VoiceContextCapture => ({
    ...capture,
    ...(!includeText ? { windowText: undefined, windowTextStatus: "not_requested" as const } : {}),
    ...(!includeScreenshot ? { windowScreenshot: undefined } : {}),
  });
  return {
    reset() {
      pending.clear();
    },
    async capture(options) {
      const includeText = options?.includeWindowText === true;
      const includeScreenshot = options?.includeWindowScreenshot === true;
      const exact = keyOf(includeText, includeScreenshot, options?.sessionId, options?.consentEpoch);
      let request = pending.get(exact);
      if (!request) {
        // 已发出的超集请求可以服务子集；返回前仍剥掉调用方没有请求的字段。
        request = pending.get(keyOf(true, true, options?.sessionId, options?.consentEpoch));
      }
      if (!request) {
        request = host.capture({
          includeWindowText: includeText,
          includeWindowScreenshot: includeScreenshot,
          ...(options?.sessionId ? { sessionId: options.sessionId } : {}),
          ...(options?.consentEpoch ? { consentEpoch: options.consentEpoch } : {}),
        });
        pending.set(exact, request);
      }
      return strip(await request, includeText, includeScreenshot);
    },
  };
}

function screenshotOptions(input: VoiceContextCollectInput): { sessionId: string; consentEpoch: string } | undefined {
  if (input.signal?.aborted || input.settings.screenshotEnabled !== true || !input.screenshot?.isCurrent()) return undefined;
  const { sessionId, consentEpoch } = input.screenshot;
  return sessionId && consentEpoch ? { sessionId, consentEpoch } : undefined;
}

/**
 * 窗口内文字。
 *
 * 缺辅助功能权限 / 焦点控件没有文本，都只是 `skipped`——**不弹权限窗、不报错**。
 */
export function createWindowTextProvider(
  host: VoiceContextHost,
  includeWindowScreenshot = false,
): VoiceContextProvider {
  return {
    id: VOICE_CONTEXT_SOURCES.windowText,
    get label() { return t("context.message1"); },
    promptLabel: "当前窗口",
    async collect(input) {
      if (input.signal?.aborted || !input.settings.windowEnabled) return { status: "skipped", reason: "disabled" };
      const screenshot = includeWindowScreenshot ? screenshotOptions(input) : undefined;
      let capture: VoiceContextCapture;
      try {
        capture = await host.capture({ includeWindowText: true,
          ...(screenshot ? { includeWindowScreenshot: true, ...screenshot } : {}),
        });
      } catch {
        return { status: "skipped", reason: "permission_denied" };
      }
      if (input.signal?.aborted) return { status: "skipped", reason: "disabled" };
      // 分类跟着结果走，不跟着「有没有文字」走：焦点落在画布或按钮上时没有文字，
      // 但「用户正在用的是聊天软件还是邮件」照样成立。
      const appCategory = capture.appCategory;
      switch (capture.windowTextStatus) {
        case "captured":
          return { status: "collected", text: capture.windowText ?? "", appCategory };
        case "accessibility_denied":
          return { status: "skipped", reason: "permission_denied", appCategory };
        case "app_excluded":
          return { status: "skipped", reason: "app_excluded", appCategory };
        case "not_requested":
          return { status: "skipped", reason: "disabled", appCategory };
        default:
          return { status: "skipped", reason: "empty", appCategory };
      }
    },
  };
}

/**
 * 焦点窗口截图。
 *
 * 缺权限、Host 护栏拒绝、窗口切换或采集失败都只降级，不阻断语音输入。
 */
export function createWindowScreenshotProvider(host: VoiceContextHost): VoiceContextProvider {
  return {
    id: VOICE_CONTEXT_SOURCES.windowScreenshot,
    get label() { return t("context.message2"); },
    promptLabel: "当前窗口截图",
    async collect(input) {
      const screenshot = screenshotOptions(input);
      if (!screenshot) return { status: "skipped", reason: "disabled" };
      let capture: VoiceContextCapture;
      try {
        capture = await host.capture({ includeWindowText: false, includeWindowScreenshot: true, ...screenshot });
      } catch {
        return { status: "skipped", reason: "permission_denied" };
      }
      // The local grant is a fast cancellation fence; Host independently checks
      // the original epoch and window before and after its blocking capture.
      if (!screenshotOptions(input) || capture.sessionEpoch !== screenshot.consentEpoch) {
        return { status: "skipped", reason: "unavailable" };
      }
      if (capture.screenRecording !== "granted") {
        return { status: "skipped", reason: "permission_denied" };
      }
      if (!capture.windowScreenshot) {
        return { status: "skipped", reason: "unavailable" };
      }
      return { status: "collected", images: [capture.windowScreenshot] };
    },
  };
}

/** 近期语音上下文（voice:context）的一段。 */
export interface VoiceContextSegment {
  /** 墙钟开始时间（毫秒）。 */
  wallStartMs: number;
  /** 这一段的转写文本；没有转写的段直接不算数。 */
  transcriptText?: string | null;
}

export interface RecentVoiceSource {
  /**
   * 取近期语音段。**用时现拉**，不要读一份「只有打开过界面才更新」的缓存——
   * 输入法的主场景是按硬件键说话，那时插件界面通常压根没挂载过。
   *
   * 实现方负责有界（分页取一屏即可），失败时返回空数组而不是抛错。
   */
  segments(): Promise<readonly VoiceContextSegment[]> | readonly VoiceContextSegment[];
}

/**
 * 近期语音上下文。
 *
 * 时间窗按**设置里的分钟数**算，不按条数——用户调的是「最近多久」，
 * 按条数截会让说得多的人拿到更短的时间跨度，和他调的东西对不上。
 */
export function createRecentVoiceProvider(source: RecentVoiceSource): VoiceContextProvider {
  return {
    id: VOICE_CONTEXT_SOURCES.recentVoice,
    get label() { return t("context.message3"); },
    promptLabel: "最近说过的话",
    async collect({ settings, now }) {
      if (!settings.recentVoiceEnabled) return { status: "skipped", reason: "disabled" };
      const windowMs = Math.max(1, settings.recentVoiceRangeMinutes) * 60_000;
      const since = now - windowMs;
      let segments: readonly VoiceContextSegment[];
      try {
        segments = await source.segments();
      } catch {
        return { status: "skipped", reason: "unavailable" };
      }
      const lines = segments
        .filter((segment) => segment.wallStartMs >= since && segment.wallStartMs <= now)
        // 时间正序：先说的在前，模型才读得出话题是怎么走过来的。
        .sort((left, right) => left.wallStartMs - right.wallStartMs)
        .map((segment) => segment.transcriptText?.trim())
        .filter((text): text is string => Boolean(text));
      if (lines.length === 0) return { status: "skipped", reason: "empty" };
      return { status: "collected", text: lines.join("\n") };
    },
  };
}

/** 官方 Voice 的默认三源注册表，顺序即拼接顺序。 */
export function createDefaultContextRegistry(
  host: VoiceContextHost,
  recentVoice: RecentVoiceSource,
): VoiceContextRegistry {
  // A WeakMap keeps one memo per assembly identity, with no shared reset window.
  // Finishing A while B is pending can never redirect A to B's screenshot.
  const captures = new WeakMap<VoiceContextCollectInput, MemoizedVoiceContextHost>();
  const inAssembly = (factory: (captureHost: VoiceContextHost) => VoiceContextProvider): VoiceContextProvider => ({
    ...factory(host),
    collect(input) {
      let memo = captures.get(input);
      if (!memo) {
        memo = memoizeCapture(host);
        captures.set(input, memo);
      }
      return factory(memo).collect(input);
    },
  });
  return new VoiceContextRegistry()
    .register(inAssembly((captureHost) => createWindowTextProvider(captureHost, true)))
    .register(inAssembly(createWindowScreenshotProvider))
    .register(createRecentVoiceProvider(recentVoice));
}
