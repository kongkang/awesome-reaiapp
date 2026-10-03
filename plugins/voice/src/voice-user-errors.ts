import { t } from "./voice-i18n";
import { agentFailureStageOf } from "./agent-failure-stage";
import { agentStageReason, agentUpstreamReason } from "./agent-failure-copy";
import { agentCodeReason, hostAgentCodeOf } from "./agent-failure-codes";
/** Voice 会直接展示给人的生成失败文案。上游原文只用于分类，绝不拼进返回值。 */

export type VoiceRequestPurpose = "reply" | "translation" | "summary";

interface FailureSource {
  code?: unknown;
  kind?: unknown;
  stderr_tail?: unknown;
  userMessage?: unknown;
  message?: unknown;
  cause?: unknown;
}

const field = (value: unknown): FailureSource =>
  typeof value === "string"
    ? { message: value }
    : value && typeof value === "object"
      ? value as FailureSource
      : {};

function hasStableCode(source: unknown, code: string, depth = 0): boolean {
  if (depth > 3) return false;
  const current = field(source);
  const escaped = code.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const token = new RegExp(`(^|[^A-Z0-9_])${escaped}($|[^A-Z0-9_])`);
  if (
    [current.code, current.stderr_tail, current.userMessage, current.message]
      .some((value) => typeof value === "string" && token.test(value))
  ) {
    return true;
  }
  return current.cause !== undefined && hasStableCode(current.cause, code, depth + 1);
}

function hasFailureKind(source: unknown, kind: string, depth = 0): boolean {
  if (depth > 3) return false;
  const current = field(source);
  if (current.kind === kind) return true;
  return current.cause !== undefined && hasFailureKind(current.cause, kind, depth + 1);
}

function genericMessage(purpose: VoiceRequestPurpose): string {
  switch (purpose) {
    case "reply":
      return t("errors.message1");
    case "translation":
      return t("errors.message2");
    case "summary":
      return t("errors.message3");
  }
}

function actionMessage(
  purpose: VoiceRequestPurpose,
  reason: Exclude<VoiceFailureReason, "cancelled" | "unknown">,
): string {
  if (isCloudReason(reason)) {
    return `${t(`errors.cloud.${reason}`)} ${t(`errors.cloud.saved.${purpose}`)}`;
  }
  return t(`errors.actions.${purpose}.${reason}`);
}

type CloudFailureReason = "network" | "subscription" | "subscriptionUnavailable" | "service";
function isCloudReason(reason: VoiceFailureReason): reason is CloudFailureReason {
  return reason === "network" || reason === "subscription" || reason === "subscriptionUnavailable" || reason === "service";
}

/** Compact fixed copy for gates, transcription errors and task labels; no saved-data claim. */
export function voiceCloudFailureMessage(cause: unknown): string | undefined {
  const reason = voiceRequestFailureReason(cause);
  if (reason === "payment") return t("errors.cloud.payment");
  return isCloudReason(reason) ? t(`errors.cloud.${reason}`) : undefined;
}

export type VoiceFailureReason =
  | CloudFailureReason
  | "cancelled"
  | "timeout"
  | "login"
  | "permission"
  | "scope"
  | "payment"
  | "rate"
  | "stale"
  | "disabled"
  | "runtime"
  | "unknown";

/**
 * Host 在 Agent 后端组件（DSH / PI runtime）未安装时，用 `download_required:`
 * 前缀标记会话创建失败；插件门禁自己预检出的同类失败用
 * `kind: "agent-runtime-missing"` 标记。两者都是「去安装组件能解决」的失败，
 * 不是「稍后重试」能解决的，必须和暂时性故障分开。
 */
function hasDownloadRequired(source: unknown, depth = 0): boolean {
  if (depth > 3) return false;
  const current = field(source);
  if (current.kind === "agent-runtime-missing") return true;
  if (
    [current.code, current.stderr_tail, current.userMessage, current.message].some(
      (value) => typeof value === "string" && value.includes("download_required:"),
    )
  ) {
    return true;
  }
  return current.cause !== undefined && hasDownloadRequired(current.cause, depth + 1);
}

/** 同时检查 AppError 和它保存的原始回合 failure，避免二次归一丢掉精准行动。 */
export function voiceRequestFailureReason(cause: unknown): VoiceFailureReason {
  if (
    hasFailureKind(cause, "killed")
    || hasStableCode(cause, "VOICE_CANCELLED")
    || hasStableCode(cause, "AI_CANCELLED")
    || hasStableCode(cause, "AGENT_KILLED")
  ) return "cancelled";
  if (
    hasFailureKind(cause, "timeout")
    || hasStableCode(cause, "AI_TIMEOUT")
    || hasStableCode(cause, "AGENT_TIMEOUT")
  ) return "timeout";
  if (hasStableCode(cause, "AI_NOT_LOGGED_IN")) return "login";
  if (hasStableCode(cause, "AI_SUBSCRIPTION_REQUIRED")) return "subscription";
  if (hasStableCode(cause, "AI_SUBSCRIPTION_UNAVAILABLE")) return "subscriptionUnavailable";
  if (hasStableCode(cause, "AI_NETWORK_ERROR")) return "network";
  if (hasStableCode(cause, "AI_UNAVAILABLE")) return "service";
  if (
    hasStableCode(cause, "AGENT_SESSION_NOT_GRANTED")
    || hasStableCode(cause, "AGENT_SESSION_PERMISSION_REQUIRED")
    || hasStableCode(cause, "AGENT_SESSION_PERMISSION_DENIED")
  ) return "permission";
  if (hasStableCode(cause, "AI_SCOPE_UNAVAILABLE")) return "scope";
  if (hasStableCode(cause, "AI_PAYMENT_REQUIRED")) return "payment";
  if (hasStableCode(cause, "AI_RATE_LIMITED")) return "rate";
  if (
    hasStableCode(cause, "AGENT_SESSION_NOT_FOUND")
    || hasStableCode(cause, "AGENT_SESSION_SESSION_STALE")
  ) return "stale";
  if (hasStableCode(cause, "AGENT_SESSION_DISABLED")) return "disabled";
  if (hasDownloadRequired(cause)) return "runtime";
  return "unknown";
}

/**
 * 只识别 Host/SDK 的稳定错误码和回合种类；其他内容全部落到固定文案。
 * 错误码偶尔只出现在本地 Agent 的 stderr 尾部，因此允许从这些字段中分类，
 * 但任何字段原文都不得出现在返回值里。
 */
export function voiceRequestFailureMessage(
  purpose: VoiceRequestPurpose,
  cause: unknown,
): string {
  // 插件自己的译文校验拦下的（结果明显不是译文）：说清楚为什么没写入。
  if (purpose === "translation") {
    if (hasStableCode(cause, "TRANSLATION_CHAT_REPLY")) return t("errors.translationOutput.chatReply");
    if (hasStableCode(cause, "TRANSLATION_WRONG_LANGUAGE")) return t("errors.translationOutput.wrongLanguage");
  }
  const reason = voiceRequestFailureReason(cause);
  if (reason === "cancelled") {
    if (purpose === "summary") return t("errors.message8");
    if (purpose === "translation") return t("errors.message9");
    return t("errors.message10");
  }
  // 主句优先级：Host 具体码（预算、运行组件…）> 阶段码 / 上游码 > 既有分类与兜底（V1.0 真机回归 00:40:06Z）。
  const hostReason = agentCodeReason(hostAgentCodeOf(cause));
  if (hostReason) return t(`errors.agentCode.saved.${purpose}`, { reason: hostReason });
  const staged = agentStageMessage(purpose, cause, reason);
  if (staged) return staged;
  return reason === "unknown" ? genericMessage(purpose) : actionMessage(purpose, reason);
}

/**
 * Agent 引擎失败按 Host 阶段说人话（Host #956 的 `stderr_tail` / `message` 前缀，见 agent-failure-stage）：
 * 方括号里的上游码有专门说法（限流等）就用它；否则既有分类（登录 / 额度 / 权限…）优先；都没有再按阶段说。
 * 主句只由插件文案拼成，唯一插值是范围内的整数退出码；没有阶段（旧 Host、Pi / Codex）返回 undefined。
 */
function agentStageMessage(purpose: VoiceRequestPurpose, cause: unknown, reason: VoiceFailureReason): string | undefined {
  const stage = agentFailureStageOf(cause);
  const upstream = agentUpstreamReason(stage);
  if (upstream) return t(`errors.agentStage.${upstream.later ? "retryLater" : "retry"}.${purpose}`, { reason: upstream.reason });
  // 方括号里是 Host 自己的 Agent 失败码（例如引擎 stderr 里出现过预算码）：按码给那一类的人话。
  const upstreamAgent = agentCodeReason(stage?.upstreamCode);
  if (upstreamAgent) return t(`errors.agentCode.saved.${purpose}`, { reason: upstreamAgent });
  if (reason !== "unknown") return undefined;
  const staged = agentStageReason(stage);
  return staged ? t(`errors.agentStage.retry.${purpose}`, { reason: staged }) : undefined;
}

/** 录音或发送尚未开始时的门禁文案；此时没有内容可声称“已保存”。 */
export function voiceAgentUnavailableMessage(cause: unknown): string {
  const cloud = voiceCloudFailureMessage(cause);
  if (cloud) return cloud;
  if (hasStableCode(cause, "AI_NOT_LOGGED_IN")) return t("errors.message11");
  if (
    hasStableCode(cause, "AGENT_SESSION_NOT_GRANTED")
    || hasStableCode(cause, "AGENT_SESSION_PERMISSION_REQUIRED")
    || hasStableCode(cause, "AGENT_SESSION_PERMISSION_DENIED")
  ) {
    return t("errors.message12");
  }
  if (hasStableCode(cause, "AI_SCOPE_UNAVAILABLE")) return t("errors.message13");
  if (hasStableCode(cause, "AI_PAYMENT_REQUIRED")) return t("errors.message14");
  if (hasStableCode(cause, "AI_RATE_LIMITED")) return t("errors.message15");
  // 门禁入参常是 backends 的 detail 字符串（不是错误对象），所以先查
  // download_required 前缀再落兜底；不透传组件 id 等原文。
  if (hasDownloadRequired(cause)) {
    return t("errors.message16");
  }
  return t("errors.message17");
}

/** 历史写入本身失败时必须撤回“已保存”承诺，也不显示存储层原文。 */
export function voiceHistorySaveFailureMessage(
  purpose: "reply" | "translation" | "transcription",
): string {
  if (purpose === "reply") return t("errors.message18");
  if (purpose === "translation") return t("errors.message19");
  return t("errors.message20");
}
