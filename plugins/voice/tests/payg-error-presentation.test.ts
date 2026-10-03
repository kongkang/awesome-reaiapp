import { afterEach, expect, test } from "bun:test";
import { presentAgentToolError } from "../src/agent-error-presentation";
import { setVoiceLocale } from "../src/voice-i18n";
import { voiceRequestFailureMessage } from "../src/voice-user-errors";
afterEach(() => setVoiceLocale("zh"));
for (const locale of ["zh", "en"] as const) {
  test(`${locale}: legacy subscription denial preserves failure without asking user to subscribe`, () => {
    setVoiceLocale(locale);
    const error = presentAgentToolError("web_access_subscription_required", {code:"fallback",message:"fallback"});
    expect(error.code).toBe("web_access_subscription_required");
    if (error.card?.kind !== "auth-required") throw new Error("expected legacy rejection card");
    expect(error.card.detail).toContain(locale === "zh" ? "无需为此开通订阅" : "do not need to subscribe");
    expect(error.card.title).toContain(locale === "zh" ? "按量" : "Pay-as-you-go");
    const ai = voiceRequestFailureMessage("reply", {cause:{code:"AI_SUBSCRIPTION_REQUIRED"}});
    expect(ai).toContain(locale === "zh" ? "无需为此开通订阅" : "do not need to subscribe");
    const insufficient = presentAgentToolError("web_access_insufficient_credits", {code:"fallback",message:"fallback"});
    expect(insufficient.code).toBe("web_access_insufficient_credits");
    expect(insufficient.card).toBeUndefined();
    expect(insufficient.message).toContain(locale === "zh" ? "积分" : "credits");
  });
}
