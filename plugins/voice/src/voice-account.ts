import { AppError, type VoiceContextClient } from "@reai/app-sdk/v1";

/** A metadata-only read: no text or screenshot is requested. Missing generation
 * is unavailable, never proof that an old account is still current. */
export async function readVoiceAccountEpoch(context: Pick<VoiceContextClient, "capture">): Promise<string> {
  const { sessionEpoch } = await context.capture({});
  if (typeof sessionEpoch !== "string" || !sessionEpoch || sessionEpoch.length > 256) {
    throw new AppError({ code: "VOICE_ACCOUNT_UNAVAILABLE", userMessage: "VOICE_ACCOUNT_UNAVAILABLE", retryable: true });
  }
  return sessionEpoch;
}
export async function isVoiceAccountCurrent(context: Pick<VoiceContextClient, "capture">, expected: string | undefined): Promise<boolean> {
  if (!expected) return false;
  return await readVoiceAccountEpoch(context) === expected;
}

/** These terminal errors can never be presented as a successful raw fallback. */
export function isVoiceRequestInvalidated(cause: unknown): boolean {
  const code = cause && typeof cause === "object" && "code" in cause ? cause.code : undefined;
  return typeof code === "string" && (code.endsWith("/VOICE_CANCELLED") || [
    "VOICE_CANCELLED", "SERVICE_CANCELLED", "CLOUD_CANCELLED", "AI_CANCELLED",
    "VOICE_REQUEST_SESSION_CHANGED", "CLOUD_SESSION_CHANGED", "AI_SESSION_CHANGED", "OAUTH_SESSION_CHANGED",
  ].includes(code));
}
