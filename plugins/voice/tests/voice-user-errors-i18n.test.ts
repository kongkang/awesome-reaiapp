import { afterEach, describe, expect, test } from "bun:test";
import { voiceRequestFailureMessage } from "../src/voice-user-errors";
import { setVoiceLocale } from "../src/voice-i18n";
import { presentAgentToolError } from "../src/agent-error-presentation";
import { voiceAgentUnavailableMessage } from "../src/voice-user-errors";

// B 档：红条件——把 errors 模板从 i18n 表断开（恢复硬编码中文）时，
// 下方 en 断言拿不到英文文本即红。
describe("生成失败文案双语", () => {
  test("login/timeout/取消三档在 en 表下返回英文", () => {
    setVoiceLocale("en");
    expect(voiceRequestFailureMessage("reply", { code: "AI_NOT_LOGGED_IN" }))
      .toMatch(/(?:Please sign|Sign) in first/);
    expect(voiceRequestFailureMessage("summary", { code: "AI_TIMEOUT" }))
      .toContain("did not finish within the App time limit (timed out)");
    expect(voiceRequestFailureMessage("translation", { code: "AI_CANCELLED" }))
      .toContain("was cancelled");
  });

  test("默认（不传表）保持既有中文文案，存量断言不受影响", () => {
    expect(voiceRequestFailureMessage("reply", { code: "AI_NOT_LOGGED_IN" }))
      .toBe("请先登录。你的内容已保存，登录后可以重新发送。");
  });
});

// B 档：红条件=agent 段从 i18n 表断开（恢复硬编码中文）时 en 断言拿不到英文即红。
describe("Agent 门禁文案双语", () => {
  test("en 表下登录/权限/联网重登返回英文", () => {
    setVoiceLocale("en");
    expect(voiceAgentUnavailableMessage({ code: "AI_NOT_LOGGED_IN" }))
      .toMatch(/(?:Please sign|Sign) in first/);
    expect(voiceAgentUnavailableMessage({ code: "AI_SCOPE_UNAVAILABLE" }))
      .toContain("not enabled for your account");
    expect(presentAgentToolError("web_access_not_logged_in", { kind: "none" } as never).message)
      .toContain("Sign in again");
  });
});

afterEach(() => setVoiceLocale("zh"));
