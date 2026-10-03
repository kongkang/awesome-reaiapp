import type { ServiceCaller } from "./services";

// Runtime-private admission ledger. No content or credentials enter these records.
export interface ServiceEnvelope {
  correlationId: string;
  requestId?: string;
  caller?: ServiceCaller;
  deadlineUnixMs?: number;
}
type Rejection = "INVALID_ARGUMENT" | "SERVICE_TIMEOUT" | "SERVICE_CANCELLED" | "SERVICE_BUSY";
type ModernScope = { rejectThrough: number; expiresAt: number; cancelled: Map<string, number> };
type LegacyScope = { blocked: boolean; cancelled: Map<string, number> };
const ID_LIMIT = 256;
const SCOPE_LIMIT = 128;
const FRESH_MS = 60_000;
const FUTURE_MS = 5_000;
const modernPattern = /^service-v1:([1-9][0-9]*):[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function serviceRequestIdFactory(now = Date.now, uuid = () => crypto.randomUUID()): () => string {
  let previous = 0;
  return () => `service-v1:${previous = Math.max(now(), previous + 1)}:${uuid()}`;
}

function scopeKey(caller?: ServiceCaller): string | undefined {
  if (!caller) return undefined;
  const parts = [caller.appId, caller.surfaceMountId, caller.runtimeSessionId];
  if (parts.some((part) => typeof part !== "string" || !part.length || part.length > 256)) return undefined;
  return JSON.stringify(parts);
}

export function sameServiceOwner(left: ServiceEnvelope, right: ServiceEnvelope): boolean {
  // A legacy cancel can omit metadata; if present, it must match the known invoke.
  return (right.caller === undefined || (scopeKey(right.caller) !== undefined && scopeKey(left.caller) === scopeKey(right.caller)))
    && (right.caller?.accountGeneration === undefined || left.caller?.accountGeneration === right.caller.accountGeneration)
    && (right.requestId === undefined || left.requestId === right.requestId);
}

export class ServiceCancellationLedger {
  private clockFloor = 0;
  private readonly modern = new Map<string, ModernScope>();
  private readonly legacy = new Map<string, LegacyScope>();
  private readonly unscoped: LegacyScope = { blocked: false, cancelled: new Map() };
  private unregisteredScopeRejectThrough = 0;
  private legacyNewScopeBlocked = false;

  constructor(private readonly readClock = Date.now) {}

  now(): number {
    return this.clockFloor = Math.max(this.clockFloor, this.readClock());
  }

  private prune(now: number): void {
    for (const [key, scope] of this.modern) if (scope.expiresAt < now) this.modern.delete(key);
    // Legacy records with no deadline and overflow flags survive until runtime disposal.
    for (const scope of [...this.legacy.values(), this.unscoped]) {
      for (const [id, deadline] of scope.cancelled) if (deadline <= now) scope.cancelled.delete(id);
    }
  }

  private parse(envelope: ServiceEnvelope, now: number): { key?: string; id: string; createdAt?: number; error?: Rejection } {
    const id = envelope.requestId ?? envelope.correlationId;
    const key = scopeKey(envelope.caller);
    if (typeof id !== "string" || !id.length || id.length > 256
      || typeof envelope.correlationId !== "string" || !envelope.correlationId.length || envelope.correlationId.length > 256
      || (envelope.caller !== undefined && key === undefined)) return { id, error: "INVALID_ARGUMENT" };
    if (envelope.deadlineUnixMs !== undefined && (!Number.isFinite(envelope.deadlineUnixMs) || envelope.deadlineUnixMs <= now)) {
      return { id, error: "SERVICE_TIMEOUT" };
    }
    // Old Host envelopes without trusted caller/request metadata stay in their own pool.
    if (!key || !id.startsWith("service-v1:")) return { ...(key ? { key } : {}), id };
    const match = modernPattern.exec(id);
    const createdAt = match ? Number(match[1]) : NaN;
    if (!Number.isSafeInteger(createdAt) || createdAt > now + FUTURE_MS) return { id, error: "INVALID_ARGUMENT" };
    // A complete Host envelope has already passed Broker admission before cold
    // startup. Its original deadline, never a newly minted one, is authoritative.
    if (envelope.deadlineUnixMs === undefined && createdAt + FRESH_MS < now) return { id, error: "SERVICE_TIMEOUT" };
    return { key, id, createdAt };
  }

  private modernScope(key: string, expiresAt: number): ModernScope | undefined {
    let scope = this.modern.get(key);
    if (!scope && this.modern.size < SCOPE_LIMIT) {
      scope = { rejectThrough: this.unregisteredScopeRejectThrough, expiresAt, cancelled: new Map() };
      this.modern.set(key, scope);
    }
    if (scope) scope.expiresAt = Math.max(scope.expiresAt, expiresAt);
    return scope;
  }

  private legacyScope(key?: string): LegacyScope | undefined {
    if (!key) return this.unscoped;
    let scope = this.legacy.get(key);
    if (!scope && !this.legacyNewScopeBlocked && this.legacy.size < SCOPE_LIMIT) {
      scope = { blocked: false, cancelled: new Map() };
      this.legacy.set(key, scope);
    }
    return scope;
  }

  admit(envelope: ServiceEnvelope): Rejection | undefined {
    const now = this.now();
    this.prune(now);
    const parsed = this.parse(envelope, now);
    if (parsed.error) return parsed.error;
    const { key, id, createdAt } = parsed;
    if (key && this.unscoped.cancelled.has(envelope.correlationId)) {
      // Only the exact old correlation is transferred. Never execute this late invoke.
      this.cancel(envelope);
      this.unscoped.cancelled.delete(envelope.correlationId);
      return "SERVICE_CANCELLED";
    }
    if (createdAt !== undefined && key) {
      const scope = this.modernScope(key, Math.max(createdAt + FRESH_MS, envelope.deadlineUnixMs ?? 0));
      if (!scope) return "SERVICE_BUSY";
      if (createdAt <= scope.rejectThrough || scope.cancelled.has(id)) return "SERVICE_CANCELLED";
      return undefined;
    }
    const scope = this.legacyScope(key);
    if (!scope) return "SERVICE_BUSY";
    if (scope.cancelled.has(id)) return "SERVICE_CANCELLED";
    return scope.blocked ? "SERVICE_BUSY" : undefined;
  }

  cancel(envelope: ServiceEnvelope): void {
    const now = this.now();
    this.prune(now);
    const parsed = this.parse(envelope, now);
    // An already-running handler is aborted by the runtime independently of this
    // first-admission ledger, including when its 60-second window has elapsed.
    if (parsed.error) return;
    const { key, id, createdAt } = parsed;
    if (createdAt !== undefined && key) {
      const scope = this.modernScope(key, Math.max(createdAt + FRESH_MS, envelope.deadlineUnixMs ?? 0));
      if (!scope) {
        this.unregisteredScopeRejectThrough = Math.max(this.unregisteredScopeRejectThrough, createdAt);
        return;
      }
      if (createdAt <= scope.rejectThrough || scope.cancelled.has(id)) return;
      if (scope.cancelled.size < ID_LIMIT) scope.cancelled.set(id, createdAt);
      else {
        scope.rejectThrough = Math.max(scope.rejectThrough, createdAt, ...scope.cancelled.values());
        scope.cancelled.clear();
      }
      return;
    }
    const scope = this.legacyScope(key);
    if (!scope) {
      this.legacyNewScopeBlocked = true;
      return;
    }
    if (scope.cancelled.has(id)) return;
    if (scope.cancelled.size < ID_LIMIT) scope.cancelled.set(id, envelope.deadlineUnixMs ?? Infinity);
    else scope.blocked = true;
  }

  clear(): void {
    this.modern.clear();
    this.legacy.clear();
    this.unscoped.cancelled.clear();
    this.unscoped.blocked = false;
    this.unregisteredScopeRejectThrough = 0;
    this.legacyNewScopeBlocked = false;
    // Time observed by this runtime never moves backwards, even on disposal.
  }
}
