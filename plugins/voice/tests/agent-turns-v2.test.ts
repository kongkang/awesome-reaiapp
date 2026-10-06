import { expect, test } from "bun:test";
import { createVoiceAgentTurns } from "../src/agent-turns";

const ref = { sessionId: "agent2-session", turnId: "actual-runtime-turn" };
const result = { ...ref, text: "answer", failure: null, runtime: "pi", status: "completed" };
const event = (sequence: number, type: string) => ({ schemaVersion: 2, ...ref, sequence, timestamp: sequence, runtime: "pi", type, callId: "call-1", toolName: "web_search" });
const receipt = { ...ref, schemaVersion: 2, runtime: "pi", status: "running", result: null, expired: false, createdAt: 0, updatedAt: 0 };

test("ACK loss retries one identity; early and live/replayed tool events map to the UI task exactly once", async () => {
  const submitted: unknown[] = [], rendered: unknown[] = [];
  let attempts = 0;
  let turns!: ReturnType<typeof createVoiceAgentTurns>;
  const agent = {
    async startTurn(request: unknown) {
      submitted.push(request);
      if (++attempts === 1) throw Object.assign(new Error("ack lost"), { retryable: true });
      // This event precedes the receipt: it is recovered through replay, not guessed.
      turns.onEvent(event(1, "tool.start") as any);
      return receipt;
    },
    async events() {
      turns.onEvent(event(2, "tool.end") as any);
      return { ...receipt, events: [event(1, "tool.start"), event(2, "tool.end")], gap: false, nextSequence: 2 };
    },
    async waitForTurn(value: unknown) { expect(value).toEqual(ref); return result; },
    async cancel() { return { cancelled: true }; },
    async send() { throw new Error("v2 must not call legacy send"); },
  };
  turns = createVoiceAgentTurns(agent as any, (taskId, value) => rendered.push({ taskId, sequence: value.sequence }));
  const answer = await turns.send({ sessionId: ref.sessionId, turnId: "ui-task", text: "question" });
  expect(submitted).toEqual([
    { sessionId: ref.sessionId, idempotencyKey: "ui-task", text: "question" },
    { sessionId: ref.sessionId, idempotencyKey: "ui-task", text: "question" },
  ]);
  expect(answer.turnId).toBe(ref.turnId);
  expect(rendered).toEqual([{ taskId: "ui-task", sequence: 1 }, { taskId: "ui-task", sequence: 2 }]);
});

test("cancellation before a v2 receipt is forwarded to its actual turn as soon as it arrives", async () => {
  let accept!: (value: unknown) => void;
  const cancelled: unknown[] = [];
  const turns = createVoiceAgentTurns({
    startTurn: () => new Promise(resolve => { accept = resolve; }),
    events: async () => ({ ...receipt, events: [], nextSequence: 0, gap: false }),
    waitForTurn: async () => ({ ...result, status: "cancelled", text: null, failure: { code: "AGENT_CANCELLED" } }),
    cancel: async (value: unknown) => { cancelled.push(value); return { cancelled: true }; },
    send: async () => { throw new Error("legacy path"); },
  } as any);
  const running = turns.send({ sessionId: ref.sessionId, turnId: "ui-task", text: "question" });
  await Promise.resolve();
  await turns.cancel({ sessionId: ref.sessionId, turnId: "ui-task" });
  expect(cancelled).toHaveLength(0);
  accept(receipt);
  const answer = await running;
  expect(cancelled).toEqual([ref]);
  expect(answer.failure?.kind).toBe("killed");
});

test("legacy sessions keep their original IDs and direct send/cancel contract", async () => {
  const calls: unknown[] = [];
  const legacy = { sessionId: "agent-old", turnId: "old-task", text: "old" };
  const turns = createVoiceAgentTurns({
    async send(value: unknown) { calls.push(value); return { turnId: "old-task", text: "ok", failure: null }; },
    async cancel(value: unknown) { calls.push(value); return { cancelled: true }; },
  } as any);
  expect((await turns.send({ ...legacy, remember: true, onAccepted: async () => { throw new Error("legacy has no v2 receipt"); } })).turnId).toBe("old-task");
  await turns.cancel({ sessionId: legacy.sessionId, turnId: legacy.turnId });
  expect(calls).toEqual([legacy, { sessionId: "agent-old", turnId: "old-task" }]);
});

test("budget exhaustion keeps the Host reason without presenting an answer or retrying", async () => {
  let submitted = 0;
  const failure = { code: "AGENT_MODEL_BUDGET_EXCEEDED", message: "这次任务已达到模型调用次数上限，尚未完成。请缩小问题后再试。", retry: "same-session" };
  const turns = createVoiceAgentTurns({
    startTurn: async () => { submitted++; return receipt; },
    events: async () => ({ ...receipt, events: [], nextSequence: 0, gap: false }),
    waitForTurn: async () => ({ ...result, status: "failed", text: null, failure }),
  } as any);
  const answer = await turns.send({ sessionId: ref.sessionId, turnId: "budget-ui", text: "question" });
  expect(answer.text).toBeNull();
  expect(answer.failure).toEqual({ ...failure, kind: "engine" });
  expect(submitted).toBe(1);
});

test("a receipt for another session is rejected before querying or cancelling it", async () => {
  let reads = 0;
  const turns = createVoiceAgentTurns({
    startTurn: async () => ({ ...receipt, sessionId: "agent2-other" }),
    events: async () => { reads++; return { ...receipt, events: [], gap: false, nextSequence: 0 }; },
    waitForTurn: async () => { reads++; return result; },
    cancel: async () => { throw new Error("wrong session must not be cancelled"); },
  } as any);
  await expect(turns.send({ sessionId: ref.sessionId, turnId: "ui-task", text: "question" }))
    .rejects.toMatchObject({ code: "AGENT_RESULT_IDENTITY_MISMATCH" });
  expect(reads).toBe(0);
});

test("a result for another turn cannot be attached to the current conversation", async () => {
  const turns = createVoiceAgentTurns({
    startTurn: async () => receipt,
    events: async () => ({ ...receipt, events: [], gap: false, nextSequence: 0 }),
    waitForTurn: async () => ({ ...result, turnId: "other-turn" }),
  } as any);
  await expect(turns.send({ sessionId: ref.sessionId, turnId: "ui-task", text: "question" }))
    .rejects.toMatchObject({ code: "AGENT_RESULT_IDENTITY_MISMATCH" });
});

test("both ACKs lost retain the original request and an explicit recovery never allocates another key", async () => {
  const stored = new Map<string, any>(); const submitted: any[] = []; let lose = true;
  const journal = {
    async save(id: string, request: any, cancelled: boolean) { stored.set(id, { taskId: id, request, epoch: "account-a", createdAt: 1, cancelled }); },
    async get(id: string) { return stored.get(id); },
    async clear(id: string) { stored.delete(id); },
    async cancel(id: string) { stored.get(id).cancelled = true; },
  };
  const turns = createVoiceAgentTurns({
    async startTurn(request: unknown) { submitted.push(request); if (lose) throw new TypeError("transport gone"); return receipt; },
    events: async () => ({ ...receipt, events: [], nextSequence: 0, gap: false }),
    waitForTurn: async () => result,
  } as any, undefined, journal as any);
  await expect(turns.send({ sessionId: ref.sessionId, turnId: "original-ui", text: "exact request", remember: true }))
    .rejects.toMatchObject({ code: "AGENT_RECEIPT_UNKNOWN", pendingRequestId: "original-ui" });
  expect(stored.get("original-ui").request.idempotencyKey).toBe("original-ui");
  lose = false;
  const recovered = await turns.send({ sessionId: ref.sessionId, turnId: "recovery-ui", text: "must not replace original", recovery: stored.get("original-ui") } as any);
  expect(recovered.turnId).toBe(ref.turnId);
  expect(submitted).toHaveLength(3);
  expect(submitted[2]).toEqual(submitted[0]);
  expect(stored.size).toBe(0);
});


test("a definitive pre-admission rejection clears intent and never exposes a retryable unknown receipt", async () => {
  const stored = new Map<string, any>(); let calls = 0;
  const journal = {
    async save(id: string, request: any) { stored.set(id, { taskId: id, request }); },
    async clear(id: string) { stored.delete(id); },
  };
  const turns = createVoiceAgentTurns({
    async startTurn() { calls++; throw { code: "AGENT_PERMISSION_DENIED", retryable: false }; },
  } as any, undefined, journal as any);
  await expect(turns.send({ sessionId: ref.sessionId, turnId: "denied", text: "question", remember: true }))
    .rejects.toMatchObject({ code: "AGENT_PERMISSION_DENIED" });
  expect(calls).toBe(1); expect(stored.size).toBe(0);
});

test("cancellation survives both lost receipts and recovery cancels the original actual turn", async () => {
  const stored = new Map<string, any>(); let lose = true; let started!: () => void;
  const began = new Promise<void>(resolve => { started = resolve; });
  let reject!: () => void; const cancelled: unknown[] = [];
  const journal = {
    async save(id: string, request: any, cancelled: boolean) { stored.set(id, { taskId: id, request, cancelled }); },
    async get(id: string) { return stored.get(id); }, async clear(id: string) { stored.delete(id); },
    async cancel(id: string) { stored.get(id).cancelled = true; },
  };
  const turns = createVoiceAgentTurns({
    async startTurn() {
      if (!lose) return receipt;
      if (!reject) { started(); await new Promise<void>((_, fail) => { reject = () => fail(new TypeError("missing receipt")); }); }
      throw new TypeError("missing receipt");
    },
    cancel: async (value: unknown) => { cancelled.push(value); return { cancelled: true }; },
    events: async () => ({ ...receipt, events: [], nextSequence: 0, gap: false }),
    waitForTurn: async () => ({ ...result, text: null, status: "cancelled", failure: { code: "AGENT_CANCELLED" } }),
  } as any, undefined, journal as any);
  const running = turns.send({ sessionId: ref.sessionId, turnId: "original", text: "question", remember: true });
  await began; await turns.cancel({ sessionId: ref.sessionId, turnId: "original" }); reject();
  await expect(running).rejects.toMatchObject({ code: "AGENT_RECEIPT_UNKNOWN" });
  expect(stored.get("original").cancelled).toBe(true); lose = false;
  await turns.send({ sessionId: ref.sessionId, turnId: "recover-ui", text: "ignored", recovery: stored.get("original") });
  expect(cancelled).toEqual([ref]); expect(stored.size).toBe(0);
});

test("a temporary ownership lookup failure during recovery preserves the original request without submitting", async () => {
  let submits = 0, clears = 0;
  const pending = { taskId: "original", request: { sessionId: ref.sessionId, idempotencyKey: "original", text: "question" }, cancelled: false };
  const turns = createVoiceAgentTurns({ startTurn: async () => { submits++; return receipt; } } as any, undefined, {
    get: async () => { throw new TypeError("list temporarily unavailable"); }, clear: async () => { clears++; },
  } as any);
  await expect(turns.send({ sessionId: ref.sessionId, turnId: "recover-ui", text: "ignored", recovery: pending } as any)).rejects.toThrow("list temporarily unavailable");
  expect(submits).toBe(0); expect(clears).toBe(0);
});


test("native receipt is saved before intent is forgotten; a storage failure preserves the same-key recovery", async () => {
  const stored = new Map<string, any>();
  const journal = {
    async save(id: string, request: any) { stored.set(id, { taskId: id, request }); },
    async clear(id: string) { stored.delete(id); },
  };
  let waits = 0;
  const turns = createVoiceAgentTurns({
    startTurn: async () => receipt,
    waitForTurn: async () => { waits++; return result; },
  } as any, undefined, journal as any);
  await expect(turns.send({ sessionId: ref.sessionId, turnId: "task", text: "question", remember: true,
    onAccepted: async actual => { expect(actual).toEqual(ref); expect(stored.has("task")).toBeTrue(); throw new Error("storage unavailable"); },
  })).rejects.toMatchObject({ code: "AGENT_RECEIPT_UNKNOWN", pendingRequestId: "task" });
  expect(stored.get("task").request.idempotencyKey).toBe("task");
  expect(waits).toBe(0);
});

test("typed attachment ACK retries preserve exact admission and lease identity; resume never starts work",async()=>{
 const attachmentInput={schemaVersion:1 as const,admission:{schemaVersion:1 as const,opaqueBinding:'a'.repeat(64),revision:3,modes:['image' as const]},parts:[{kind:'image' as const,name:'synthetic.png',mimeType:'image/png' as const,leaseId:'b'.repeat(64),sha256:'c'.repeat(64),byteLength:200}]};
 const submitted:any[]=[];let attempts=0;
 const turns=createVoiceAgentTurns({startTurn:async(request:any)=>{submitted.push(structuredClone(request));if(++attempts===1)throw new TypeError('lost ACK');return receipt;},events:async()=>({...receipt,events:[],gap:false,nextSequence:0}),waitForTurn:async()=>result} as any);
 await turns.send({sessionId:ref.sessionId,turnId:'original',text:'image question',attachmentInput});
 expect(submitted).toHaveLength(2);expect(submitted[0]).toEqual(submitted[1]);expect(submitted[0].attachmentInput).toEqual(attachmentInput);
 await turns.send({sessionId:ref.sessionId,turnId:'resume',text:'ignored',resume:ref});expect(submitted).toHaveLength(2);
});
