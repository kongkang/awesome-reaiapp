import { t } from "./voice-i18n";
import type { VoiceChatCard } from "./data";

export interface AgentErrorPresentation {
  code: string;
  message: string;
  card?: VoiceChatCard;
}
const CAPABILITY_CARD: VoiceChatCard = {
  kind: "capability-required",
  capability: "browser-web-access",
  get title() { return t("agentErrors.message1"); },
  get detail() { return t("agentErrors.message2"); },
  actionId: "install-browser-web-access",
  get actionLabel() { return t("agentErrors.message3"); },
};

/**
 * Host 工具错误到 Voice 用户界面的唯一投影。这里绝不回显 HTTP body、JSON、供应商名
 * 或 stderr；fallback 只用于不属于联网工具的既有 Agent 失败。
 */
export function presentAgentToolError(
  errorCode: string | undefined,
  fallback: AgentErrorPresentation,
): AgentErrorPresentation {
  switch (errorCode) {
    case "browser_plugin_required":
    case "browser_plugin_declined":
      return {
        code: errorCode,
        get message() { return t("agentErrors.message4"); },
        card: CAPABILITY_CARD,
      };
    case "web_access_not_logged_in":
    case "web_access_scope_unavailable":
      return {
        code: errorCode,
        get message() { return t("agentErrors.message5"); },
        card: {
          kind: "auth-required",
          get title() { return t("agentErrors.message6"); },
          get detail() { return t("agentErrors.message7"); },
        },
      };
    case "web_access_project_unavailable":
      return {
        code: errorCode,
        get message() { return t("agentErrors.message8"); },
      };
    case "web_access_subscription_required":
      return {
        code: errorCode,
        get message() { return t("agentErrors.message12"); },
        card: {
          kind: "auth-required",
          get title() { return t("agentErrors.message13"); },
          get detail() { return t("agentErrors.message14"); },
        },
      };
    case "web_access_insufficient_credits":
      return {
        code: errorCode,
        get message() { return t("agentErrors.message9"); },
      };
    case "web_access_rate_limited":
      return {
        code: errorCode,
        get message() { return t("agentErrors.message10"); },
      };
    case "provider_credentials_unavailable":
    case "web_access_unavailable":
      return {
        code: errorCode,
        get message() { return t("agentErrors.message11"); },
      };
    default:
      return fallback;
  }
}
