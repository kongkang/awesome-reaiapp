import { afterEach, expect, test } from "bun:test";
import { voiceRequestFailureMessage, voiceRequestFailureReason, voiceAgentUnavailableMessage } from "../src/voice-user-errors";
import { describePolishFailure, polishTranscript } from "../src/voice-polish";
import { describeDigestFailure } from "../src/voice-digest";
import { setVoiceLocale } from "../src/voice-i18n";
import { savedInputMayFallback } from "../src/saved-input-retry";

afterEach(() => setVoiceLocale("zh"));
const cases = [
  ["AI_NETWORK_ERROR", "network", "网络", "network"],
  ["AI_SUBSCRIPTION_REQUIRED", "subscription", "订阅", "subscription"],
  ["AI_SUBSCRIPTION_UNAVAILABLE", "subscriptionUnavailable", "订阅", "subscription"],
  ["AI_UNAVAILABLE", "service", "服务", "service"],
] as const;

for (const locale of ["zh", "en"] as const) {
  for (const [code, reason, zh, en] of cases) {
    test(`${locale} ${code} reaches generation, gate, polish and digest without upstream text`, async () => {
      setVoiceLocale(locale);
      const cause = { code, message: "PRIVATE_SENTINEL" };
      expect(voiceRequestFailureReason({ cause })).toBe(reason);
      const needle = locale === "zh" ? zh : en;
      const output = [
        ...(["reply", "translation", "summary"] as const).map(purpose => voiceRequestFailureMessage(purpose, { cause })),
        voiceAgentUnavailableMessage(cause), describePolishFailure(cause).message, describeDigestFailure(cause).message,
      ];
      for (const message of output) {
        expect(message.toLowerCase()).toContain(needle);
        expect(message).not.toContain("PRIVATE_SENTINEL");
        expect(message).not.toContain(code);
      }
      const result = await polishTranscript({ aiApi: { generateText: async () => { throw cause; }, cancel: async () => ({ cancelled: true, upstreamStopped: false }) }, newId: () => "fixture" }, { level: "light", transcript: "Original transcript must stay intact" });
      expect(result.text).toBe("Original transcript must stay intact");
      expect(result.failure?.code).toBe(code);
      expect(result.failure?.message.toLowerCase()).toContain(needle);
    });
  }
}

test("G6 preserves only the existing transient one-way local fallback", () => {
  for (const [errorCode, expected] of [["AI_NETWORK_ERROR", true], ["AI_SUBSCRIPTION_UNAVAILABLE", true], ["AI_UNAVAILABLE", true], ["AI_SUBSCRIPTION_REQUIRED", false], ["AI_PAYMENT_REQUIRED", false], ["AI_SCOPE_UNAVAILABLE", false]] as const) {
    expect(savedInputMayFallback({ recordingId: "fixture", attemptId: "one", revision: 1, state: "failed", selection: { engine: "cloud", modelId: "fixture", modelName: "Fixture", language: "auto", punctEnabled: true }, errorCode, startedAtMs: 0 })).toBe(expected);
  }
});
