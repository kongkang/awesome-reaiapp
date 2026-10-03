import { expect, test } from "bun:test";
import { withVoiceStartDeadline } from "../src/voice-start-deadline";

test("hung preparation is bounded and late continuation sees abort", async () => {
  let signal!: AbortSignal;
  let finish!: () => void;
  const pending = withVoiceStartDeadline(new AbortController().signal, async bounded => {
    signal = bounded;
    await new Promise<void>(resolve => { finish = resolve; });
    return bounded.aborted ? "cancelled" : "started";
  }, 10);
  await expect(pending).rejects.toThrow("VOICE_START_TIMEOUT");
  expect(signal.aborted).toBeTrue();
  finish();
});

test("parent cancellation before admission never calls start", async () => {
  const parent = new AbortController(); parent.abort();
  let calls = 0;
  await expect(withVoiceStartDeadline(parent.signal, async () => ++calls, 10)).rejects.toThrow("VOICE_START_CANCELLED");
  expect(calls).toBe(0);
});
