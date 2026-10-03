import { expect, test } from "bun:test";
import { safeHostResultDiagnostics } from "../src/voice-diagnostics";
import { setVoiceLocale } from "../src/voice-i18n";

test("Host结果诊断不冻结App版本读取失败，保留插件版本与结构错误时间", () => {
  setVoiceLocale("zh");
  const text = safeHostResultDiagnostics({ step: "Agent", code: "AGENT_ENGINE" }, 0);
  expect(text).toContain("AGENT_ENGINE");
  expect(text).toContain("Agent");
  expect(text).toContain("1970-01-01T00:00:00.000Z");
  expect(text).not.toContain("App 版本");
  expect(text).not.toContain("SYSTEM_TASK_VISIBLE_SURFACE_REQUIRED");
  expect(text).toContain("插件版本: com.reai.voice");
});
