import type { RecoverableVoiceInputSession, SavedInputReceipt, SavedInputRequest, SavedInputSelection, VoiceRecordingsClient } from "@reai/app-sdk/v1";
import type { VoiceHistoryItem } from "./data";

export interface SavedInputRetryPlan {
  primary: SavedInputSelection;
  fallback?: SavedInputSelection;
}
export type SavedInputExecution = Omit<SavedInputReceipt, "recordingId" | "transcript">;
export type SavedInputRetryPhase = "preparing" | "local" | "cloud" | "fallback";
interface RetryRun { cancelled: boolean; attemptId?: string; promise: Promise<void>; }
interface Dependencies {
  client: Pick<VoiceRecordingsClient, "getInputSession" | "transcribeSavedInput" | "cancelSavedInput">;
  validateSelection?(selection: SavedInputSelection): Promise<void>;
  history(): VoiceHistoryItem[];
  update(id: string, change: (item: VoiceHistoryItem) => VoiceHistoryItem): Promise<VoiceHistoryItem[]>;
  publish(history: VoiceHistoryItem[]): void;
  /** attemptId 是本次发给 Host 的真实尝试身份；准备阶段还没有时缺席（诊断计时据此绑定尝试）。 */
  busy(recordingId: string, phase?: SavedInputRetryPhase, attemptId?: string): void;
}

export function projectSavedInputSession(item: VoiceHistoryItem, session: RecoverableVoiceInputSession): VoiceHistoryItem {
  const receipt = session.attempt;
  if (!receipt || receipt.revision < (item.savedInput?.revision ?? 0)) return item;
  const { recordingId: _id, transcript: _text, ...execution } = receipt;
  const complete = receipt.state === "complete";
  const { transcriptionStatus: _status, ...stable } = item;
  return {
    ...stable,
    savedInput: execution,
    ...(complete ? { transcript: session.transcript ?? item.transcript, recognitionEngine: receipt.selection.engine }
      : { transcriptionStatus: receipt.state === "pending" ? "pending" : "failed" }),
  };
}

/** Only transient recognition failures permit the already-disclosed one-way local fallback. */
export function savedInputMayFallback(receipt: SavedInputReceipt): boolean {
  return receipt.selection.engine === "cloud" && receipt.state === "failed"
    && ["AI_TIMEOUT", "AI_UNAVAILABLE", "AI_NETWORK_ERROR", "AI_SUBSCRIPTION_UNAVAILABLE"].includes(receipt.errorCode ?? "");
}

export class SavedInputRetryController {
  private runs = new Map<string, RetryRun>();
  private disposed = false;
  constructor(private deps: Dependencies) {}

  start(historyId: string, recordingId: string, selection: () => Promise<SavedInputRetryPlan>): Promise<void> {
    const existing = this.runs.get(recordingId);
    if (existing) return existing.promise;
    if (this.disposed) return Promise.resolve();
    const run: RetryRun = { cancelled: false, promise: Promise.resolve() };
    this.runs.set(recordingId, run);
    this.deps.busy(recordingId, "preparing");
    run.promise = this.execute(run, historyId, recordingId, selection).finally(() => {
      if (this.runs.get(recordingId) === run) this.runs.delete(recordingId);
      this.deps.busy(recordingId);
    });
    return run.promise;
  }

  private async execute(run: RetryRun, historyId: string, recordingId: string, selection: () => Promise<SavedInputRetryPlan>) {
    const plan = structuredClone(await selection());
    const alive = () => !run.cancelled && !this.disposed && this.deps.history().some(i => i.id === historyId && i.recordingId === recordingId);
    if (!alive()) return;
    let session = await this.deps.client.getInputSession(recordingId);
    if (!session) throw new Error("VOICE_SAVED_INPUT_NOT_FOUND");
    if (!alive()) return;
    if (session.transcriptionStatus === "complete" || session.transcriptionStatus === "pending") {
      await this.project(historyId, session); return;
    }
    this.deps.publish(await this.deps.update(historyId, item => ({ ...item, retryPlan: plan })));
    const choices = [plan.primary, ...(plan.primary.engine === "cloud" && plan.fallback?.engine === "local" ? [plan.fallback] : [])];
    for (const [index, choice] of choices.entries()) {
      if (!alive()) return;
      if (!Number.isSafeInteger(session.revision)) throw new Error("HOST_API_INCOMPATIBLE");
      const request: SavedInputRequest = { recordingId, attemptId: crypto.randomUUID(), expectedRevision: session.revision!, selection: choice };
      run.attemptId = request.attemptId;
      this.deps.busy(recordingId, index ? "fallback" : choice.engine, request.attemptId);
      // A thrown transport/storage error does not prove that Host failed the attempt.
      // The next poll recovers its receipt; never start a fallback from an exception.
      let receipt: SavedInputReceipt;
      try {
        if (choice.engine === "cloud" && choice.billingPolicy === "free-only") {
          if (!this.deps.validateSelection) throw Object.assign(new Error("HOST_API_INCOMPATIBLE"), { code: "HOST_API_INCOMPATIBLE" });
          await this.deps.validateSelection(choice);
          if (!alive()) return;
        }
        receipt = await this.deps.client.transcribeSavedInput(request);
      } catch (cause) {
        // A precise cancellation may reach Host before its begin transaction.
        // The resulting rejection is an expected cancellation, not a retry error.
        const code = cause && typeof cause === "object" && "code" in cause ? cause.code : undefined;
        if (run.cancelled || this.disposed || (typeof code === "string"
          && (code === "VOICE_CANCELLED" || code.endsWith("/VOICE_CANCELLED")))) return;
        throw cause;
      }
      session = await this.deps.client.getInputSession(recordingId);
      if (!session) return;
      await this.project(historyId, session);
      if (!alive() || session.attempt?.attemptId !== request.attemptId
        || session.revision !== receipt.revision || !savedInputMayFallback(receipt)) return;
    }
  }

  private async project(historyId: string, session: RecoverableVoiceInputSession) {
    this.deps.publish(await this.deps.update(historyId, item => projectSavedInputSession(item, session)));
  }

  async cancel(recordingId: string): Promise<void> {
    const run = this.runs.get(recordingId);
    if (run) run.cancelled = true;
    const attemptId = run?.attemptId ?? this.deps.history().find(i => i.recordingId === recordingId)?.savedInput?.attemptId;
    if (!attemptId) return;
    await this.deps.client.cancelSavedInput({ recordingId, attemptId });
    const session = await this.deps.client.getInputSession(recordingId);
    const item = this.deps.history().find(i => i.recordingId === recordingId);
    if (item && session) await this.project(item.id, session);
  }

  async cancelAll(): Promise<void> {
    await Promise.allSettled([...this.runs.keys()].map(id => this.cancel(id)));
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.cancelAll();
  }
}
