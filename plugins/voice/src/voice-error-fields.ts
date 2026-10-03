/**
 * 失败的结构化字段（设计规范 §6.0 #waiting-failure-minimum，白名单做法）。
 *
 * 复制出去的诊断、所有浮层与日志只由这里产出的字段组成：登记过的错误码、上游码、来源类别、
 * HTTP 状态码、原文字符数。上游原文（message / diagnostic / stderr …）一律**不做任何清洗**、也不进复制文本、
 * 不落盘、不进浮层；它只留在内存里，给插件自己的界面在用户主动展开时显示。
 *
 * 为什么不清洗：先收原文再用正则 / 解码去抹用户内容与凭据，是在追一个没有尽头的绕过清单
 * （编码层数、Unicode 组合字符、短凭据、数字串……）。白名单只放结构上不可能是用户内容的字段。
 */

import { registeredErrorCode } from "./voice-error-codes";
import { agentFailureFields, agentFailureStageOf, isAgentFailureStage, type AgentFailureStage } from "./agent-failure-stage";

export type VoiceErrorSource = "host" | "cloud" | "agent" | "local";

export interface VoiceErrorFields {
  /** 外层（最先抛出）的错误码；只收结构化 `code` 字段里登记过的值。 */
  code?: string;
  /** cause 链里更深一层的上游码（去重，不含外层）。 */
  upstreamCodes: string[];
  /** 来源类别：只按码的命名空间 / 失败合同字段判定，判不出就不写（不猜）。 */
  source?: VoiceErrorSource;
  /** 链上任一层结构化的 HTTP 状态码（100–599）。 */
  httpStatus?: number;
  /** 原始技术原文，未改动、只在内存：仅插件自己的界面、用户主动展开时显示。 */
  raw?: string;
  /** 原文字符数：复制文本只写「已省略（N 字符）」。 */
  rawLength?: number;
  /** 链上没登记的码的个数（码本身只进内存原文）。 */
  omittedCodes?: number;
  /** Agent 引擎失败的 Host 阶段、退出码与方括号上游码（只从原文前缀解析，见 agent-failure-stage）。 */
  agentFailure?: AgentFailureStage;
}

/**
 * 已采集字段按**出身**登记：只有本模块的采集函数构造出的对象在表里。外部对象即使字段同名同形
 * 也不算（形状可以伪造），消费方只取它经登记表校验的错误码，其余全丢。
 */
const COLLECTED = new WeakSet<object>();
function collected<T extends VoiceErrorFields>(fields: T): T {
  COLLECTED.add(fields);
  return fields;
}

/** 这个对象是不是本模块采集出来的字段（查登记表，不看形状）。 */
export function isCollectedFields(value: unknown): value is VoiceErrorFields {
  return typeof value === "object" && value !== null && COLLECTED.has(value);
}

const MAX_DEPTH = 4;
/** 内存里留的原文上限（界面展开用）；字符数按全文计。 */
const MAX_RAW_KEPT = 4000;

/**
 * 能导出的错误码：只认登记表里的值（`voice-error-codes.ts`：平台合同稳定码 + 插件自有码 + Host
 * Voice 接口码与枚举 + 浏览器标准异常名），不按长相判断——形似码的凭据、用户说的话都不会被当成码。
 * 没登记的码只留在内存原文里，并计入 `omittedCodes`。
 */
export function structuredCode(value: unknown): string | undefined {
  return registeredErrorCode(value);
}

/**
 * 码只从结构化 `code` 字段取。唯一例外：插件自己只把码写进 message 抛出的几处（没有 code 字段），
 * 整段 message 恰好是其中之一才认；其余自由文本（含「CODE: 说明」）一律不抠码——可能是用户内容。
 */
const PLUGIN_MESSAGE_CODES: ReadonlySet<string> = new Set([
  "VOICE_STATUS_REFRESH_TIMEOUT", "VOICE_START_TIMEOUT", "VOICE_START_CANCELLED",
  "VOICE_SETUP_CLOUD_UNAVAILABLE", "VOICE_SAVED_INPUT_NOT_FOUND", "HOST_API_INCOMPATIBLE",
]);
const exactCode = (text: string): string | undefined => PLUGIN_MESSAGE_CODES.has(text.trim()) ? text.trim() : undefined;
const GENERIC_NAMES = new Set(["Error", "AppError", "VoiceAppError", "TypeError"]);
const LOCAL_CODES = /^(?:com\.reai\.voice\/|POLISH_|DIGEST_)/;
const AGENT_CODES = /^(?:AGENT_|DSH_)/;
const HOST_CODES = /^(?:BRIDGE_|CAPABILITY_|SYSTEM_TASK_|SURFACE_|APP_|INTENT_)/;
/** Host 写回回执的类别码（小写枚举）。 */
export const DELIVERY_REASON_CODES: ReadonlySet<string> = new Set([
  "accessibility_permission_required", "voice_deliver_permission_required", "voice_deliver_unavailable",
  "expired", "focus_changed", "own_overlay_focused", "no_input_target", "not_editable", "not_received",
  "unknown_target", "denied", "insert_failed",
]);

function sourceOf(code: string | undefined, agentKind: boolean, httpStatus: number | undefined): VoiceErrorSource | undefined {
  if (code && LOCAL_CODES.test(code)) return "local";
  if (agentKind || (code && AGENT_CODES.test(code))) return "agent";
  if ((code && code.startsWith("AI_")) || httpStatus !== undefined) return "cloud";
  if (code && (HOST_CODES.test(code) || DELIVERY_REASON_CODES.has(code))) return "host";
  return undefined;
}

function statusOf(source: Record<string, unknown>): number | undefined {
  for (const key of ["httpStatus", "status", "statusCode"]) {
    const value = source[key];
    if (typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599) return value;
  }
  return undefined;
}

/**
 * 从任意异常取结构化字段：有界遍历 cause 链（深度 ≤ 4）。码只从结构化 `code` 字段取
 * 且须在登记表里（数字码写成「名称 code N」，只认 MediaError 1–4；没有 code 字段而 message 整段
 * 就是插件自己的固定码时取它），
 * HTTP 状态码只从数字字段取。原文（message / userMessage / diagnostic / kind / stderr_tail）
 * 原样拼接后只留内存，不做任何清洗。`override.code` 是调用方自己判定的码（如 `DSH_TIMEOUT`），
 * 作外层码，链上的码退为上游码。
 */
export function collectErrorFields(cause: unknown, override: { code?: string } = {}): VoiceErrorFields {
  const codes: string[] = [];
  const texts: string[] = [];
  const push = (text: unknown) => {
    if (typeof text !== "string") return;
    const value = text.trim();
    if (value && !texts.includes(value)) texts.push(value);
  };
  // 同一个没登记的码只计一次：插件错误原样沿用 Host 的失败码时，外层与 cause 上是同一个码。
  const omitted = new Set<string>();
  const pushCode = (value: unknown) => {
    if (typeof value !== "string" || !value.trim()) return;
    const code = structuredCode(value);
    if (!code) {
      // 没登记：不导出，只作为原文的一部分留在内存（界面展开可见）。
      omitted.add(value.trim());
      push(`code: ${value.trim()}`);
      return;
    }
    if (!codes.includes(code)) codes.push(code);
  };
  pushCode(override.code);
  let agentKind = false;
  let httpStatus: number | undefined;
  let current: unknown = cause;
  for (let depth = 0; depth <= MAX_DEPTH && current !== undefined && current !== null; depth += 1) {
    if (typeof current === "string") {
      pushCode(exactCode(current));
      push(current);
      break;
    }
    if (typeof current !== "object") { push(String(current)); break; }
    const source = current as Record<string, unknown>;
    const name = typeof source.name === "string" && !GENERIC_NAMES.has(source.name) ? source.name : undefined;
    if (typeof source.code === "string") pushCode(source.code);
    else if (typeof source.code === "number" && Number.isFinite(source.code)) pushCode(`${name ?? "Error"} code ${source.code}`);
    else if (typeof source.message === "string") pushCode(exactCode(source.message));
    if (typeof source.kind === "string" && source.kind) { agentKind = true; push(`kind: ${source.kind}`); }
    httpStatus ??= statusOf(source);
    push(typeof source.message === "string" && name ? `${name}: ${source.message}` : source.message);
    push(source.userMessage);
    push(source.diagnostic);
    if (typeof source.stderr_tail === "string") push(`stderr: ${source.stderr_tail}`);
    current = source.cause;
  }
  const joined = texts.join(" ← ");
  const chars = Array.from(joined);
  const source = sourceOf(codes[0], agentKind, httpStatus);
  const agentFailure = agentFailureStageOf(cause);
  return collected({
    ...(codes[0] ? { code: codes[0] } : {}),
    upstreamCodes: codes.slice(1),
    ...(source ? { source } : {}),
    ...(httpStatus !== undefined ? { httpStatus } : {}),
    ...(omitted.size ? { omittedCodes: omitted.size } : {}),
    ...(agentFailure ? { agentFailure } : {}),
    ...(chars.length
      ? { raw: chars.length > MAX_RAW_KEPT ? chars.slice(0, MAX_RAW_KEPT).join("") : joined, rawLength: chars.length }
      : {}),
  });
}

/**
 * 把已采集的字段挂到新的外层码下（例如插件把总结失败包成 `com.reai.voice/<码>` 抛出）：原外层码退为
 * 上游码，原文、字符数、HTTP 状态码、来源原样保留，不重新当异常文本采集。外层码没登记就不改。
 */
export function withOuterCode(fields: VoiceErrorFields, outer: string): VoiceErrorFields {
  // 只接着用本模块采集出的字段；外部对象按不可信处理：只留登记过的外层码。
  if (!isCollectedFields(fields)) return collectErrorFields(undefined, { code: outer });
  const code = structuredCode(outer);
  if (!code || code === fields.code) return fields;
  const upstream = [fields.code, ...fields.upstreamCodes].filter((item): item is string => !!item && item !== code);
  return collected({ ...fields, code, upstreamCodes: [...new Set(upstream)] });
}

const SOURCES: ReadonlySet<string> = new Set(["host", "cloud", "agent", "local"]);
const count = (value: unknown, max: number): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= max ? value : undefined;

/**
 * 已采集字段的日志投影（显式白名单）：码、上游码、来源、HTTP、字符数、未登记码个数；从不带原文。
 * 每个值照样过一遍接收规则（码查登记表、来源查枚举、数值查范围），调用方传错对象也不会外流。
 */
export function projectDiagnosticLogFields(fields: VoiceErrorFields): Omit<VoiceErrorFields, "raw"> {
  // 不是本模块采集出的对象：只取经登记表校验的错误码，其余全丢。
  if (!isCollectedFields(fields)) {
    const code = structuredCode((fields as { code?: unknown } | null | undefined)?.code);
    return { ...(code ? { code } : {}), upstreamCodes: [] };
  }
  const code = structuredCode(fields.code);
  const upstreamCodes = (Array.isArray(fields.upstreamCodes) ? fields.upstreamCodes : [])
    .map(structuredCode).filter((item): item is string => !!item);
  const source = typeof fields.source === "string" && SOURCES.has(fields.source) ? fields.source : undefined;
  const httpStatus = typeof fields.httpStatus === "number" && Number.isInteger(fields.httpStatus)
    && fields.httpStatus >= 100 && fields.httpStatus <= 599 ? fields.httpStatus : undefined;
  const rawLength = count(fields.rawLength, 10_000_000);
  const omittedCodes = count(fields.omittedCodes, 100);
  const agentFailure = agentFailureLogFields(fields.agentFailure);
  return {
    ...(code ? { code } : {}), upstreamCodes, ...(source ? { source } : {}),
    ...(httpStatus !== undefined ? { httpStatus } : {}), ...(rawLength ? { rawLength } : {}), ...(omittedCodes ? { omittedCodes } : {}),
    ...(agentFailure ? { agentFailure } : {}),
  };
}

/** Agent 阶段的日志投影：只认阶段模块解析出的对象，每个值再按登记表 / 范围过一遍。 */
function agentFailureLogFields(value: unknown): AgentFailureStage | undefined {
  return isAgentFailureStage(value) ? agentFailureFields(value) : undefined;
}

/**
 * 异常的日志投影（Host 会把插件 console 转进日志）：始终先采集，不按对象形状认「已采集字段」——
 * 外部异常可以自带同名字段冒充。手上确实是已采集字段时用 `projectDiagnosticLogFields`。
 */
export function diagnosticLogFields(cause: unknown): Omit<VoiceErrorFields, "raw"> {
  return projectDiagnosticLogFields(isCollectedFields(cause) ? cause : collectErrorFields(cause));
}
