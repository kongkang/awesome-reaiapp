import { describe, expect, test } from "bun:test";
import {
  voiceAgentUnavailableMessage,
  voiceHistorySaveFailureMessage,
  voiceRequestFailureMessage,
} from "../src/voice-user-errors";

describe("Voice 用户错误文案", () => {
  test("未知上游错误只说明结果、数据去向和下一步，不暴露内部错误", () => {
    const upstream = {
      code: "AI_INVALID_REQUEST",
      message: "INVALID_REQUEST: 502: Dsh 模型请求含 Host 未放行的字段",
    };
    expect(voiceRequestFailureMessage("reply", upstream)).toBe(
      "暂时无法生成回复。你的内容已保存，请稍后重新发送。",
    );
    expect(voiceRequestFailureMessage("summary", upstream)).toBe(
      "暂时无法生成总结。原始记录已保存，请稍后重试。",
    );
    for (const purpose of ["reply", "summary"] as const) {
      const message = voiceRequestFailureMessage(purpose, upstream);
      expect(message).not.toContain("INVALID_REQUEST");
      expect(message).not.toContain("502");
      expect(message).not.toContain("Dsh");
      expect(message).not.toContain("Host");
    }
  });

  test("只按稳定错误码给出能执行的下一步", () => {
    expect(voiceRequestFailureMessage("reply", { code: "AI_NOT_LOGGED_IN" })).toBe(
      "请先登录。你的内容已保存，登录后可以重新发送。",
    );
    expect(voiceRequestFailureMessage("reply", { stderr_tail: "upstream AI_RATE_LIMITED" })).toBe(
      "请求过于频繁。你的内容已保存，请稍后重新发送。",
    );
    expect(voiceRequestFailureMessage("summary", { code: "AI_PAYMENT_REQUIRED" })).toBe(
      "当前额度不足。原始记录已保存，补充额度后可以重试。",
    );
    expect(voiceRequestFailureMessage("summary", { code: "AGENT_SESSION_PERMISSION_REQUIRED" })).toBe(
      "还没有开启这项权限。原始记录已保存，开启后可以重试。",
    );
    expect(voiceRequestFailureMessage("reply", {
      code: "AGENT_ENGINE",
      userMessage: "暂时无法生成回复。你的内容已保存，请稍后重新发送。",
      cause: { kind: "engine", stderr_tail: "gateway AI_PAYMENT_REQUIRED" },
    })).toBe("当前额度不足。你的内容已保存，补充额度后可以重新发送。");
  });

  test("超时与用户取消分开说明", () => {
    expect(voiceRequestFailureMessage("reply", { kind: "timeout" })).toBe(
      "Agent 没有在 App 限定的时间内返回结果（超时）。你的内容已保存，可以重新发送。",
    );
    expect(voiceRequestFailureMessage("summary", { kind: "timeout" })).toBe(
      "生成总结没有在 App 限定的时间内完成（超时）。原始记录已保存，可以重试。",
    );
    expect(voiceRequestFailureMessage("reply", { kind: "killed" })).toBe("这次请求已取消。");
    expect(voiceRequestFailureMessage("summary", { kind: "killed" })).toBe(
      "这次总结已取消。原始记录仍在。",
    );
    // AppError 落历史时只保留归一后的 code，不能因此退回笼统文案。
    expect(voiceRequestFailureMessage("reply", { code: "AGENT_TIMEOUT" })).toBe(
      "Agent 没有在 App 限定的时间内返回结果（超时）。你的内容已保存，可以重新发送。",
    );
    expect(voiceRequestFailureMessage("reply", { code: "AGENT_KILLED" })).toBe("这次请求已取消。");
  });

  test("录音前的 Agent 门禁不复述后端 detail，也不声称内容已保存", () => {
    expect(voiceAgentUnavailableMessage("INVALID_REQUEST: Host backend missing")).toBe(
      "Agent 暂时不可用，请稍后重试。",
    );
    expect(voiceAgentUnavailableMessage("AI_NOT_LOGGED_IN")).toBe("请先登录，再使用 Agent。");
  });

  test("历史保存失败时不再承诺已保存，也不拼接存储层原文", () => {
    expect(voiceHistorySaveFailureMessage("reply")).toBe(
      "暂时无法生成回复，原话也没能保存到历史。请稍后重新发送。",
    );
    expect(voiceHistorySaveFailureMessage("translation")).toBe(
      "暂时无法完成翻译，原话也没能保存到历史。请稍后重试。",
    );
  });
});

describe("运行组件缺失（download_required）文案", () => {
  test("会话创建的 download_required 给出安装指引，不透传组件 id", () => {
    const upstream = {
      code: "AGENT_BACKEND_UNAVAILABLE",
      userMessage: "download_required: com.reai.runtime.dsh 或 com.reai.runtime.pi",
    };
    expect(voiceRequestFailureMessage("reply", upstream)).toBe(
      "请在 Driver「已安装」中打开 Voice 的运行组件，确认安装或使用授权。你的内容已保存，完成后可以重新发送。",
    );
    expect(voiceRequestFailureMessage("summary", upstream)).not.toContain("com.reai");
    // 门禁入参是 backends 的 detail 字符串时同样按缺组件分类。
    expect(voiceAgentUnavailableMessage("download_required: com.reai.runtime.pi")).toBe(
      "请在 Driver「已安装」中打开 Voice 的运行组件，确认安装或使用授权后重试。",
    );
  });

  test("后端不可用但没有 download_required 时保持暂时性故障文案", () => {
    expect(voiceAgentUnavailableMessage("包内 DSH manifest 不可读")).toBe(
      "Agent 暂时不可用，请稍后重试。",
    );
    expect(voiceRequestFailureMessage("reply", { code: "AGENT_BACKEND_UNAVAILABLE" })).toBe(
      "暂时无法生成回复。你的内容已保存，请稍后重新发送。",
    );
  });
});

describe("门禁自造错误的 runtime 归类", () => {
  test("kind 标记与 download_required 前缀走同一条安装指引归类", () => {
    const gateError = {
      code: "AGENT_BACKEND_UNAVAILABLE",
      userMessage: "请在 Driver「已安装」中打开 Voice 的运行组件，确认安装或使用授权后重试。",
      cause: { kind: "agent-runtime-missing" },
    };
    expect(voiceRequestFailureMessage("reply", gateError)).toBe(
      "请在 Driver「已安装」中打开 Voice 的运行组件，确认安装或使用授权。你的内容已保存，完成后可以重新发送。",
    );
  });
});
