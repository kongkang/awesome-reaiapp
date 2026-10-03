import { describe, expect, test } from "bun:test";
import { voiceStatusPollMayAcknowledge } from "../src/voice-status-poll";

describe("Voice 状态轮询 acknowledge 判据（M1 首审 2026-09-06）", () => {
  const base = { expectedSessionId: "s1", statusSessionId: "s1", stopReason: "capture_limit" };

  test("服务会话在飞期间，异步终态的留存回执不得被 Voice 轮询抢先 acknowledge", () => {
    // capture_limit / user_cancel / source_unavailable 都由 provider 消费；
    // 抢先 acknowledge 会让 consumer 空转到总 deadline 丢掉已识别文本。
    expect(voiceStatusPollMayAcknowledge({ ...base, serviceOperationActive: true })).toBe(false);
  });

  test("非服务会话维持原判据：精确 session + stopReason 才 acknowledge", () => {
    expect(voiceStatusPollMayAcknowledge({ ...base, serviceOperationActive: false })).toBe(true);
    expect(voiceStatusPollMayAcknowledge({
      serviceOperationActive: false,
      expectedSessionId: "s1",
      statusSessionId: "s2",
      stopReason: "capture_limit",
    })).toBe(false);
    expect(voiceStatusPollMayAcknowledge({
      serviceOperationActive: false,
      expectedSessionId: "s1",
      statusSessionId: "s1",
    })).toBe(false);
    expect(voiceStatusPollMayAcknowledge({
      serviceOperationActive: false,
      expectedSessionId: undefined,
      statusSessionId: "s1",
      stopReason: "capture_limit",
    })).toBe(false);
  });
});
