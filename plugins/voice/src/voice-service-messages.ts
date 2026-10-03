import type { UiLocale } from "@reai/app-sdk/v1";
import zh from "../assets/locales/zh.json";
import en from "../assets/locales/en.json";

/** 服务稳定错误码 → 双语文案；表结构与插值在 voice-i18n 中 zh/en 强制对等。 */
const CODE_KEYS: Record<string, keyof VoiceStringsPlaceholder> = {
  "com.reai.voice/VOICE_HOST_UPGRADE_REQUIRED": "hostUpgradeRequired",
  "com.reai.voice/VOICE_MIC_PERMISSION_REQUIRED": "microphoneRequired",
  VOICE_ACCOUNT_UNAVAILABLE: "accountUnavailable",
  SERVICE_BUSY: "busy",
  SERVICE_CANCELLED: "cancelled",
  SERVICE_TIMEOUT: "timeout",
  VOICE_REQUEST_INVALID: "invalid",
  VOICE_REQUEST_REPLAYED: "replayed",
  VOICE_REQUEST_EXPIRED: "expired",
  VOICE_REQUEST_IDENTITY_REQUIRED: "identity",
  VOICE_REQUEST_SESSION_CHANGED: "sessionChanged",
  VOICE_REQUEST_CLOCK_CHANGED: "clockChanged",
  VOICE_REQUEST_STORAGE_UNAVAILABLE: "storageUnavailable",
  VOICE_CAPTURE_NOT_STARTED: "captureNotStarted",
  VOICE_CAPTURE_SESSION_CHANGED: "captureSessionChanged",
  VOICE_CAPTURE_INTERRUPTED: "captureInterrupted",
  VOICE_CAPTURE_CLEANUP_REQUIRED: "captureCleanupRequired",
  VOICE_REQUEST_INVALID_RESULT: "invalidResult",
  SERVICE_PROVIDER_FAILED: "providerFailed",
} as const;
type VoiceStringsPlaceholder = typeof zh.service;

export function voiceServiceMessage(locale: UiLocale, code: string): string {
  const resources = locale === "zh" ? zh : en;
  // Host result errors and plugin processing use the same condition with distinct stable IDs.
  if (code === "VOICE_EMPTY_TRANSCRIPT" || code === "com.reai.voice/VOICE_EMPTY_TRANSCRIPT") {
    return resources.app.nothingWasHeardPleaseSayItAgain;
  }
  if (code === "CLOUD_MODEL_SELECTION_REQUIRED") return resources.view.cloudModelsUnavailable;
  const service = resources.service;
  const key = CODE_KEYS[code];
  return key ? service[key] : service.providerFailed;
}
