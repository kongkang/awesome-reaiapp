import { expect, test } from "bun:test";
import type { RecoverableVoiceInputSession, SavedInputReceipt, SavedInputRequest, SavedInputSelection } from "@reai/app-sdk/v1";
import { SavedInputRetryController, projectSavedInputSession } from "../src/saved-input-retry";
import type { VoiceHistoryItem } from "../src/data";

const cloud: SavedInputSelection = { engine: "cloud", modelId: "transcribe-free", modelName: "Original cloud", language: "en-US", punctEnabled: true };
const local: SavedInputSelection = { engine: "local", modelId: "sensevoice-small-int8", modelName: "Local original", language: "en-US", punctEnabled: true };
const item = (): VoiceHistoryItem => ({ id: "history", recordingId: "clip", recordingWallStartMs: 1000, transcript: "original", createdAt: new Date(1000).toISOString(), source: "board", language: "zh-CN", inserted: true, durationMs: 1000, stopReason: "user_cancel", transcriptionStatus: "failed", polish: "formal" });
function harness(validateSelection?: (selection: SavedInputSelection) => Promise<void>) {
  let history = [item()];
  let session: RecoverableVoiceInputSession = { recordingId: "clip", sessionId: "s", mode: "input", source: "System", requestedStartMs: 1000, requestedEndMs: 2000, effectiveStartMs: 1000, effectiveEndMs: 2000, stopReason: "user_cancel", transcriptionStatus: "failed", transcript: "original", revision: 0 };
  const calls: SavedInputRequest[] = [];
  let resolve: ((r: SavedInputReceipt) => void) | undefined;
  let failWrite = false;
  const client = {
    getInputSession: async () => structuredClone(session),
    transcribeSavedInput: async (request: SavedInputRequest) => {
      calls.push(structuredClone(request));
      const receipt: SavedInputReceipt = { ...request, state: "pending", revision: request.expectedRevision + 1, startedAtMs: 1000 };
      session = { ...session, revision: receipt.revision, attempt: receipt, transcriptionStatus: "pending" };
      return new Promise<SavedInputReceipt>(r => { resolve = r; });
    },
    cancelSavedInput: async ({ attemptId }: { recordingId: string; attemptId: string }) => {
      if (session.attempt?.attemptId === attemptId) finish("cancelled");
      return { receipt: session.attempt ?? null, upstreamStopped: false as const };
    },
  };
  function finish(state: SavedInputReceipt["state"], errorCode?: string) {
    const receipt = { ...session.attempt!, revision: (session.revision ?? 0) + 1, state, errorCode, ...(state === "complete" ? { transcript: "replacement" } : {}), finishedAtMs: 2000 };
    session = { ...session, revision: receipt.revision, attempt: receipt, transcriptionStatus: state === "complete" ? "complete" : "failed", ...(state === "complete" ? { transcript: "replacement" } : {}) };
    resolve?.(receipt);
  }
  const controller = new SavedInputRetryController({ client, validateSelection, history: () => history,
    update: async (id, change) => { if (failWrite) throw new Error("KV failed"); history = history.map(i => i.id === id ? change(i) : i); return history; }, publish: () => {}, busy: () => {},
  });
  return { controller, client, calls, finish, get history() { return history; }, get session() { return session; }, set failWrite(v: boolean) { failWrite = v; } };
}
async function tick() { for (let i=0;i<8;i++) await Promise.resolve(); }

test("double click starts once, frozen cloud fails to local once, preserves original history metadata", async () => {
  const h = harness(); const plan = { primary: { ...cloud }, fallback: { ...local } };
  const run = h.controller.start("history", "clip", async () => plan);
  const duplicate = h.controller.start("history", "clip", async () => plan);
  await tick(); expect(h.calls).toHaveLength(1);
  plan.primary.modelName = "changed later";
  h.finish("failed", "AI_UNAVAILABLE"); await tick(); expect(h.calls).toHaveLength(2);
  expect(h.calls[0]?.selection.modelName).toBe("Original cloud");
  expect(h.calls[1]?.selection.engine).toBe("local");
  h.finish("complete"); await Promise.all([run, duplicate]);
  expect(h.history[0]?.transcript).toBe("replacement");
  expect(h.history[0]?.stopReason).toBe("user_cancel");
  expect(h.history[0]?.polish).toBe("formal");
  expect(h.history[0]?.inserted).toBe(true);
  expect(h.history[0]?.retryPlan?.primary.modelName).toBe("Original cloud");
  expect(h.history[0]?.savedInput?.selection.modelName).toBe("Local original");
});

test("cancelled and permission failures preserve text and never run fallback", async () => {
  for (const reason of ["VOICE_CANCELLED", "AI_PERMISSION_REQUIRED", "PLUGIN_OAUTH_REAUTH_REQUIRED", "AI_INVALID_REQUEST"]) {
    const h = harness(); const run = h.controller.start("history", "clip", async () => ({ primary: cloud, fallback: local }));
    await tick();
    if (reason === "VOICE_CANCELLED") await h.controller.cancel("clip"); else h.finish("failed", reason);
    await run; expect(h.calls).toHaveLength(1); expect(h.history[0]?.transcript).toBe("original");
  }
});

test("cancel arriving before Host begin rejects silently and does not fall back", async () => {
  let reject!: (cause: unknown) => void;
  let calls = 0;
  let cancelId: string | undefined;
  const history = [item()];
  const session = harness().session;
  const controller = new SavedInputRetryController({
    client: {
      getInputSession: async () => session,
      transcribeSavedInput: async () => { calls++; return new Promise((_resolve, fail) => { reject = fail; }); },
      cancelSavedInput: async request => { cancelId = request.attemptId; return { receipt: null, upstreamStopped: false }; },
    }, history: () => history, update: async () => history, publish: () => {}, busy: () => {},
  });
  const run = controller.start("history", "clip", async () => ({ primary: cloud, fallback: local }));
  await tick();
  await controller.cancel("clip");
  expect(cancelId).toBeDefined();
  reject(Object.assign(new Error("cancelled before begin"), { code: "VOICE_CANCELLED" }));
  await expect(run).resolves.toBeUndefined();
  expect(calls).toBe(1);
  expect(history[0]?.transcript).toBe("original");
});

test("Host success with failed KV save is recoverable without a second ASR", async () => {
  const h = harness(); const run = h.controller.start("history", "clip", async () => ({ primary: local }));
  await tick(); h.failWrite = true; h.finish("complete"); await expect(run).rejects.toThrow("KV failed");
  h.failWrite = false;
  const recovered = projectSavedInputSession(h.history[0]!, h.session);
  expect(recovered.transcript).toBe("replacement"); expect(recovered.savedInput?.state).toBe("complete"); expect(h.calls).toHaveLength(1);
});

test("older revision never replaces a newer attempt or restores a cancelled transcript", () => {
  const h = harness();
  const newer = { ...item(), savedInput: { attemptId: "new", revision: 4, state: "cancelled" as const, selection: local, startedAtMs: 1 } };
  const oldSession = { ...h.session, revision: 2, transcript: "late", attempt: { recordingId: "clip", attemptId: "old", revision: 2, state: "complete" as const, selection: cloud, transcript: "late", startedAtMs: 1 } };
  expect(projectSavedInputSession(newer, oldSession)).toBe(newer);
});

test("clear history rejects a stale Host recovery and a late retry update", async () => {
  const { VoiceStateRepository } = await import("../src/data");
  const values = new Map<string, unknown>();
  const repository = new VoiceStateRepository({
    compareAndSet: async () => { throw new Error("CAS is not expected in this Voice test"); },
    get: async (key: string) => structuredClone(values.get(key)) as never,
    set: async (key: string, value: unknown) => { values.set(key, structuredClone(value)); },
    delete: async (key: string) => { values.delete(key); },
    keys: async () => [...values.keys()],
  });
  await repository.appendHistory(item());
  const before = repository.historyGeneration;
  await repository.clearVoiceRecords();
  await repository.restoreHistoryItem(item(), before);
  await repository.updateHistoryItem("history", item => ({ ...item, transcript: "late" }));
  expect(values.get("history")).toEqual([]);
});

for (const code of ["VOICE_CANCELLED", "app-sdk/VOICE_CANCELLED"]) {
  test(`Host owner cancellation before begin is silent without a local cancel flag: ${code}`, async () => {
    const h = harness();
    let calls = 0;
    h.client.transcribeSavedInput = async () => { calls++; throw { code, userMessage: "cancelled" }; };
    await expect(h.controller.start("history", "clip", async () => ({ primary: cloud, fallback: local }))).resolves.toBeUndefined();
    expect(calls).toBe(1);
    expect(h.history[0]?.transcript).toBe("original");
    expect(h.history[0]?.stopReason).toBe("user_cancel");
  });
}

test("history free-only retry checks support before calling Host and never falls back on refusal", async () => {
  const h = harness(async selection => {
    if (selection.billingPolicy === "free-only") throw new Error("HOST_API_INCOMPATIBLE");
  });
  const run = h.controller.start("history", "clip", async () => ({ primary: { ...cloud, billingPolicy: "free-only" }, fallback: local }));
  await tick();
  expect(h.calls).toHaveLength(0);
  await expect(run).rejects.toThrow("HOST_API_INCOMPATIBLE");
});

test("ordinary account retry freezes model without inventing free-only when subscription expires", async () => {
  const h = harness();
  const plan = { primary: { ...cloud, modelId: "transcribe-account" } };
  const run = h.controller.start("history", "clip", async () => plan);
  await tick(); plan.primary.modelId = "transcribe-newdefault";
  expect(h.calls[0]?.selection).toMatchObject({ modelId: "transcribe-account" });
  expect(h.calls[0]?.selection.billingPolicy).toBeUndefined();
  h.finish("failed", "AI_SUBSCRIPTION_UNAVAILABLE"); await run;
  expect(h.calls).toHaveLength(1);
  expect(h.history[0]?.transcript).toBe("original");
});
test("saved explicit free-only remains constrained when account quote becomes metered", async () => {
  const h = harness(async selection => {
    expect(selection.billingPolicy).toBe("free-only");
    throw new Error("CLOUD_MODEL_SELECTION_REQUIRED");
  });
  const run = h.controller.start("history", "clip", async () => ({ primary: { ...cloud, billingPolicy: "free-only" }, fallback: local }));
  await tick(); await expect(run).rejects.toThrow("CLOUD_MODEL_SELECTION_REQUIRED");
  expect(h.calls).toHaveLength(0);
});
