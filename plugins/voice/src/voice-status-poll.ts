/**
 * Voice 自身 1 秒状态轮询 / 手动刷新的 acknowledge 判据。
 *
 * M1（首审 2026-09-06，P1 竞态）：服务会话（request-text provider）在飞期间，
 * 异步终态（capture_limit / user_cancel / source_unavailable）的留存回执归
 * provider 沿 status(sessionId) 消费；Voice 轮询抢先 acknowledge 会把回执吃掉，
 * consumer 只能空转到总 deadline 报超时、丢掉已识别成功的文本。
 */
export function voiceStatusPollMayAcknowledge(input: {
  serviceOperationActive: boolean;
  expectedSessionId: string | undefined;
  statusSessionId?: string;
  stopReason?: string;
}): boolean {
  if (input.serviceOperationActive) return false;
  return Boolean(
    input.statusSessionId
    && input.statusSessionId === input.expectedSessionId
    && input.stopReason,
  );
}
