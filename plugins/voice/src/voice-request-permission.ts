import { AppError, type VoiceInputClient, type VoiceInputSettings } from "@reai/app-sdk/v1";

/** Host owns route selection, including legacy Board UAC when the route is unavailable. */
export async function prepareVoiceRequest(
  voice: Pick<VoiceInputClient, "configure" | "checkPermissions" | "requestPermission">,
  settings: VoiceInputSettings,
  signal: AbortSignal,
  reportWaitingPermission: () => void,
  messages: { cancelled: string; upgrade: string; microphone: string },
): Promise<void> {
  const cancelled = () => new AppError({ code: "SERVICE_CANCELLED", userMessage: messages.cancelled });
  const checkCancelled = () => { if (signal.aborted) throw cancelled(); };
  checkCancelled();
  await voice.configure(settings);
  checkCancelled();
  const permissions = await voice.checkPermissions();
  checkCancelled();
  if (typeof permissions.microphoneRequired !== "boolean") {
    throw new AppError({ code: "com.reai.voice/VOICE_HOST_UPGRADE_REQUIRED", userMessage: messages.upgrade, retryable: true });
  }
  if (!permissions.microphoneRequired || permissions.microphone === "granted") return;
  reportWaitingPermission();
  checkCancelled();
  let abort!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    abort = () => reject(cancelled());
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    const answered = await Promise.race([voice.requestPermission("microphone"), aborted]);
    checkCancelled();
    if (answered !== "granted") {
      throw new AppError({ code: "com.reai.voice/VOICE_MIC_PERMISSION_REQUIRED", userMessage: messages.microphone, retryable: true });
    }
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
