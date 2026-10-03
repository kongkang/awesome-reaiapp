/**
 * Agent 阶段字段的去向（2.14.2）：主句按阶段 / 上游码说人话（中英文、带恢复动作）；
 * 阶段码 / 退出码 / 上游码进复制诊断、浮层诊断、日志投影与落盘；`Error:` 之后的原文一个字都不进。
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { setVoiceLocale } from "../src/voice-i18n";
import { voiceRequestFailureMessage } from "../src/voice-user-errors";
import { collectErrorFields, diagnosticLogFields, projectDiagnosticLogFields } from "../src/voice-error-fields";
import { buildVoiceDiagnosticsText, entryFromErrorDetail, errorDetailFrom, safeOverlayDiagnostics } from "../src/voice-diagnostics";
import { persistedAgentFailure } from "../src/data";

beforeEach(() => setVoiceLocale("zh"));

const SECRET_TAIL = "Error: upstream echoed 请把合同发给王经理 Authorization: Bearer abc.def sk-ABCDEFGH1234";
const failure = (prefix: string) => ({ kind: "engine", code: "AGENT_ENGINE", retry: "same-session",
  message: `引擎错误：${prefix}：${SECRET_TAIL}`, stderr_tail: `${prefix}：${SECRET_TAIL}` });
/** 与 app.ts 一样：插件把回合失败包成 AGENT_ENGINE 抛出，原始 failure 挂在 cause 上。 */
const wrapped = (prefix: string) => ({ code: "AGENT_ENGINE", cause: failure(prefix) });

describe("主句：按阶段码 / 上游码给一句人话，带恢复动作", () => {
  test("各阶段都有自己的主句（中英文），不再是笼统的「暂时无法生成回复」", () => {
    const cases: Array<[string, string, string]> = [
      ["DSH_ENGINE_EXITED（退出码 1）", "Agent 引擎启动后异常退出（退出码 1）。你的内容已保存，可以重新发送。",
        "The Agent engine exited unexpectedly after starting (exit code 1). Your content is saved; you can send it again."],
      ["DSH_ENGINE_EXITED（进程被终止：signal: 9）", "Agent 引擎启动后异常退出。你的内容已保存，可以重新发送。",
        "The Agent engine exited unexpectedly after starting. Your content is saved; you can send it again."],
      ["DSH_ENGINE_SPAWN_FAILED", "Agent 引擎没能启动。你的内容已保存，可以重新发送。",
        "The Agent engine could not start. Your content is saved; you can send it again."],
      ["DSH_ENGINE_SETUP_FAILED（写入任务帧失败）", "Agent 引擎启动了，但没能接收这次任务。你的内容已保存，可以重新发送。",
        "The Agent engine started but could not receive this task. Your content is saved; you can send it again."],
      ["DSH_ENGINE_EMPTY_REPLY（正常退出但没有回复）", "Agent 引擎运行结束，但没有给出回复。你的内容已保存，可以重新发送。",
        "The Agent engine finished without giving a reply. Your content is saved; you can send it again."],
      ["DSH_ENGINE_WAIT_FAILED（等待进程退出失败：x）", "App 没能确认 Agent 引擎是否已经结束。你的内容已保存，可以重新发送。",
        "The app could not confirm whether the Agent engine had finished. Your content is saved; you can send it again."],
      ["DSH_ENGINE_EXITED（退出码 1）［AI_RATE_LIMITED］", "上游模型限流。你的内容已保存，请稍后重新发送。",
        "The upstream model is rate limited. Your content is saved; send again a little later."],
      ["DSH_ENGINE_EXITED（退出码 1）［AI_STREAM_LOST］", "与上游模型的连接中断了。你的内容已保存，可以重新发送。",
        "The connection to the upstream model was interrupted. Your content is saved; you can send it again."],
    ];
    for (const [prefix, zh, en] of cases) {
      setVoiceLocale("zh");
      expect(voiceRequestFailureMessage("reply", wrapped(prefix))).toBe(zh);
      setVoiceLocale("en");
      expect(voiceRequestFailureMessage("reply", wrapped(prefix))).toBe(en);
    }
    setVoiceLocale("zh");
    expect(voiceRequestFailureMessage("translation", wrapped("DSH_ENGINE_EXITED（退出码 1）")))
      .toBe("Agent 引擎启动后异常退出（退出码 1）。你的内容已保存，可以重试。");
    expect(voiceRequestFailureMessage("translation", wrapped("DSH_ENGINE_EXITED（退出码 1）［AI_RATE_LIMITED］")))
      .toBe("上游模型限流。你的内容已保存，请稍后重试。");
  });

  test("既有分类的恢复动作优先（登录 / 额度…）；没有阶段的旧 Host 与 Pi / Codex 照旧", () => {
    expect(voiceRequestFailureMessage("reply", wrapped("DSH_ENGINE_EXITED（退出码 1）［AI_PAYMENT_REQUIRED］")))
      .toBe("当前额度不足。你的内容已保存，补充额度后可以重新发送。");
    expect(voiceRequestFailureMessage("reply", { kind: "engine", stderr_tail: "DSH_ENGINE_EXITED（退出码 1）：Error: upstream AI_NOT_LOGGED_IN" }))
      .toBe("请先登录。你的内容已保存，登录后可以重新发送。");
    expect(voiceRequestFailureMessage("reply", { kind: "engine", stderr_tail: "Error: legacy crash" }))
      .toBe("暂时无法生成回复。你的内容已保存，请稍后重新发送。");
    expect(voiceRequestFailureMessage("summary", { kind: "engine", stderr_tail: "Error: legacy crash" }))
      .toBe("暂时无法生成总结。原始记录已保存，请稍后重试。");
    // 总结同样跑在 DSH 引擎上：有阶段就按阶段说。
    expect(voiceRequestFailureMessage("summary", wrapped("DSH_ENGINE_EXITED（退出码 1）")))
      .toBe("Agent 引擎启动后异常退出（退出码 1）。原始记录已保存，可以重试。");
    for (const prefix of ["DSH_ENGINE_EXITED（退出码 1）", "DSH_ENGINE_EXITED（退出码 1）［AI_RATE_LIMITED］"]) {
      const message = voiceRequestFailureMessage("reply", wrapped(prefix));
      for (const leaked of ["Error", "王经理", "Bearer", "DSH_ENGINE", "AI_RATE_LIMITED"]) expect(message).not.toContain(leaked);
    }
  });

  test("方括号里 Host 报的上游码（限流）与原文里的可分类码并存时，按上游码说（上游码高于既有分类）", () => {
    const tail = "DSH_ENGINE_EXITED（退出码 1）［AI_RATE_LIMITED］：Error: upstream AI_NOT_LOGGED_IN";
    expect(voiceRequestFailureMessage("reply", { code: "AGENT_ENGINE", cause: { kind: "engine", stderr_tail: tail } }))
      .toBe("上游模型限流。你的内容已保存，请稍后重新发送。");
    // 方括号里是没有专门说法的上游码时，既有分类（登录）照常优先于阶段句。
    const unlisted = "DSH_ENGINE_EXITED（退出码 1）［AI_UNKNOWN］：Error: upstream AI_NOT_LOGGED_IN";
    expect(voiceRequestFailureMessage("reply", { code: "AGENT_ENGINE", cause: { kind: "engine", stderr_tail: unlisted } }))
      .toBe("请先登录。你的内容已保存，登录后可以重新发送。");
  });

  test("伪造同形对象：错误上自带的 agentStage / exitCode / agentFailure 不改主句", () => {
    const forged = { kind: "engine", agentStage: "DSH_ENGINE_EXITED", exitCode: 7, upstreamCode: "AI_STREAM_LOST",
      agentFailure: { agentStage: "DSH_ENGINE_EXITED", exitCode: 7 }, stderr_tail: "Error: legacy crash" };
    expect(voiceRequestFailureMessage("reply", forged)).toBe("暂时无法生成回复。你的内容已保存，请稍后重新发送。");
  });
});

describe("结构化字段进复制 / 浮层 / 日志 / 落盘；原文不进", () => {
  const PREFIX = "DSH_ENGINE_EXITED（退出码 1）［AI_RATE_LIMITED］";

  test("复制诊断与浮层含阶段码、退出码、上游码，不含 Error: 之后的任何原文", () => {
    const entry = entryFromErrorDetail(errorDetailFrom("agent", wrapped(PREFIX)));
    const copied = buildVoiceDiagnosticsText(entry, { state: "ready", version: "1.0.0-rc.1" });
    const overlay = safeOverlayDiagnostics(entry, { state: "ready", version: "1.0.0-rc.1" });
    for (const text of [copied, overlay]) {
      expect(text).toContain("Agent 阶段: 引擎异常退出 (DSH_ENGINE_EXITED)");
      expect(text).toContain("引擎退出码: 1");
      expect(text).toContain("引擎上报的上游码: AI_RATE_LIMITED");
      for (const leaked of ["Error", "upstream echoed", "王经理", "Bearer", "abc.def", "sk-ABCDEFGH1234"]) expect(text).not.toContain(leaked);
    }
    // 原文未经改动，只在内存（界面主动展开）。
    expect(entry.raw).toContain(`${PREFIX}：${SECRET_TAIL}`);
    setVoiceLocale("en");
    expect(buildVoiceDiagnosticsText(entry, undefined)).toContain("Agent stage: Engine exited unexpectedly (DSH_ENGINE_EXITED)");
  });

  test("日志投影与落盘只有结构化值；登记表外、越界、没登记的逐项丢弃", () => {
    const logged = diagnosticLogFields(wrapped(PREFIX));
    expect(logged.agentFailure).toEqual({ agentStage: "DSH_ENGINE_EXITED", exitCode: 1, upstreamCode: "AI_RATE_LIMITED" });
    expect(JSON.stringify(logged)).not.toContain("Error");
    expect(persistedAgentFailure({ errorAgentStage: "DSH_ENGINE_EXITED", errorExitCode: 1, errorUpstreamCode: "AI_RATE_LIMITED" }))
      .toEqual({ errorAgentStage: "DSH_ENGINE_EXITED", errorExitCode: 1, errorUpstreamCode: "AI_RATE_LIMITED" });
    expect(persistedAgentFailure({ errorAgentStage: "DSH_ENGINE_EXPLODED", errorExitCode: 1, errorUpstreamCode: "AI_RATE_LIMITED" })).toEqual({});
    expect(persistedAgentFailure({ errorAgentStage: "DSH_ENGINE_EXITED", errorExitCode: 2147483648, errorUpstreamCode: "PRIVATE_DATA" }))
      .toEqual({ errorAgentStage: "DSH_ENGINE_EXITED" });
    expect(persistedAgentFailure({ errorAgentStage: "DSH_ENGINE_EXITED", errorExitCode: "1" })).toEqual({ errorAgentStage: "DSH_ENGINE_EXITED" });
  });

  test("伪造同形对象：外部字段对象、被替换的 agentFailure 都不进诊断与日志", () => {
    const forgedStage = { agentStage: "DSH_ENGINE_EXITED", exitCode: 9, upstreamCode: "AI_RATE_LIMITED" };
    const legacy = { kind: "engine", stderr_tail: "Error: legacy crash" };
    // 调用方传入的不是采集出的字段：丢掉，改从 cause 重新采集（cause 里没有阶段前缀）。
    const detail = errorDetailFrom("agent", legacy, { fields: { upstreamCodes: [], agentFailure: forgedStage } as never });
    expect(detail.agentFailure).toBeUndefined();
    expect(collectErrorFields({ ...legacy, agentFailure: forgedStage, agentStage: "DSH_ENGINE_EXITED" }).agentFailure).toBeUndefined();
    expect(projectDiagnosticLogFields({ code: "AGENT_ENGINE", upstreamCodes: [], agentFailure: forgedStage } as never).agentFailure).toBeUndefined();
    const collected = collectErrorFields(wrapped(PREFIX));
    (collected as { agentFailure?: unknown }).agentFailure = forgedStage;
    expect(projectDiagnosticLogFields(collected).agentFailure).toBeUndefined();
  });
});
