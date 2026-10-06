import type { PendingAgentRequests, PendingAgentRequest } from "./agent-pending";
import type { AgentSessionClient, AgentSendResult, AgentServiceEvent, AgentTurnRef, LocalAgentEvent } from "@reai/app-sdk/v1";

export type VoiceAgentTurnClient = Pick<AgentSessionClient, "send" | "startTurn" | "waitForTurn" | "events" | "cancel">;

type Send = Parameters<AgentSessionClient["send"]>[0] & { recovery?: PendingAgentRequest; remember?: boolean; resume?: AgentTurnRef; onAccepted?: (ref: AgentTurnRef) => Promise<void> };
type Active = {
  taskId: string; journalId: string; journal?: PendingAgentRequests; ref?: AgentTurnRef; cancelled: boolean; cancelSent: boolean;
  replaying: boolean; pending: LocalAgentEvent[]; seen: Set<number>; sequence: number;
};

/** UI request identity stays local; only service receipts identify native turns. */
export function createVoiceAgentTurns(agent: VoiceAgentTurnClient, deliver: (taskId: string, event: LocalAgentEvent) => void = () => {}, journal?: PendingAgentRequests) {
  const requests = new Map<string, Active>();
  const turns = new Map<string, Active>();
  const key = (sessionId: string, turnId: string) => `${sessionId}\0${turnId}`;
  const publish = (active: Active, event: LocalAgentEvent) => {
    if (!active.ref || event.turnId !== active.ref.turnId || event.sessionId !== active.ref.sessionId) return;
    if (!Number.isSafeInteger(event.sequence) || event.sequence! <= 0 || active.seen.has(event.sequence!)) return;
    active.seen.add(event.sequence!);
    active.sequence = Math.max(active.sequence, event.sequence!);
    deliver(active.taskId, event);
  };
  const cancelActual = async (active: Active) => {
    if (!active.ref || active.cancelSent) return { cancelled: false };
    active.cancelSent = true;
    try { return await agent.cancel(active.ref); }
    catch (error) { active.cancelSent = false; throw error; }
  };
  const replay = async (active: Active) => {
    if (!active.ref) return;
    active.replaying = true;
    let replayed: AgentServiceEvent[] = [];
    try {
      const page = await agent.events({ ...active.ref, afterSequence: active.sequence });
      replayed = page.events;
      if (page.gap) console.warn("[voice] Agent progress history has a gap");
    } catch { console.warn("[voice] Agent progress replay unavailable"); }
    finally {
      const events = [...replayed, ...active.pending].sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
      active.pending = [];
      for (const event of events) publish(active, event as LocalAgentEvent);
      active.replaying = false;
    }
  };
  const normalized = (result: AgentSendResult & { status?: string }): AgentSendResult => {
    if (!result.failure || typeof result.failure.kind === "string") return result;
    const kind = result.status === "cancelled" || result.failure.code === "AGENT_CANCELLED" ? "killed"
      : result.failure.code?.includes("TIMEOUT") ? "timeout" : "engine";
    return { ...result, failure: { ...result.failure, kind } };
  };
  return {
    async send(options: Send): Promise<AgentSendResult> {
      if (!options.sessionId.startsWith("agent2-")) {
        const { recovery: _recovery, remember: _remember, resume: _resume, onAccepted: _onAccepted, ...request } = options;
        return agent.send(request);
      }
      const taskId = options.turnId ?? crypto.randomUUID();
      const requestKey = key(options.sessionId, taskId);
      const journalId = options.recovery?.taskId ?? taskId;
      const active: Active = { taskId, journalId, journal: options.remember || options.recovery ? journal : undefined, cancelled: options.recovery?.cancelled ?? false, cancelSent: false, replaying: true, pending: [], seen: new Set(), sequence: 0 };
      requests.set(requestKey, active);
      let request: import("@reai/app-sdk/v1").AgentTurnStart = { sessionId: options.sessionId, idempotencyKey: taskId, text: options.text,
        ...(options.attachmentInput ? { attachmentInput: structuredClone(options.attachmentInput) } : {}),
        ...(options.taskPresentation ? { taskPresentation: options.taskPresentation } : {}) };
      let accepted = false;
      let admissionAttempted = false;
      let missingReceipt = false;
      const uncertain = (error: unknown) => error instanceof TypeError || (typeof error === "object" && error !== null
        && (("code" in error && typeof error.code === "string" && /(?:BRIDGE|IPC|TRANSPORT).*(?:TIMEOUT|CLOSED|DISCONNECT)/.test(error.code))
          || (!("code" in error) && "retryable" in error && error.retryable === true)));
      try {
        if (!options.resume && options.recovery) {
          if (!active.journal) throw new Error("recovery requires a private admission journal");
          const saved = await active.journal.get(journalId);
          request = saved.request;
          active.cancelled ||= saved.cancelled;
          if (request.sessionId !== options.sessionId) throw Object.assign(new Error("Agent recovery identity mismatch"), { code: "AGENT_RESULT_IDENTITY_MISMATCH" });
        } else if (!options.resume && active.journal) await active.journal.save(journalId, request, active.cancelled);
        let receipt = options.resume;
        if (!receipt) {
          try { admissionAttempted = true; receipt = await agent.startTurn(request); }
          catch (error) {
            // A missing ACK may follow successful admission. Reuse exactly the same key and body.
            if (!uncertain(error)) throw error;
            missingReceipt = true;
            receipt = await agent.startTurn(request);
          }
        }
        if (receipt.sessionId !== options.sessionId || !receipt.turnId) {
          throw Object.assign(new Error("Agent receipt identity mismatch"), { code: "AGENT_RESULT_IDENTITY_MISMATCH", retryable: false });
        }
        accepted = true;
        active.ref = { sessionId: receipt.sessionId, turnId: receipt.turnId };
        turns.set(key(receipt.sessionId, receipt.turnId), active);
        if (active.cancelled) await cancelActual(active);
        // Persist the native identity before forgetting the idempotency key. A
        // new Surface can then observe the original turn without resubmitting it.
        try { await options.onAccepted?.(active.ref); }
        catch (error) {
          if (!active.journal) throw error;
          throw Object.assign(new Error("Agent receipt could not be saved"), {
            code: "AGENT_RECEIPT_UNKNOWN", pendingRequestId: journalId, retryable: true,
          });
        }
        if (active.journal) await active.journal.clear(journalId).catch(() => console.warn("[voice] accepted Agent journal cleanup deferred"));
        await replay(active); // recover events emitted before the receipt arrived
        const result = await agent.waitForTurn(active.ref);
        if (result.turnId !== active.ref.turnId || result.sessionId !== active.ref.sessionId) {
          throw Object.assign(new Error("Agent result identity mismatch"), { code: "AGENT_RESULT_IDENTITY_MISMATCH", retryable: false });
        }
        await replay(active); // recover the last tool end even if its live event was delayed
        return normalized(result);
      } catch (error) {
        if (!accepted && active.journal && admissionAttempted && (missingReceipt || uncertain(error))) {
          if (active.cancelled && active.journal) await active.journal.cancel(journalId).catch(() => undefined);
          throw Object.assign(new Error("Agent receipt unavailable"), {
            code: "AGENT_RECEIPT_UNKNOWN", pendingRequestId: journalId, retryable: true,
          });
        }
        if (!accepted && active.journal && (admissionAttempted || !options.recovery)) await active.journal.clear(journalId).catch(() => undefined);
        throw error;
      } finally {
        requests.delete(requestKey);
        if (active.ref) turns.delete(key(active.ref.sessionId, active.ref.turnId));
      }
    },
    async cancel(options: Parameters<AgentSessionClient["cancel"]>[0]) {
      if (!options.sessionId.startsWith("agent2-")) return agent.cancel(options);
      const active = requests.get(key(options.sessionId, options.turnId)) ?? turns.get(key(options.sessionId, options.turnId));
      if (!active) return { cancelled: false };
      active.cancelled = true;
      if (!active.ref && active.journal) await active.journal.cancel(active.journalId);
      return cancelActual(active);
    },
    onEvent(event: LocalAgentEvent) {
      if (event.schemaVersion !== 2) { if (event.turnId) deliver(event.turnId, event); return; }
      if (!event.turnId || !event.sessionId) return;
      const active = turns.get(key(event.sessionId, event.turnId));
      if (!active) return; // pre-receipt events are recovered from the durable event log
      if (active.replaying) {
        if (active.pending.length < 512) active.pending.push(event);
      } else publish(active, event);
    },
  };
}
