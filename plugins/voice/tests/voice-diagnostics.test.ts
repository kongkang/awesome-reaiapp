/**
 * 设计规范 §6.0（#waiting-failure-minimum）在 Voice 插件侧的诊断采集与复制全文（白名单结构）。
 * 口径照 Host 内核门禁 `kernel-diagnostics.ts`（PR #941）：首行标题、逐行「标签: 值」、末行 ISO 时间。
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { AppError } from "@reai/app-sdk/v1";
import { setVoiceLocale } from "../src/voice-i18n";
import { collectErrorFields, structuredCode } from "../src/voice-error-fields";
import { HOST_VERSION_TIMEOUT_MS } from "../src/voice-host-version";
import {
  VOICE_HOST_API_VERSION,
  VOICE_PLUGIN_VERSION,
  buildVoiceDiagnosticsText,
  safeOverlayDiagnostics,
  structuredToken,
  type VoiceDiagnosticEntry,
} from "../src/voice-diagnostics";

const root = resolve(import.meta.dir, "..");
const json = (path: string) => JSON.parse(readFileSync(resolve(root, path), "utf8"));

beforeEach(() => setVoiceLocale("zh"));

describe("结构化字段采集：真实错误码、来源、HTTP 状态码；原文原样只留内存", () => {
  test("嵌套 cause：外层码 + 上游码；原文未经改动（只给界面展开）", () => {
    const cause = new AppError({ code: "AI_TIMEOUT", userMessage: "请求超时", cause: "upstream returned HTTP 504" });
    const fields = collectErrorFields(cause);
    expect(fields.code).toBe("AI_TIMEOUT");
    expect(fields.source).toBe("cloud");
    expect(fields.raw).toContain("upstream returned HTTP 504");
    expect(fields.rawLength).toBe(Array.from(fields.raw!).length);
  });

  test("读 WireError.diagnostic、Agent 失败合同的 kind / stderr_tail、上游码与数字 HTTP 状态码", () => {
    const failure = { code: "AGENT_TIMEOUT", kind: "timeout", stderr_tail: "dsh: model call exceeded 120s" };
    const wire = { code: "AI_UNAVAILABLE", status: 502, userMessage: "云端服务暂时不可用", diagnostic: "gateway 502", cause: failure };
    const fields = collectErrorFields(wire);
    expect(fields.code).toBe("AI_UNAVAILABLE");
    expect(fields.upstreamCodes).toEqual(["AGENT_TIMEOUT"]);
    expect(fields.httpStatus).toBe(502);
    expect(fields.raw).toContain("stderr: dsh: model call exceeded 120s");
    // 调用方自判的码作外层码，链上的码退为上游码。
    expect(collectErrorFields(failure, { code: "DSH_TIMEOUT" })).toMatchObject({ code: "DSH_TIMEOUT", upstreamCodes: ["AGENT_TIMEOUT"], source: "agent" });
  });

  test("数字码写成「名称 code N」；没有 code 字段时 message 整段就是稳定码才取作码，自由文本里不抠码", () => {
    expect(collectErrorFields({ name: "MediaError", code: 3, message: "PIPELINE_ERROR_DECODE" }).code).toBe("MediaError code 3");
    expect(collectErrorFields(new Error("VOICE_STATUS_REFRESH_TIMEOUT")).code).toBe("VOICE_STATUS_REFRESH_TIMEOUT");
    // 只认插件自己只把码写进 message 的那几处；其余自由文本（哪怕整段像码、或「CODE: 说明」）都不抠码。
    expect(collectErrorFields(new Error("PRIVATE_ACCOUNT_DATA")).code).toBeUndefined();
    expect(collectErrorFields("com.reai.voice/VOICE_CANCELLED").code).toBeUndefined();
    expect(collectErrorFields(new Error("PRIVATE_ACCOUNT_DATA: 明天开会")).code).toBeUndefined();
    // 哪怕开头恰好是登记过的码，自由文本也不是码的来源（不猜）。
    expect(collectErrorFields(new Error("AI_TIMEOUT: 明天开会")).code).toBeUndefined();
    expect(collectErrorFields("upstream said PRIVATE_ACCOUNT_DATA").code).toBeUndefined();
    expect(collectErrorFields(new Error("Network request failed")).code).toBeUndefined();
    expect(collectErrorFields({ code: "com.reai.voice/VOICE_BUSY" }).source).toBe("local");
    expect(collectErrorFields({ code: "UNKNOWN_THING" }).source).toBeUndefined();
  });
});

describe("结构化文法：只接收或省略，不改写", () => {
  test("错误码：标识符形态才算码；句子、手机号、凭据、编码串、非 ASCII 一律不算", () => {
    for (const code of ["AI_TIMEOUT", "com.reai.voice/VOICE_BUSY", "no_input_target", "NotAllowedError", "MediaError code 3", "SYSTEM_TASK_VISIBLE_SURFACE_REQUIRED"]) {
      expect(structuredCode(code)).toBe(code);
    }
    for (const value of ["Authorization:abc123", "AbCdEfGh1234567890IjKlMnOp_MORE", "hello", "Bearer abc.def", "13800138000", "%E6%98%8E%E5%A4%A9", "\\u660e\\u5929", "请把合同发给王经理", "sk-ABCDEF123456", "a".repeat(81), "AbCdEfGh1234567890IjKlMnOp"]) {
      expect(structuredCode(value)).toBeUndefined();
    }
  });

  test("对象状态值：ASCII 无空白的 ID / 枚举 / 版本号或数字；否则写「已省略」", () => {
    expect(structuredToken("rec-1")).toBe("rec-1");
    expect(structuredToken(2048)).toBe("2048");
    expect(structuredToken(undefined)).toBe("无");
    expect(structuredToken("Whisper Large v3")).toBe("已省略（不是结构化值）");
    expect(structuredToken("明天开会")).toBe("已省略（不是结构化值）");
  });
});

describe("复制全文：白名单字段齐全、版本一致、不含原文", () => {
  const at = "2026-09-27T08:00:00.000Z";
  const now = Date.parse("2026-09-27T08:00:30.000Z");
  const RAW = "gateway timeout while translating 你好世界这句话";
  const failed: VoiceDiagnosticEntry = {
    state: "failed",
    step: "翻译",
    sinceMs: now - 12_000,
    endMs: now - 2_000,
    code: "AI_TIMEOUT",
    upstreamCodes: ["AGENT_TIMEOUT"],
    source: "cloud",
    httpStatus: 504,
    raw: RAW,
    rawLength: Array.from(RAW).length,
    at,
    details: [
      { label: "录音", tokens: () => ["rec-1"] },
      { label: "模型", value: "显示名 你好世界", tokens: () => ["whisper-small"] },
      { label: "来源", value: "系统输入" },
    ],
  };

  test("失败：步骤与冻结用时、码、上游码、来源、HTTP、按码查表的原因、原文只写字符数、两端版本、时间", () => {
    const text = buildVoiceDiagnosticsText(failed, { state: "ready", version: "1.0.0-rc.1" }, now);
    const lines = text.split("\n");
    expect(lines[0]).toBe("ReAI Board Voice 诊断信息");
    expect(text).toContain(`插件版本: com.reai.voice ${VOICE_PLUGIN_VERSION}`);
    expect(text).toContain("App 版本: 1.0.0-rc.1");
    expect(text).toContain(`Host API: ${VOICE_HOST_API_VERSION}`);
    expect(text).toContain("状态: 失败 (failed)");
    expect(text).toContain("当前步骤: 翻译 · 用时 10 秒");
    expect(text).toContain("错误码: AI_TIMEOUT");
    expect(text).toContain("上游错误码: AGENT_TIMEOUT");
    expect(text).toContain("错误来源: 云端 (cloud)");
    expect(text).toContain("HTTP 状态码: 504");
    expect(text).toContain("原因（按错误码）: 超时");
    expect(text).toContain(`原始原因: 原始信息可能含用户内容，已省略（${Array.from(RAW).length} 字符）`);
    expect(text).toContain(`发生时间: ${at}`);
    expect(text).toContain("  - 录音: rec-1");
    expect(text).toContain("  - 模型: whisper-small");
    expect(text).toContain("  - 来源: 仅界面可见（不复制）");
    // §6.0 ④：诊断要列日志位置；插件拿不到 App 日志目录，如实写日志并入 App、目录在 App 弹窗的复制诊断里。
    expect(lines.at(-2)).toBe("日志位置: Voice 没有单独的日志文件：运行日志并入 ReAI Board App 的日志（只记错误码等结构化字段，不记原文），日志目录写在 App 弹窗的「复制诊断」里");
    expect(lines.at(-1)).toBe(`生成时间: ${new Date(now).toISOString()}`);
    // §6.0 ⑧ 回归：诊断文本不含转写原文，也不含原文里的技术描述（原文整段不进复制）。
    expect(text).not.toContain("你好世界这句话");
    expect(text).not.toContain("gateway timeout");
  });

  test("等待：已用时间随 now 前进；首见口径如实标注；Host 版本各状态只写码或固定说明", () => {
    const waiting: VoiceDiagnosticEntry = { state: "waiting", step: "识别中", sinceMs: now - 65_000 };
    expect(buildVoiceDiagnosticsText(waiting, { state: "loading" }, now)).toContain("当前步骤: 识别中 · 已用 1 分 5 秒");
    expect(buildVoiceDiagnosticsText({ ...waiting, sinceObserved: true }, undefined, now))
      .toContain("已等待至少 1 分 5 秒（自打开页面起）");
    expect(buildVoiceDiagnosticsText(waiting, undefined, now)).toContain("App 版本: 未读取（本次运行还没打开过 Voice 页）");
    const rejected = buildVoiceDiagnosticsText(waiting, { state: "rejected", code: "SYSTEM_TASK_VISIBLE_SURFACE_REQUIRED" }, now);
    expect(rejected).toContain("App 版本: 读取失败（SYSTEM_TASK_VISIBLE_SURFACE_REQUIRED）");
    expect(buildVoiceDiagnosticsText(waiting, { state: "rejected", missing: true }, now)).toContain("App 返回的版本状态里没有 App 版本号");
    expect(buildVoiceDiagnosticsText(waiting, { state: "ready", version: "1.0 beta 你好" }, now)).toContain("App 返回的版本号格式不符，已省略");
    expect(buildVoiceDiagnosticsText(waiting, { state: "ready", version: "1.2.3-rc.1+build.42" }, now)).toContain("App 版本: 1.2.3-rc.1+build.42");
    // 秒数按本地等待上限的常量插值（改常量时文案跟着变，不写死）。
    expect(HOST_VERSION_TIMEOUT_MS).toBe(5_000);
    expect(buildVoiceDiagnosticsText(waiting, { state: "timeout" }, now)).toContain("读取超时（5 秒内未返回）");
    expect(buildVoiceDiagnosticsText(waiting, undefined, now)).toContain("原始原因: 无");
    expect(buildVoiceDiagnosticsText({ ...waiting, rawNote: "hostNotProvided" }, undefined, now)).toContain("原始原因: App 未提供原始原因");
    expect(buildVoiceDiagnosticsText({ ...waiting, noteKey: "diagnostics.digestFailed" }, undefined, now)).toContain("说明: 当日总结没有生成成功");
  });

  test("中断恢复只写「发现中断时间」；英文同样齐全，说明与原因随当前语言", () => {
    const detected = buildVoiceDiagnosticsText({ ...failed, atKind: "detected" }, undefined, now);
    expect(detected).toContain(`发现中断时间: ${at}`);
    expect(detected).not.toContain("发生时间:");
    setVoiceLocale("en");
    const english = buildVoiceDiagnosticsText({ ...failed, noteKey: "diagnostics.digestFailed" }, { state: "ready", version: "1.0.0-rc.1" }, now);
    expect(english.split("\n")[0]).toBe("ReAI Board Voice Diagnostics");
    expect(english).toContain(`Plugin version: com.reai.voice ${VOICE_PLUGIN_VERSION}`);
    expect(english).toContain("Current step: 翻译 · Took 10s");
    expect(english).toContain("Error code: AI_TIMEOUT");
    // 「说明」与「原因（按错误码）」是插件固定文案，渲染时按当前语言取，不冻结失败当时的语言。
    expect(english).toContain("Summary: The daily summary was not generated.");
    expect(english).toContain("Reason (from error code): Timed out");
    expect(english).toContain("Log location: Voice keeps no separate log file");
    expect(buildVoiceDiagnosticsText(failed, { state: "timeout" }, now)).toContain("Timed out (no reply within 5 seconds)");
    expect(english).not.toContain("当日总结");
  });

  test("浮层安全投影只有步骤、码、版本、时间，没有原文与用户内容", () => {
    const overlay = safeOverlayDiagnostics(failed, { state: "ready", version: "1.0.0-rc.1" }, now);
    expect(overlay).toContain("错误码: AI_TIMEOUT");
    expect(overlay).toContain(`com.reai.voice ${VOICE_PLUGIN_VERSION}`);
    expect(overlay).toContain("App 版本: 1.0.0-rc.1");
    expect(overlay).not.toContain("gateway");
    expect(overlay).not.toContain("你好世界");
  });

  test("插件版本常量与 manifest / package.json / 公开提交模板一致", () => {
    expect(json("app.manifest.json").version).toBe(VOICE_PLUGIN_VERSION);
    expect(json("package.json").version).toBe(VOICE_PLUGIN_VERSION);
    expect(json("package.json").scripts.pack).toContain(`voice-${VOICE_PLUGIN_VERSION}.reaiapp`);
    // Local submission identities remain private. The public template follows the source version.
    expect(json("submission.identity.example.json").version).toBe(VOICE_PLUGIN_VERSION);
  });
});
