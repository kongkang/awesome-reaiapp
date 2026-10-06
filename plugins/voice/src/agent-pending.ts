import type { AgentTurnStart, KeyValueStore } from "@reai/app-sdk/v1";

import { parseVoiceAttachmentTurnInput } from "./voice-attachment-input";

const KEY = "agent-pending-admissions-v2";
const RETENTION_MS = 24 * 60 * 60 * 1000;
const LIMIT = 8;
export interface PendingAgentRequest {
  taskId: string;
  createdAt: number;
  cancelled: boolean;
  request: AgentTurnStart;
}
const failure = (code: string) => Object.assign(new Error(code), { code, retryable: false });

/** Private, bounded journal. A saved request is evidence of intent, not acceptance. */
export class PendingAgentRequests {
  constructor(private readonly store: KeyValueStore, private readonly ownedSessions: () => Promise<readonly string[]>, private readonly now = Date.now) {}
  private rows(raw: unknown, owned: ReadonlySet<string>): PendingAgentRequest[] {
    if (!Array.isArray(raw)) return [];
    return raw.filter((value): value is PendingAgentRequest => value !== null && typeof value === "object"
      && typeof value.taskId === "string" && value.taskId.length <= 128
      && Number.isFinite(value.createdAt) && value.createdAt <= this.now() && this.now() - value.createdAt <= RETENTION_MS
      && typeof value.cancelled === "boolean" && typeof value.request?.sessionId === "string" && value.request.sessionId.startsWith("agent2-") && owned.has(value.request.sessionId)
      && typeof value.request?.idempotencyKey === "string" && value.request.idempotencyKey.length <= 128
      && typeof value.request?.text === "string" && value.request.text.length <= 64 * 1024
      && (value.request.attachmentInput === undefined || parseVoiceAttachmentTurnInput(value.request.attachmentInput) !== undefined)
      && [undefined, "caller", "host"].includes(value.request.taskPresentation)).slice(0, LIMIT);
  }
  private async edit(change: (rows: PendingAgentRequest[]) => PendingAgentRequest[]): Promise<void> {
    const owned = new Set(await this.ownedSessions());
    for (let attempt = 0; attempt < 5; attempt++) {
      const previous = await this.store.get<unknown>(KEY);
      const next = change(this.rows(previous, owned));
      const current = new Set(await this.ownedSessions());
      if (next.some(row => !current.has(row.request.sessionId))) throw failure("VOICE_REQUEST_SESSION_CHANGED");
      if (JSON.stringify(next).length > 256 * 1024) throw failure("AGENT_PENDING_CAPACITY");
      if (await this.store.compareAndSet(KEY, previous, next)) return;
    }
    throw failure("AGENT_PENDING_STORAGE_CONFLICT");
  }
  async save(taskId: string, request: AgentTurnStart, cancelled = false): Promise<void> {
    if (request.attachmentInput !== undefined && !parseVoiceAttachmentTurnInput(request.attachmentInput)) throw failure("AGENT_ATTACHMENT_CONTENT_INVALID");
    await this.edit(rows => {
      const old = rows.find(row => row.taskId === taskId);
      if (old && JSON.stringify(old.request) !== JSON.stringify(request)) throw failure("AGENT_PENDING_IDENTITY_CONFLICT");
      if (!old && rows.length >= LIMIT) throw failure("AGENT_PENDING_CAPACITY");
      return [...rows.filter(row => row.taskId !== taskId), { taskId, createdAt: old?.createdAt ?? this.now(), cancelled: cancelled || old?.cancelled || false, request: structuredClone(request) }];
    });
  }
  async list(): Promise<PendingAgentRequest[]> {
    const raw = await this.store.get(KEY);
    if (!Array.isArray(raw) || !raw.length) return [];
    const owned = new Set(await this.ownedSessions());
    const rows = this.rows(raw, owned);
    const current = new Set(await this.ownedSessions());
    if (rows.some(row => !current.has(row.request.sessionId))) throw failure("VOICE_REQUEST_SESSION_CHANGED");
    return structuredClone(rows);
  }
  async get(taskId: string): Promise<PendingAgentRequest> {
    const pending = (await this.list()).find(row => row.taskId === taskId);
    if (!pending) throw failure("AGENT_PENDING_NOT_FOUND");
    return structuredClone(pending);
  }
  async clear(taskId: string): Promise<void> { await this.edit(rows => rows.filter(row => row.taskId !== taskId)); }
  async cancel(taskId: string): Promise<void> { await this.edit(rows => rows.map(row => row.taskId === taskId ? { ...row, cancelled: true } : row)); }
}
