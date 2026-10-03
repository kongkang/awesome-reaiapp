/** 录音开始的时限：超时文案写的秒数取它（§6.0：超时写明等了多久）。 */
export const VOICE_START_TIMEOUT_MS = 3000;

/** Bounds preparation and cancels any late start; recognition is outside this window. */
export async function withVoiceStartDeadline<T>(
  parent: AbortSignal,
  start: (signal: AbortSignal) => Promise<T>,
  timeoutMs = VOICE_START_TIMEOUT_MS,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectCancelled: (error: Error) => void = () => undefined;
  const cancel = () => {
    controller.abort();
    rejectCancelled(new Error("VOICE_START_CANCELLED"));
  };
  parent.addEventListener("abort", cancel, { once: true });
  try {
    return await Promise.race([
      new Promise<never>((_, reject) => {
        rejectCancelled = reject;
        if (parent.aborted) cancel();
        else timer = setTimeout(() => {
          controller.abort();
          reject(new Error("VOICE_START_TIMEOUT"));
        }, timeoutMs);
      }),
      Promise.resolve().then(() => {
        if (controller.signal.aborted) throw new Error("VOICE_START_CANCELLED");
        return start(controller.signal);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    parent.removeEventListener("abort", cancel);
  }
}

/** Release the caller's admission lock on abort even if a readiness RPC never returns. */
export async function awaitVoicePreparation<T>(signal: AbortSignal | undefined, read: () => Promise<T>): Promise<T> {
  if (!signal) return read();
  if (signal.aborted) throw Object.assign(new Error("VOICE_CANCELLED"), { code: "VOICE_CANCELLED" });
  let cancel: () => void = () => undefined;
  try {
    return await Promise.race([
      new Promise<never>((_, reject) => {
        cancel = () => reject(Object.assign(new Error("VOICE_CANCELLED"), { code: "VOICE_CANCELLED" }));
        signal.addEventListener("abort", cancel, { once: true });
      }),
      read(),
    ]);
  } finally { signal.removeEventListener("abort", cancel); }
}
