import type { ServiceCaller, ServiceInvocation, VoiceInputResult } from "@reai/app-sdk/v1";
import { parseVoiceTextRequest, VoiceAdmissionError, VoiceRequestAdmission, voiceRequestOwnerKey } from "./voice-request-admission";

type Phase = "preparing" | "waiting_permission" | "listening" | "processing" | "completed" | "cancelled" | "failed" | "timed_out";
export interface VoiceTextOutput { text: string; kind: "processed" | "raw" | "raw_fallback" }
export interface VoiceRequestSnapshot {
  requestId: string;
  phase: Phase | "not_found";
  revision: number;
  captureStarted: boolean;
  pcmReceived: boolean | "unknown";
  errorCode?: string;
}

/** 适配现有 Voice/Cloud 窄口，不接受消费者音频，也不包含注入方法。 */
export interface VoiceRequestTextPorts {
  reserve(): (() => void) | undefined;
  prepare(signal: AbortSignal, reportWaitingPermission: () => void): Promise<void>;
  isAccountCurrent(expectedGeneration: string | undefined): Promise<boolean>;
  start(options: { requestId: string; insertText: false; captureDeliveryTarget: false; retainResultUntilAck: true }): Promise<VoiceInputResult>;
  finish(sessionId: string): Promise<VoiceInputResult>;
  cancelPendingStart(requestId: string): Promise<void>;
  cancel(sessionId: string): Promise<void>;
  acknowledge(sessionId: string): Promise<void>;
  readStatus(sessionId: string): Promise<{ phase: "idle" | "listening" | "recognizing"; sessionId?: string; pcmReceived?: boolean; result?: VoiceInputResult; resultError?: { code: string; message: string }; stopReason?: string }>;
  process(result: VoiceInputResult, signal: AbortSignal): Promise<VoiceTextOutput>;
}

interface Operation {
  owner: string;
  caller: ServiceCaller;
  accountGeneration: string | undefined;
  snapshot: VoiceRequestSnapshot;
  controller: AbortController;
  release: () => void;
  resolve?: (output: VoiceTextOutput & { requestId: string }) => void;
  reject?: (error: VoiceAdmissionError) => void;
  detachAbort: () => void;
  timer?: ReturnType<typeof setTimeout>;
  poll?: ReturnType<typeof setTimeout>;
  accountPoll?: ReturnType<typeof setTimeout>;
  startHandle?: string;
  sessionId?: string;
  finishRequested: boolean;
  processing: boolean;
  work: number;
  terminalAt?: number;
  cleanup?: Promise<void>;
  released: boolean;
  terminalErrorCode?: string;
}

/** 一个原请求保持到最终文本；控制方法只回执，不另交付文本。 */
export class VoiceRequestTextProvider {
  private readonly operations = new Map<string, Operation>();
  private readonly pollMs: number;
  private readonly now: () => number;
  private disposed = false;
  /** 最近观察到的 Host opaque 代际；未定义 = Host 尚未下发（F01 前）。 */
  private observedGeneration: string | undefined;
  /** R1/R6：清理传输失败后的周期重试定时器；入口重试之外，无需新请求也能自愈。 */
  private cleanupRetryTimer?: ReturnType<typeof setTimeout>;
  private readonly cleanupRetryMs: number;

  constructor(
    private readonly admission: VoiceRequestAdmission,
    private readonly ports: VoiceRequestTextPorts,
    options: { pollMs?: number; now?: () => number; cleanupRetryMs?: number } = {},
  ) {
    this.pollMs = options.pollMs ?? 250;
    this.now = options.now ?? Date.now;
    this.cleanupRetryMs = options.cleanupRetryMs ?? 5_000;
  }

  async request(invocation: ServiceInvocation): Promise<VoiceTextOutput & { requestId: string }> {
    if (this.disposed) throw new VoiceAdmissionError("SERVICE_CANCELLED");
    const owner = voiceRequestOwnerKey(invocation.caller);
    const input = parseVoiceTextRequest(invocation.input);
    if (invocation.signal.aborted) throw new VoiceAdmissionError("SERVICE_CANCELLED");
    // R1/R6：清理阶段一次传输层失败不把采集槽焊死到插件重载——新请求入口
    // 先重试一轮未完成的清理，成功即释放，本次请求可继续。
    await this.retryCleanup();
    // 主裁定 A 硬条件：首次观察到任何代际后，未定义/不同代际的旧 op 一律失效；
    // 代际标签只做字符串相等比较，不解析、不伪造。缺省受理时限频告警，
    // 让真实 Host 日志能看出仍处于「无代际模式」。
    const observed = invocation.caller!.accountGeneration;
    // 代际标签只做字符串相等比较，不解析、不伪造；观察到新代际即失效未定义/
    // 不同代际的旧 op（Host 信封必带代际后，缺代际请求在 ownerKey 处已 fail-closed）。
    if (observed !== undefined && observed !== this.observedGeneration) {
      this.observedGeneration = observed;
      for (const other of this.operations.values()) {
        if (other.accountGeneration !== observed) {
          this.terminate(other, "VOICE_REQUEST_SESSION_CHANGED");
        }
      }
    }
    this.prune();
    const key = JSON.stringify([owner, input.requestId]);
    if (this.operations.has(key)) throw new VoiceAdmissionError("VOICE_REQUEST_REPLAYED");
    const deadline = Math.min(this.now() + input.timeoutMs, invocation.deadlineUnixMs ?? Infinity);
    if (!Number.isFinite(deadline) || deadline <= this.now()) throw new VoiceAdmissionError("SERVICE_TIMEOUT");
    const release = this.ports.reserve();
    if (!release) throw new VoiceAdmissionError("SERVICE_BUSY");
    let resolve!: Operation["resolve"];
    let reject!: Operation["reject"];
    const result = new Promise<VoiceTextOutput & { requestId: string }>((ok, fail) => { resolve = ok; reject = fail; });
    const op: Operation = {
      owner, caller: invocation.caller!, accountGeneration: invocation.caller!.accountGeneration,
      snapshot: { requestId: input.requestId, phase: "preparing", revision: 1, captureStarted: false, pcmReceived: "unknown" },
      controller: new AbortController(), release, resolve, reject, detachAbort: () => undefined,
      finishRequested: false, processing: false, work: 1, released: false,
    };
    this.operations.set(key, op);
    const abort = () => this.terminate(op, "SERVICE_CANCELLED");
    invocation.signal.addEventListener("abort", abort, { once: true });
    op.detachAbort = () => invocation.signal.removeEventListener("abort", abort);
    op.timer = setTimeout(() => this.terminate(op, "SERVICE_TIMEOUT"), Math.max(0, deadline - this.now()));
    if (invocation.signal.aborted) abort();
    this.watchAccount(op);
    void this.start(op, invocation.caller!, input);
    return result;
  }

  status(caller: ServiceCaller | undefined, input: unknown): VoiceRequestSnapshot {
    const request = parseVoiceTextRequest(input);
    const op = this.find(caller, request.requestId);
    return op ? { ...op.snapshot } : { requestId: request.requestId, phase: "not_found", revision: 0, captureStarted: false, pcmReceived: "unknown" };
  }

  finish(caller: ServiceCaller | undefined, input: unknown): { accepted: boolean } {
    const op = this.find(caller, parseVoiceTextRequest(input).requestId);
    if (!op || op.terminalAt !== undefined || !op.sessionId) return { accepted: false };
    if (op.finishRequested || op.processing) return { accepted: true };
    // R2：轮询已观测到 recognizing（phase=processing）而 receive 尚未把
    // op.processing 置位——这个窗口里重复 finish 幂等回 true：请求会正常完成，
    // 不再发第二次结束 IPC，也不把 consumer 误导向失败。
    if (op.snapshot.phase === "processing") return { accepted: true };
    if (op.snapshot.phase !== "listening") return { accepted: false };
    op.finishRequested = true;
    op.work++;
    void (async () => {
      try {
        if (!await this.current(op) || !this.live(op)) return;
        let result: VoiceInputResult;
        try { result = await this.ports.finish(op.sessionId!); }
        catch (error) {
          // 轮询可能已经接纳同一Host终态，另一条结束IPC的迟到错误不能反杀处理链。
          if (!op.processing) this.fail(op, error);
          return;
        }
        await this.receive(op, result);
      } catch (error) { this.fail(op, error); }
      finally { op.work--; this.maybeCleanup(op); }
    })();
    return { accepted: true };
  }

  async cancel(caller: ServiceCaller | undefined, input: unknown): Promise<{ accepted: boolean }> {
    const op = this.find(caller, parseVoiceTextRequest(input).requestId);
    if (!op) {
      try {
        // 控制调用可能比原request handler先执行；持久记录精确owner+业务ID，避免迟到启动。
        await this.admission.claim(caller, input, true);
      } catch (error) {
        if (!(error instanceof VoiceAdmissionError)
          || !["SERVICE_CANCELLED", "VOICE_REQUEST_REPLAYED"].includes(error.code)) throw error;
      }
      return { accepted: true };
    }
    this.terminate(op, "SERVICE_CANCELLED");
    return { accepted: true };
  }

  /** 正在 listening 的服务请求（含可信 caller）：硬件二触从这里桥回原 Promise。 */
  listeningRequests(): Array<{ caller: ServiceCaller; requestId: string }> {
    return [...this.operations.values()]
      .filter((op) => op.terminalAt === undefined && op.snapshot.phase === "listening" && op.sessionId !== undefined)
      .map((op) => ({ caller: op.caller, requestId: op.snapshot.requestId }));
  }

  invalidateAccount(currentGeneration: string): void {
    for (const op of this.operations.values()) {
      if (op.accountGeneration !== currentGeneration) this.terminate(op, "VOICE_REQUEST_SESSION_CHANGED");
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.cleanupRetryTimer !== undefined) clearTimeout(this.cleanupRetryTimer);
    this.cleanupRetryTimer = undefined;
    for (const op of this.operations.values()) this.terminate(op, "SERVICE_CANCELLED");
  }

  retryCleanup(): Promise<void> {
    const pending: Array<Promise<unknown>> = [];
    for (const op of this.operations.values()) {
      this.maybeCleanup(op);
      if (op.cleanup) pending.push(op.cleanup.catch(() => undefined));
    }
    return Promise.all(pending).then(() => undefined);
  }

  private async start(op: Operation, caller: ServiceCaller, input: unknown): Promise<void> {
    try {
      await this.admission.claim(caller, input);
      if (!await this.current(op) || !this.live(op)) return;
      await this.ports.prepare(op.controller.signal, () => this.phase(op, "waiting_permission"));
      if (!await this.current(op) || !this.live(op)) return;
      this.phase(op, "preparing");
      // 与 consumer 的 60 秒 admission ID 分离，在权限完成后才生成 30 秒启动 handle。
      op.startHandle = `${this.now()}:${crypto.randomUUID()}`;
      const result = await this.ports.start({ requestId: op.startHandle, insertText: false, captureDeliveryTarget: false, retainResultUntilAck: true });
      op.sessionId = result.sessionId;
      if (!await this.current(op) || !this.live(op)) return;
      if (result.phase !== "listening" || !op.sessionId) throw new VoiceAdmissionError("VOICE_CAPTURE_NOT_STARTED");
      op.snapshot.captureStarted = true;
      this.phase(op, "listening");
      this.schedulePoll(op);
    } catch (error) { this.fail(op, error); }
    finally { op.work--; this.maybeCleanup(op); }
  }

  private async current(op: Operation): Promise<boolean> {
    if (!this.live(op)) return false;
    const current = await this.ports.isAccountCurrent(op.accountGeneration);
    if (!this.live(op)) return false;
    if (!current) { this.terminate(op, "VOICE_REQUEST_SESSION_CHANGED"); return false; }
    return true;
  }

  private live(op: Operation): boolean {
    return op.terminalAt === undefined && !op.controller.signal.aborted;
  }

  /** Account lifetime is independent of recording status: permission dialogs and
   * suspended processing must also be cancelled without waiting for their reply. */
  private watchAccount(op: Operation): void {
    if (!this.live(op)) return;
    op.accountPoll = setTimeout(() => {
      void (async () => {
        try { await this.current(op); }
        catch (error) { this.fail(op, error); }
        finally { this.watchAccount(op); }
      })();
    }, this.pollMs);
  }

  private schedulePoll(op: Operation): void {
    if (op.terminalAt !== undefined || op.processing) return;
    op.poll = setTimeout(() => {
      op.work++;
      void (async () => {
        try {
          if (!await this.current(op) || !this.live(op)) return;
          let status: Awaited<ReturnType<VoiceRequestTextPorts["readStatus"]>>;
          try { status = await this.ports.readStatus(op.sessionId!); }
          catch (error) { if (!op.processing) this.fail(op, error); return; }
          if (!await this.current(op) || !this.live(op)) return;
          if (op.processing) return;
          if (status.sessionId && status.sessionId !== op.sessionId) throw new VoiceAdmissionError("VOICE_CAPTURE_SESSION_CHANGED");
          if (typeof status.pcmReceived === "boolean" && op.snapshot.pcmReceived !== status.pcmReceived) {
            op.snapshot.pcmReceived = status.pcmReceived;
            op.snapshot.revision++;
          }
          if (status.phase === "recognizing") this.phase(op, "processing");
          if (status.result) await this.receive(op, status.result);
          else if (status.resultError) this.terminate(op, status.resultError.code);
          else if (status.phase === "idle" && status.stopReason) this.terminate(op,
            status.stopReason === "user_cancel" ? "SERVICE_CANCELLED" : "VOICE_CAPTURE_INTERRUPTED");
        } catch (error) { this.fail(op, error); }
        finally { op.work--; this.maybeCleanup(op); this.schedulePoll(op); }
      })();
    }, this.pollMs);
  }

  private async receive(op: Operation, result: VoiceInputResult): Promise<void> {
    if (op.processing || op.terminalAt !== undefined) return;
    if (result.sessionId !== op.sessionId || result.phase !== "idle") throw new VoiceAdmissionError("VOICE_CAPTURE_SESSION_CHANGED");
    if (result.outcome === "cancelled") { this.terminate(op, "SERVICE_CANCELLED"); return; }
    op.processing = true;
    clearTimeout(op.poll);
    if (!await this.current(op) || !this.live(op)) return;
    this.phase(op, "processing");
    const output = await this.ports.process(result, op.controller.signal);
    if (!await this.current(op) || !this.live(op)) return;
    if (typeof output.text !== "string") throw new VoiceAdmissionError("VOICE_REQUEST_INVALID_RESULT");
    this.phase(op, "completed");
    op.terminalAt = this.now();
    this.clearWaits(op);
    op.resolve?.({ ...output, requestId: op.snapshot.requestId });
    op.resolve = undefined;
    op.reject = undefined;
  }

  private phase(op: Operation, phase: Phase): void {
    if (op.terminalAt !== undefined || op.snapshot.phase === phase) return;
    op.snapshot.phase = phase;
    op.snapshot.revision++;
  }

  private terminate(op: Operation, code: string): void {
    if (op.terminalAt !== undefined) return;
    this.phase(op, code === "SERVICE_CANCELLED" ? "cancelled" : code === "SERVICE_TIMEOUT" ? "timed_out" : "failed");
    op.snapshot.errorCode = code;
    op.terminalErrorCode = code;
    op.terminalAt = this.now();
    this.clearWaits(op);
    op.reject?.(new VoiceAdmissionError(code));
    op.resolve = undefined;
    op.reject = undefined;
    op.controller.abort();
    if (op.startHandle && !op.sessionId) void this.ports.cancelPendingStart(op.startHandle).catch(() => undefined);
    // 正在启动/处理的 Promise 仍握住资源归属；晚到 session 被精确取消之后才释放。
    if (op.sessionId) void this.ports.cancel(op.sessionId).catch(() => undefined);
    this.maybeCleanup(op);
  }

  private fail(op: Operation, error: unknown): void {
    const code = error && typeof error === "object" && "code" in error && typeof error.code === "string"
      ? error.code : "SERVICE_PROVIDER_FAILED";
    this.terminate(op, code);
  }

  private clearWaits(op: Operation): void {
    clearTimeout(op.timer);
    clearTimeout(op.poll);
    clearTimeout(op.accountPoll);
    op.detachAbort();
  }

  private maybeCleanup(op: Operation): void {
    if (op.terminalAt === undefined || op.work !== 0 || op.cleanup || op.released) return;
    op.cleanup = (async () => {
      if (op.sessionId) {
        if (op.snapshot.phase !== "completed") await this.ports.cancel(op.sessionId);
        await this.ports.acknowledge(op.sessionId);
      } else if (op.startHandle) {
        // 启动IPC失败也可能留下Host Preparing，必须等精确handle取消回执后才让出槽。
        await this.ports.cancelPendingStart(op.startHandle);
      }
      op.release();
      op.released = true;
      if (op.snapshot.errorCode === "VOICE_CAPTURE_CLEANUP_REQUIRED") {
        if (op.terminalErrorCode) op.snapshot.errorCode = op.terminalErrorCode;
        else delete op.snapshot.errorCode;
        op.snapshot.revision++;
      }
    })().catch(() => {
      // 精确取消/消费确认失败时保留 busy，不能让下一次录音接管尚未确认释放的槽。
      op.snapshot.errorCode = "VOICE_CAPTURE_CLEANUP_REQUIRED";
      op.snapshot.revision++;
      op.cleanup = undefined;
      // R1/R6：不用等下一次请求——Voice 自身听写/轮询也卡在同一开关后面，
      // 周期重试让槽位与界面无需新请求就能自愈。
      this.scheduleCleanupRetry();
    });
  }

  private scheduleCleanupRetry(): void {
    if (this.disposed || this.cleanupRetryTimer !== undefined) return;
    this.cleanupRetryTimer = setTimeout(() => {
      this.cleanupRetryTimer = undefined;
      void this.retryCleanup();
    }, this.cleanupRetryMs);
  }

  private find(caller: ServiceCaller | undefined, requestId: string): Operation | undefined {
    this.prune();
    return this.operations.get(JSON.stringify([voiceRequestOwnerKey(caller), requestId]));
  }

  private prune(): void {
    const terminal = [...this.operations].filter(([, op]) => op.terminalAt !== undefined);
    for (const [key, op] of terminal) {
      if (op.released && this.now() - op.terminalAt! >= 60_000) this.operations.delete(key);
    }
    for (const [key, op] of terminal) {
      if (this.operations.size < 32) break;
      if (op.released) this.operations.delete(key);
    }
  }
}
