import type { VoiceModelInfo } from "@reai/app-sdk/v1";
import { collectErrorFields, type VoiceErrorFields } from "./voice-error-fields";

export interface LocalDownloadState {
  phase: "preparing" | "cancelling" | "cancelled" | "failed" | "completed";
  error?: string;
  /** 结构化诊断字段（§6.0）：码、来源、原文字符数；原文只在内存，界面主动展开才显示。 */
  fields?: VoiceErrorFields;
  /** 这次下载 / 取消操作开始的时刻（ms）。 */
  sinceMs?: number;
  /** 失败发生的时刻（ms）：诊断的「用时」与「发生时间」冻结在这里。 */
  failedAtMs?: number;
}

/** 失败状态：人话 + 诊断源，二者同一份 cause。 */
function failedState(error: string, cause: unknown, sinceMs?: number): LocalDownloadState {
  return {
    phase: "failed",
    error,
    failedAtMs: Date.now(),
    fields: collectErrorFields(cause),
    ...(sinceMs !== undefined ? { sinceMs } : {}),
  };
}

/** One coordinator for manual actions, setup and background refreshes. Host owns files. */
export class LocalModelDownloads {
  private models: VoiceModelInfo[] = [];
  private states: Record<string, LocalDownloadState> = {};
  private revision = 0;
  private query?: Promise<VoiceModelInfo[]>;
  private operations = new Map<string, Promise<void>>();
  private cancelled = new Set<string>();
  private completionTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private disposed = false;
  constructor(private ports: {
    list(): Promise<VoiceModelInfo[]>;
    download(id: string): Promise<VoiceModelInfo>;
    cancel(id: string): Promise<void>;
    publish(models: VoiceModelInfo[], states: Record<string, LocalDownloadState>): void;
    error(cause: unknown): string;
  }) {}

  get busy() { return this.operations.size > 0 || this.models.some(m => m.state === "downloading"); }
  private emit() { if (!this.disposed) this.ports.publish(this.models, { ...this.states }); }
  prepare(id: string) {
    if (this.disposed || this.operations.has(id)) return;
    const model = this.models.find(m => m.id === id);
    if (model && ["ready", "active", "downloading"].includes(model.state)) return;
    this.states[id] = { phase: "preparing", sinceMs: Date.now() }; this.emit();
  }
  clearPreparation(id: string) {
    if (this.states[id]?.phase === "preparing") { delete this.states[id]; this.emit(); }
  }
  private complete(id: string) {
    if (this.disposed) return;
    this.states[id] = { phase: "completed" };
    clearTimeout(this.completionTimers.get(id));
    this.completionTimers.set(id, setTimeout(() => {
      delete this.states[id]; this.completionTimers.delete(id); this.emit();
    }, 3000));
  }
  private accept(models: VoiceModelInfo[]) {
    for (const model of models) {
      const previous = this.models.find(m => m.id === model.id);
      if (model.state === "ready" || model.state === "active") {
        if (previous?.state === "downloading") {
          this.complete(model.id);
        } else if (this.states[model.id]?.phase !== "completed") delete this.states[model.id];
        this.cancelled.delete(model.id);
      } else if (this.cancelled.has(model.id) && model.state !== "downloading" && !this.operations.has(model.id)) {
        this.states[model.id] = { phase: "cancelled" }; this.cancelled.delete(model.id);
      }
    }
    this.models = models; this.emit();
  }
  refresh(): Promise<VoiceModelInfo[]> {
    if (this.query) return this.query;
    const revision = this.revision;
    const query = this.ports.list().then(models => {
      if (!this.disposed && revision === this.revision) this.accept(models);
      return this.models;
    }).finally(() => { if (this.query === query) this.query = undefined; });
    this.query = query; return query;
  }
  start(id: string, update = false): Promise<void> {
    if (this.disposed) return Promise.resolve();
    const existing = this.operations.get(id); if (existing) return existing;
    if (this.states[id]?.phase === "cancelling") return Promise.resolve();
    this.cancelled.delete(id); this.prepare(id);
    const startedAt = Date.now();
    const operation = (async () => {
      try {
        await this.refresh();
        if (this.disposed) return;
        if (this.cancelled.has(id)) { await this.ports.cancel(id); return; }
        const model = this.models.find(m => m.id === id);
        if (!model) throw new Error("Unknown local model");
        if (model.state === "downloading" || (!update && ["ready", "active"].includes(model.state))) {
          delete this.states[id]; this.emit(); return;
        }
        ++this.revision;
        this.states[id] = { phase: "preparing", sinceMs: startedAt }; this.emit();
        const result = await this.ports.download(id);
        ++this.revision;
        this.accept(this.models.map(m => m.id === id ? result : m));
        if (["ready", "active"].includes(result.state)) { this.complete(id); this.emit(); }
        else if (this.cancelled.has(id)) await this.ports.cancel(id);
        else { delete this.states[id]; this.emit(); }
      } catch (cause) {
        this.cancelled.delete(id);
        this.states[id] = failedState(this.ports.error(cause), cause, startedAt); this.emit();
      } finally {
        this.operations.delete(id);
        if (this.cancelled.has(id) && this.models.find(m => m.id === id)?.state !== "downloading") {
          this.states[id] = { phase: "cancelled" }; this.cancelled.delete(id); this.emit();
        }
      }
    })();
    this.operations.set(id, operation); return operation;
  }
  async cancel(id: string) {
    if (this.cancelled.has(id)) return;
    this.cancelled.add(id); ++this.revision;
    this.states[id] = { phase: "cancelling", sinceMs: Date.now() }; this.emit();
    if (this.operations.has(id)) return; // start() cancels after the request has returned.
    try { await this.ports.cancel(id); await this.refresh(); }
    catch (cause) {
      this.cancelled.delete(id); this.states[id] = failedState(this.ports.error(cause), cause); this.emit();
    }
  }
  dispose() {
    this.disposed = true;
    for (const timer of this.completionTimers.values()) clearTimeout(timer);
    this.completionTimers.clear();
  }
}
