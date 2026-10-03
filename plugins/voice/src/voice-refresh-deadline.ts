/** Bound a read-only refresh. The caller publishes only the winning snapshot;
 * a late Host response is observed but can never resume that publication. */
/** 状态读取的时限：超时文案与诊断写的秒数都取它（§6.0：超时写明等了多久）。 */
export const VOICE_REFRESH_TIMEOUT_MS = 8_000;

export async function withVoiceRefreshDeadline<T>(read: () => Promise<T>, timeoutMs = VOICE_REFRESH_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(read),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("VOICE_STATUS_REFRESH_TIMEOUT")), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
