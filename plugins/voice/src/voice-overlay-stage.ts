/**
 * 中央语音胶囊「停到写入那一刻」的插件侧收口（Host API 1.22，2026-09-28 并入）。
 *
 * 输入会话以 `holdOverlayUntilAck: true` 开始录音后，Host 在识别结束时把胶囊停在处理态，
 * 等插件：写入成功那一刻 `acknowledgeResult` 收起；写入失败 `reportStage("insert_failed")`
 * 让胶囊说一句「文字没有写入」（取回卡照旧弹）；途中 `reportStage` 只换那一句。
 * 命令会话（翻译 / 转文本）本来就等确认，同样用它换句子。
 *
 * SDK 运行时由 Host 注入：更早的 Host 没有 `reportStage`（调用会是 TypeError），或会拒绝
 * 未知方法——两种都吞掉，业务流程不受影响。确认同样尽力而为。
 */

export type VoiceOverlayStage =
  | "transcribing"
  | "transcribed"
  | "polishing"
  | "translating"
  | "insert_failed";

export interface VoiceOverlayStageClient {
  reportStage?: (sessionId: string, stage: VoiceOverlayStage) => Promise<unknown>;
  acknowledgeResult(sessionId: string): Promise<unknown>;
}

/** 等 `insert_failed` 等阶段上报的最长时间：纯呈现请求不能卡住取回卡与历史保存。 */
export const STAGE_REPORT_WAIT_MS = 500;

export interface VoiceOverlayStages {
  /**
   * 报告阶段。同一 session 的上报与确认按调用顺序串行送达 Host，旧进度不会越过新阶段。
   * `insert_failed` 须 await 完再做后续确认：确认先到会把胶囊直接收掉，失败那一句就丢了。
   * 最多等 [`STAGE_REPORT_WAIT_MS`]：超时后调用方可以继续弹卡、存历史。其余阶段可以 `void`。
   *
   * 队列里每一节也只占用同样的上限：请求已经发出却迟迟不回包时，到点就放行下一节，
   * 确认不会被一个永不回包的可选进度永久堵住，队列也总会排空清理。放行后 Host 的受理顺序
   * 可能与发出顺序相反，所以顺序由 Host 兜底：同一代阶段只进不退（迟到的旧阶段被拒）。
   * 阶段上报不确认交付：取回窗口可见后由调用方显式 release。
   */
  report(sessionId: string | undefined, stage: VoiceOverlayStage): Promise<void>;
  /**
   * 写入成功或没有可写的内容：收起中央胶囊。排在这个 session 已发出的上报之后；重复、迟到的确认在 Host 侧是幂等空操作。
   * 写回失败也只在取回窗口确认可见后 release。
   */
  release(sessionId: string | undefined): void;
  /** 仍有排队中请求的 session 数；测试用来确认队列会排空，不会随会话累积。 */
  queuedSessionCount(): number;
}

export function createVoiceOverlayStages(
  client: VoiceOverlayStageClient,
  waitMs: number = STAGE_REPORT_WAIT_MS,
): VoiceOverlayStages {
  // 每个 session 一条串行链；每节在请求结束或等满 waitMs 时放行下一节。
  const queues = new Map<string, Promise<void>>();
  const failedReports = new Map<string, Promise<unknown>>();
  const bounded = async (send: () => Promise<unknown>): Promise<void> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // 在本节里同步发出（不多垫一拍微任务），「转写完成」这类 fire-and-forget 进度才能赶在写入之前。
      // 旧 Host 不认识 voice.report-stage / 确认失败（同步抛或异步拒）：胶囊照旧按 Host 自己的节奏收。
      let request: Promise<unknown>;
      try {
        request = Promise.resolve(send()).catch(() => undefined);
      } catch {
        request = Promise.resolve();
      }
      await Promise.race([request, new Promise<void>(resolve => { timer = setTimeout(resolve, waitMs); })]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
  const enqueue = (sessionId: string, send: () => Promise<unknown>): Promise<void> => {
    const next = (queues.get(sessionId) ?? Promise.resolve()).then(() => bounded(send));
    queues.set(sessionId, next);
    void next.then(() => {
      if (queues.get(sessionId) === next) queues.delete(sessionId);
    });
    return next;
  };
  return {
    async report(sessionId, stage) {
      const reportStage = client.reportStage;
      if (!sessionId || typeof reportStage !== "function") return;
      const sent = enqueue(sessionId, () => {
        let request: Promise<unknown>;
        try {
          request = Promise.resolve(reportStage.call(client, sessionId, stage));
        } catch (cause) {
          request = Promise.reject(cause);
        }
        if (stage === "insert_failed") {
          failedReports.set(sessionId, request.catch(() => undefined));
          if (failedReports.size > 64) failedReports.delete(failedReports.keys().next().value!);
        }
        return request;
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([sent, new Promise<void>(resolve => { timer = setTimeout(resolve, waitMs); })]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    },
    release(sessionId) {
      if (!sessionId) return;
      const failed = failedReports.get(sessionId);
      if (failed) {
        void failed.then(() => enqueue(sessionId, () => client.acknowledgeResult(sessionId)));
      } else {
        void enqueue(sessionId, () => client.acknowledgeResult(sessionId));
      }
    },
    queuedSessionCount() {
      return queues.size;
    },
  };
}
