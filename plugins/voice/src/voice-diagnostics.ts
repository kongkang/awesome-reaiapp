import { HOST_API_VERSION } from "@reai/app-sdk/v1";
import { bindText, t, readText, type TextSource } from "./voice-i18n";
import { collectErrorFields, isCollectedFields, structuredCode, type VoiceErrorFields, type VoiceErrorSource } from "./voice-error-fields";
import { constantReasonForCode } from "./voice-failure-labels";
import type { VoiceErrorDetail } from "./data";
import { appId as manifestAppId, version as manifestVersion } from "../app.manifest.json";
import { HOST_VERSION_TIMEOUT_MS } from "./voice-host-version";
import { agentFailureFields, type AgentFailureFields } from "./agent-failure-stage";
import { agentStageLabel } from "./agent-failure-copy";
/**
 * Voice 等待 / 失败 / 超时的最低信息量（设计规范 §6.0 #waiting-failure-minimum；口径照 Host 内核门禁的
 * `KernelDiagnostics.vue` + `kernel-diagnostics.ts`，PR #941）：
 * ① 当前在做什么（步骤；等待时带已用时间）② 真实错误码与原始原因 ③ 插件版本与 Host 版本
 * ④ 真实可用的「查看诊断」：列出上述字段并一键复制全文。
 *
 * 复制文本与浮层是**白名单结构**：只由步骤、错误码、来源类别、HTTP 状态码、耗时、计数 / ID、
 * 两端版本、时间组成；上游原文只写「已省略（N 字符）」。原文本身只在插件自己的界面、用户主动
 * 展开时显示（见 voice-diagnostics-view），不复制、不落盘、不进浮层。
 * 模型同理（2.14.3）：只有登记表里的内置 / 云端 ID 原样写，其余写「自定义模型」（voice-model-registry）。
 */

/**
 * 插件自身身份与版本：构建时从 app.manifest.json 读入，不另写一份常量（§6.0 ②）。
 * 只取 appId / version 两个字段，打包器不必把整份 Manifest 带进产物。
 */
export const VOICE_PLUGIN_ID: string = manifestAppId;
export const VOICE_PLUGIN_VERSION: string = manifestVersion;
/** Host 内置 SDK 运行时的 Host API 版本（SDK 被 external，运行时即 Host 那份）；不代替 App 版本。 */
export const VOICE_HOST_API_VERSION: string = HOST_API_VERSION;

export type VoiceDiagnosticState = "waiting" | "failed" | "timeout";

/**
 * Host（Driver App）版本：只能在 Voice 页可见时经 `system.tasks@1` 读取。
 * unread = 本次运行还没有可见 Surface、未发请求；timeout = 本地等 5 秒未返回（Host 请求可能仍在进行）。
 * rejected 只留错误码；`missing` = Host 回了版本状态但没有版本号。
 */
export interface VoiceHostVersion {
  state: "unread" | "loading" | "ready" | "rejected" | "timeout";
  version?: string;
  code?: string;
  missing?: boolean;
}

/**
 * 插件固定标签（不是上游值，也不是用户起的名字）：目前只有「自定义模型」，可附来源类别。
 * 没登记的模型 ID / 名字可能是含用户名的文件路径或用户自取的名字，复制时只写这个标签
 * （见 voice-model-registry）。
 */
export interface VoiceFixedLabelToken {
  readonly fixedLabel: "customModel";
  readonly source?: "local" | "cloud";
}

/** 复制文本里的结构化值：ID / 状态枚举 / 版本号（按标识符文法接收）、数字或插件固定标签。 */
export type VoiceDiagnosticToken = string | number | null | undefined | VoiceFixedLabelToken;

export interface VoiceDiagnosticDetail {
  label: TextSource;
  /** 界面显示值（可含显示名）；不给就显示 `tokens`。只在插件自己的界面里出现，不复制。 */
  value?: TextSource;
  /** 进复制文本的结构化值；不给就只在界面显示，复制文本写「仅界面可见」。 */
  tokens?: () => readonly VoiceDiagnosticToken[];
}

/** 没有原文时的如实说明（固定文案）。 */
export type VoiceRawNote = "hostNotProvided" | "notRecorded";

export interface VoiceDiagnosticEntry {
  state: VoiceDiagnosticState;
  /**
   * 当前步骤：插件自己的文案，参数只放目录里的名称（工具；模型只经 `diagnosticModelName` 取登记名，
   * 没登记的写「自定义模型」），不放用户内容。
   */
  step: TextSource;
  /** 该步骤开始的时刻（ms）。 */
  sinceMs?: number;
  /** 起点只是「本页首次看到」：文案写「已等待至少 N 秒（自打开页面起）」。 */
  sinceObserved?: boolean;
  /** 失败 / 超时结束的时刻：有它就冻结为「用时 N 秒」，不再随时钟增长。 */
  endMs?: number;
  code?: string;
  upstreamCodes?: readonly string[];
  source?: VoiceErrorSource;
  httpStatus?: number;
  /** 原始技术原文（只在内存）：只给界面上用户主动展开时显示。 */
  raw?: string;
  /** 原文字符数（复制只写这个）。有字符数而没有原文 = 原文没保留（例如重启后的历史条目）。 */
  rawLength?: number;
  rawNote?: VoiceRawNote;
  /** 没登记的码的个数：复制只写个数，码本身在展开区的原文里。 */
  omittedCodes?: number;
  /** Agent 引擎失败的 Host 阶段、退出码、方括号上游码：渲染与复制时逐值校验，不合规的不写。 */
  agentFailure?: AgentFailureFields;
  /** 插件固定文案的 i18n 键（「说明」行）；不收任意文本。 */
  noteKey?: string;
  /** 发生时间（ISO）。 */
  at?: string;
  /** `detected` = 中断恢复时才发现的时间，不冒充失败时刻。 */
  atKind?: "occurred" | "detected";
  /** 对象状态（录音 id、识别方式、模型、联网调用……）。 */
  details?: readonly VoiceDiagnosticDetail[];
}

/** 步骤键 → 本地化步骤名（`diagnostics.step.*`）。 */
export function stepText(step: string): string {
  return t(`diagnostics.step.${step}`);
}

/** 失败出口的诊断：步骤键 + 结构化字段 + 发生时间；原文只随界面状态留在内存。 */
export function errorDetailFrom(
  step: string,
  cause: unknown,
  options: { sinceMs?: number; at?: Date; code?: string; fields?: VoiceErrorFields } = {},
): VoiceErrorDetail {
  // 只接收本模块采集出的字段（按出身）；外部对象不认，改从 cause 重新采集。
  const fields = isCollectedFields(options.fields) ? options.fields : collectErrorFields(cause, { code: options.code });
  return {
    step,
    ...(fields.code ? { code: fields.code } : {}),
    ...(fields.upstreamCodes.length ? { upstreamCodes: fields.upstreamCodes } : {}),
    ...(fields.source ? { source: fields.source } : {}),
    ...(fields.httpStatus !== undefined ? { httpStatus: fields.httpStatus } : {}),
    ...(fields.rawLength ? { rawLength: fields.rawLength } : {}),
    ...(fields.raw ? { raw: fields.raw } : {}),
    ...(fields.omittedCodes ? { omittedCodes: fields.omittedCodes } : {}),
    ...(fields.agentFailure ? { agentFailure: fields.agentFailure } : {}),
    at: (options.at ?? new Date()).toISOString(),
    ...(options.sinceMs !== undefined ? { sinceMs: options.sinceMs } : {}),
  };
}

/** 码里带 TIMEOUT 的算超时（真实码判断，不猜）；其余算失败。 */
export function failureState(code: string | undefined): VoiceDiagnosticState {
  return code && /TIMEOUT|TIMED_OUT/.test(code) ? "timeout" : "failed";
}

/** 界面状态里的诊断 → 渲染用条目。 */
export function entryFromErrorDetail(detail: VoiceErrorDetail, extra: Partial<VoiceDiagnosticEntry> = {}): VoiceDiagnosticEntry {
  const endMs = Date.parse(detail.at);
  return {
    state: failureState(detail.code),
    step: () => stepText(detail.step),
    ...(detail.code ? { code: detail.code } : {}),
    ...(detail.upstreamCodes ? { upstreamCodes: detail.upstreamCodes } : {}),
    ...(detail.source ? { source: detail.source } : {}),
    ...(detail.httpStatus !== undefined ? { httpStatus: detail.httpStatus } : {}),
    ...(detail.raw ? { raw: detail.raw } : {}),
    ...(detail.rawLength ? { rawLength: detail.rawLength } : {}),
    ...(detail.omittedCodes ? { omittedCodes: detail.omittedCodes } : {}),
    ...(detail.agentFailure ? { agentFailure: detail.agentFailure } : {}),
    ...(detail.noteKey ? { noteKey: detail.noteKey } : {}),
    at: detail.at,
    ...(detail.sinceMs !== undefined && Number.isFinite(endMs) ? { sinceMs: detail.sinceMs, endMs } : {}),
    ...extra,
  };
}

/** 时长：< 60 秒写秒，< 1 小时写分秒，再长写时分。 */
export function durationText(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return t("diagnostics.duration.seconds", { seconds: total });
  if (total < 3600) return t("diagnostics.duration.minutes", { minutes: Math.floor(total / 60), seconds: total % 60 });
  return t("diagnostics.duration.hours", { hours: Math.floor(total / 3600), minutes: Math.floor((total % 3600) / 60) });
}

/** 已用 / 用时 / 已等待至少：给界面计时节点与诊断文本共用。 */
export function elapsedLabel(entry: Pick<VoiceDiagnosticEntry, "sinceMs" | "sinceObserved" | "endMs">, now = Date.now()): string {
  if (entry.sinceMs === undefined) return "";
  if (entry.endMs !== undefined) return t("diagnostics.took", { duration: durationText(entry.endMs - entry.sinceMs) });
  const duration = durationText(now - entry.sinceMs);
  return entry.sinceObserved ? t("diagnostics.elapsedObserved", { duration }) : t("diagnostics.elapsed", { duration });
}

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9_.:#@/+-]{0,127}$/;
/** App 版本号文法：semver（可带预发布 / 构建后缀）。 */
const VERSION = /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,64})?(?:\+[0-9A-Za-z.-]{1,64})?$/;

/** 结构化值的接收文法（只接收或省略，不改写）：ASCII、无空白的 ID / 枚举 / 版本号，或有限数字。 */
export function structuredToken(value: VoiceDiagnosticToken): string {
  if (value === null || value === undefined) return t("diagnostics.none");
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : t("diagnostics.tokenOmitted");
  if (typeof value === "object") return fixedLabelText(value);
  return typeof value === "string" && TOKEN.test(value) ? value : t("diagnostics.tokenOmitted");
}

/** 固定标签只认登记的种类与来源枚举；其余一律「已省略」。 */
function fixedLabelText(value: VoiceFixedLabelToken): string {
  if (value.fixedLabel !== "customModel") return t("diagnostics.tokenOmitted");
  const label = t("diagnostics.customModel");
  return value.source === "local" || value.source === "cloud" ? `${label} (${value.source})` : label;
}

export function hostVersionLabel(host: VoiceHostVersion | undefined): string {
  switch (host?.state) {
    case "ready": return host.version && VERSION.test(host.version) ? host.version : t("diagnostics.host.invalidVersion");
    case "loading": return t("diagnostics.host.loading");
    case "rejected": return host.missing ? t("diagnostics.host.missingVersion")
      : t("diagnostics.host.rejected", { code: structuredCode(host.code) ?? t("diagnostics.none") });
    case "timeout": return t("diagnostics.host.timeout", { seconds: HOST_VERSION_TIMEOUT_MS / 1000 });
    default: return t("diagnostics.host.unread");
  }
}

/** 状态行上的版本：`Voice 2.14.1-rc.1 · App 1.0.0-rc.1`。 */
export function versionsLabel(host: VoiceHostVersion | undefined): string {
  return t("diagnostics.versions", { plugin: VOICE_PLUGIN_VERSION, host: hostVersionLabel(host) });
}

export function stepLabel(entry: VoiceDiagnosticEntry, now = Date.now()): string {
  const step = readText(entry.step);
  const elapsed = elapsedLabel(entry, now);
  return elapsed ? `${step} · ${elapsed}` : step;
}

/** 复制用的「原始原因」：只写字符数或固定说明，从不写原文。 */
export function rawReasonLabel(entry: VoiceDiagnosticEntry): string {
  if (safeCount(entry.rawLength)) return t("diagnostics.rawOmitted", { chars: safeCount(entry.rawLength)! });
  return entry.rawNote ? t(`diagnostics.${entry.rawNote}`) : t("diagnostics.none");
}

export function stateLabel(state: VoiceDiagnosticState): string {
  return t(`diagnostics.state.${state}`);
}

const SOURCES: ReadonlySet<string> = new Set(["host", "cloud", "agent", "local"]);
/** 来源类别只认四个枚举值；不认得的返回 undefined（调用方不写这一行）。 */
export function sourceLabel(source: unknown): string | undefined {
  return typeof source === "string" && SOURCES.has(source) ? `${t(`diagnostics.sourceKind.${source}`)} (${source})` : undefined;
}

/**
 * Agent 阶段的诊断行（键, 值）：阶段码查登记表（旁边附本地化名称）、退出码限 i32 整数、上游码查登记表，
 * 逐值接收，不合规的不写。复制全文、浮层与界面诊断区共用这一份。
 */
export function agentFailureRows(value: unknown): Array<[label: string, value: string]> {
  const fields = agentFailureFields(value);
  if (!fields) return [];
  const rows: Array<[string, string]> = [[t("diagnostics.agentStage"), `${agentStageLabel(fields.agentStage)} (${fields.agentStage})`]];
  if (fields.exitCode !== undefined) rows.push([t("diagnostics.exitCode"), String(fields.exitCode)]);
  if (fields.upstreamCode) rows.push([t("diagnostics.engineUpstreamCode"), fields.upstreamCode]);
  return rows;
}

/** 字数 / 个数：正的安全整数才用。 */
export function safeCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** 复制文本里的对象状态值：只有结构化 tokens；没有就写「仅界面可见」。 */
export function detailCopyValue(detail: VoiceDiagnosticDetail): string {
  const tokens = detail.tokens?.();
  return tokens ? tokens.map(structuredToken).join(" · ") || t("diagnostics.none") : t("diagnostics.panelOnly");
}

/** 界面上的对象状态值：显示值优先，否则同复制值。 */
export function detailDisplayValue(detail: VoiceDiagnosticDetail): string {
  return detail.value !== undefined ? readText(detail.value) || t("diagnostics.none") : detailCopyValue(detail);
}

function isoTime(value: string | undefined): string | undefined {
  const ms = value ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

/**
 * 「复制诊断信息」全文（白名单）：支持人员拿到就能定位卡在哪一步、什么码、哪个版本。
 * 每一行都来自插件固定文案或结构化字段；上游原文只写「已省略（N 字符）」。
 */
export function buildVoiceDiagnosticsText(
  entry: VoiceDiagnosticEntry,
  host: VoiceHostVersion | undefined,
  now = Date.now(),
): string {
  const none = t("diagnostics.none");
  const code = structuredCode(entry.code);
  const upstream = (entry.upstreamCodes ?? []).map(structuredCode).filter((item): item is string => !!item);
  const reason = constantReasonForCode(code);
  const at = isoTime(entry.at);
  const details = entry.details ?? [];
  const lines = [
    `ReAI Board Voice ${t("diagnostics.title")}`,
    `${t("diagnostics.pluginVersion")}: ${VOICE_PLUGIN_ID} ${VOICE_PLUGIN_VERSION}`,
    `${t("diagnostics.hostVersion")}: ${hostVersionLabel(host)}`,
    `Host API: ${VOICE_HOST_API_VERSION}`,
    `${t("diagnostics.status")}: ${stateLabel(entry.state)} (${entry.state})`,
    `${t("diagnostics.current")}: ${stepLabel(entry, now)}`,
    ...(entry.noteKey ? [`${t("diagnostics.message")}: ${t(entry.noteKey)}`] : []),
    `${t("diagnostics.errorCode")}: ${code ?? none}`,
    ...(upstream.length ? [`${t("diagnostics.upstreamCodes")}: ${upstream.join(", ")}`] : []),
    ...(safeCount(entry.omittedCodes) ? [`${t("diagnostics.omittedCodes")}: ${t("diagnostics.omittedCodesValue", { count: safeCount(entry.omittedCodes)! })}`] : []),
    ...agentFailureRows(entry.agentFailure).map(([label, value]) => `${label}: ${value}`),
    ...(sourceLabel(entry.source) ? [`${t("diagnostics.source")}: ${sourceLabel(entry.source)}`] : []),
    ...(typeof entry.httpStatus === "number" ? [`${t("diagnostics.httpStatus")}: ${structuredToken(entry.httpStatus)}`] : []),
    ...(reason ? [`${t("diagnostics.codeReason")}: ${reason}`] : []),
    `${t("diagnostics.rawReason")}: ${rawReasonLabel(entry)}`,
    ...(at ? [`${t(entry.atKind === "detected" ? "diagnostics.detectedAt" : "diagnostics.occurredAt")}: ${at}`] : []),
    ...(details.length
      ? [`${t("diagnostics.details")}:`, ...details.map((item) => `  - ${readText(item.label)}: ${detailCopyValue(item)}`)]
      : []),
    // §6.0 ④ 日志位置：插件拿不到 App 的日志目录（没有这个接口），如实写日志去了哪儿、目录在哪能看到。
    `${t("diagnostics.logLocation")}: ${t("diagnostics.logLocationValue")}`,
    `${t("diagnostics.generatedAt")}: ${new Date(now).toISOString()}`,
  ];
  return lines.join("\n");
}

/**
 * 浮层（Host 结果面板 / 任务卡 / 取回卡）专用的安全投影：只有步骤、错误码、两端版本、时间。
 * 结构上不接受原文——浮层对旁人与屏幕共享可见（§6.0 ⑧）。
 */
export function safeOverlayDiagnostics(
  entry: Pick<VoiceDiagnosticEntry, "step" | "code" | "agentFailure">,
  host: VoiceHostVersion | undefined,
  now = Date.now(),
): string {
  return [
    `ReAI Board Voice ${t("diagnostics.title")}`,
    `${t("diagnostics.pluginVersion")}: ${VOICE_PLUGIN_ID} ${VOICE_PLUGIN_VERSION}`,
    `${t("diagnostics.hostVersion")}: ${hostVersionLabel(host)}`,
    `Host API: ${VOICE_HOST_API_VERSION}`,
    `${t("diagnostics.current")}: ${readText(entry.step)}`,
    `${t("diagnostics.errorCode")}: ${structuredCode(entry.code) ?? t("diagnostics.none")}`,
    // Agent 阶段 / 退出码 / 上游码同属结构化字段（登记表值与整数），可以上浮层；原文照旧不上。
    ...agentFailureRows(entry.agentFailure).map(([label, value]) => `${label}: ${value}`),
    `${t("diagnostics.generatedAt")}: ${new Date(now).toISOString()}`,
  ].join("\n");
}

/** Host结果窗已经注入不可伪造的版本身份；正文只投影步骤/码/时间，
 * 不复制插件可见页版本查询的失败快照，也不把插件查询App版本的静态快照当成第二事实源。
 * Host页脚与“复制诊断”继续使用registry/进程生成的hostDiagnostics。 */
export function safeHostResultDiagnostics(
  entry: Pick<VoiceDiagnosticEntry, "step" | "code" | "agentFailure">,
  now = Date.now(),
): string {
  return [
    `ReAI Board Voice ${t("diagnostics.title")}`,
    `${t("diagnostics.pluginVersion")}: ${VOICE_PLUGIN_ID} ${VOICE_PLUGIN_VERSION}`,
    `Host API: ${VOICE_HOST_API_VERSION}`,
    `${t("diagnostics.current")}: ${readText(entry.step)}`,
    `${t("diagnostics.errorCode")}: ${structuredCode(entry.code) ?? t("diagnostics.none")}`,
    ...agentFailureRows(entry.agentFailure).map(([label, value]) => `${label}: ${value}`),
    `${t("diagnostics.generatedAt")}: ${new Date(now).toISOString()}`,
  ].join("\n");
}

/**
 * 胶囊里的紧凑已用时间：「 · 3 秒」。不足 1 秒不显示（刚进入的瞬间不闪一个「0 秒」）；
 * 完整口径（已用 / 已等待至少…自打开页面起）在活动行与诊断区里。
 */
export function compactElapsedLabel(sinceMs: number, now = Date.now()): string {
  return now - sinceMs < 1000 ? "" : ` · ${durationText(now - sinceMs)}`;
}

/** 已用时间节点：视图每秒调一次 `tickVoiceElapsed` 就地更新，不整页重渲染。 */
export function elapsedNode(
  entry: Pick<VoiceDiagnosticEntry, "sinceMs" | "sinceObserved" | "endMs">,
  slowAfterMs?: number,
  compact = false,
): HTMLElement {
  const node = document.createElement("span");
  node.className = compact ? "voice-cap-elapsed" : "voice-diag-elapsed";
  // 接入既有文本绑定：切语言时（含冻结的「用时」）立即换成新语言；每秒刷新只改这个绑定拥有的 Text 节点。
  bindText(node, () => compact && entry.sinceMs !== undefined ? compactElapsedLabel(entry.sinceMs) : elapsedLabel(entry));
  if (entry.sinceMs !== undefined && entry.endMs === undefined) {
    node.dataset.voiceElapsedSince = String(entry.sinceMs);
    if (entry.sinceObserved) node.dataset.voiceElapsedObserved = "true";
    if (compact) node.dataset.voiceElapsedCompact = "true";
    if (slowAfterMs !== undefined) node.dataset.voiceSlowAfter = String(slowAfterMs);
  }
  return node;
}

/** 每秒就地刷新已用时间；跨过慢阈值时给最近的 `[data-voice-slow-scope]` 打标（不依赖后续状态事件）。 */
export function tickVoiceElapsed(root: ParentNode, now = Date.now()): number {
  const nodes = Array.from(root.querySelectorAll<HTMLElement>("[data-voice-elapsed-since]"));
  for (const node of nodes) {
    const since = Number(node.dataset.voiceElapsedSince);
    if (!Number.isFinite(since)) continue;
    const next = node.dataset.voiceElapsedCompact === "true"
      ? compactElapsedLabel(since, now)
      : elapsedLabel({ sinceMs: since, sinceObserved: node.dataset.voiceElapsedObserved === "true" }, now);
    const text = node.firstChild;
    if (text?.nodeType === Node.TEXT_NODE) {
      if (text.textContent !== next) text.textContent = next;
    } else if (node.textContent !== next) node.textContent = next;
    const slowAfter = Number(node.dataset.voiceSlowAfter);
    const scope = node.closest<HTMLElement>("[data-voice-slow-scope]");
    if (scope && Number.isFinite(slowAfter)) {
      const slow = now - since >= slowAfter;
      if ((scope.dataset.slow === "true") !== slow) scope.dataset.slow = String(slow);
    }
  }
  return nodes.length;
}
