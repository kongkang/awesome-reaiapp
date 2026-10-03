import { expect, test } from "bun:test";
import { createAuthority } from "../src/authority";
import type { KeyValueStore } from "@reai/app-sdk/v1";

function harness() {
  const data = new Map<string, unknown>(); let fail = false;
  const store: KeyValueStore = {
    async get<T>(key: string) { return structuredClone(data.get(key)) as T | undefined; },
    async set(key, value) { if (fail) throw Error("disk"); data.set(key, structuredClone(value)); },
    async compareAndSet(key, expected, value) {
      if (fail) throw Error("disk");
      if (JSON.stringify(data.get(key)) !== JSON.stringify(expected)) return false;
      data.set(key, structuredClone(value)); return true;
    },
    async delete(key) { data.delete(key); }, async keys() { return [...data.keys()]; },
  };
  let demands = ["A", "B"].map(id => ({ id, title: id, body: `Goal ${id}`, status: "planned" }));
  return { store, data, get demands() { return demands; }, set demands(value) { demands = value; }, fail(value: boolean) { fail = value; },
    create() { return createAuthority(store, async () => ({ demands })); } };
}

test("two authority instances persist only one concurrent lock and recover it", async () => {
  const h = harness(), a = h.create(), b = h.create();
  await a.register("O-A"); await b.register("O-B");
  const state = await a.read(); const taskId = state.tasks[0].id;
  const action = { requestId: "claim", expectedRevision: state.revision, operation: "claim", payload: { taskId } };
  const results = await Promise.allSettled([a.act("O-A", action), b.act("O-B", action)]);
  expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
  const recovered = await h.create().read(); expect(recovered.tasks[0].owner).not.toBeNull();
  const other = recovered.tasks[0].owner === "O-A" ? "O-B" : "O-A";
  expect((await a.snapshot(other)).tasks).toHaveLength(0);
});

test("withdrawn demands cannot be claimed; corrupt and failed writes never reset tasks", async () => {
  const h = harness(), a = h.create(); await a.register("O-A");
  const old = await a.read(); h.demands = [];
  const withdrawn = await a.read(); expect(withdrawn.tasks[0].withdrawn).toBe(true);
  await expect(a.act("O-A", { requestId: "claim", expectedRevision: withdrawn.revision, operation: "claim", payload: { taskId: old.tasks[0].id } })).rejects.toThrow();
  h.fail(true); await expect(a.register("O-B")).rejects.toThrow("disk"); h.fail(false);
  expect((await a.read()).agents).toHaveLength(1);
  h.data.set("state", { schema: "broken" }); await expect(h.create().read()).rejects.toThrow(/Stored/);
  expect(h.data.get("state")).toEqual({ schema: "broken" });
});

test("real begin takes quota; worker completion frees it before tester; reports bind tested commit", async () => {
  const h = harness(), a = h.create(); await a.register("O-A");
  let n = 0;
  async function op(actor: string, operation: string, payload: object) { return a.act(actor, { requestId: `${++n}`, expectedRevision: (await a.read()).revision, operation, payload }); }
  const taskId = (await a.read()).tasks[0].id;
  await op("O-A", "claim", { taskId }); await op("O-A", "addChild", { taskId, title: "Code", acceptance: "Tests pass" });
  const childId = (await a.read()).children[0].id;
  await op("O-A", "startWorker", { childId });
  let state = await a.read(); const worker = state.children[0].worker!;
  expect(state.agents.find(x => x.id === worker)?.state).toBe("waiting");
  await op(worker, "begin", { childId });
  const commit = "a".repeat(40);
  await expect(op(worker, "work", { childId, result: "fake" })).rejects.toThrow(/report/);
  await op(worker, "work", { childId, result: JSON.stringify({ summary: "Done", repository: "fixture", branch: "work", commit, verification: "bun test: 1 pass" }) });
  state = await a.read(); expect(state.agents.filter(x => x.role === "worker" && x.state === "running")).toHaveLength(0);
  await op("O-A", "startTester", { childId });
  const tester = (await a.read()).children[0].tester!; expect(tester).not.toBe(worker);
  await op(tester, "begin", { childId });
  await expect(op(tester, "test", { childId, verdict: "pass", evidence: JSON.stringify({ testedCommit: "b".repeat(40), verification: "pass" }) })).rejects.toThrow(/commit/);
  await op(tester, "test", { childId, verdict: "pass", evidence: JSON.stringify({ testedCommit: commit, verification: "bun test: 1 pass" }) });
  await op("O-A", "merge", { childId, mergeRef: JSON.stringify({ repository: "fixture", target: "main", sourceCommit: commit, mergedCommit: "c".repeat(40), verification: "git merge-base --is-ancestor: exit 0" }) });
  await op("O-A", "closePlan", { taskId });
  expect((await a.read()).tasks[0].status).toBe("done");
});

test("30 children and 244 writes stay bounded, export original evidence, and never re-admit cleaned sources", async () => {
  const h = harness(), a = h.create(); await a.register("O");
  let serial = 0;
  const op = async (actor: string, operation: string, payload: object) => a.act(actor, { requestId: `${++serial}`, expectedRevision: (await a.read()).revision, operation, payload });
  const taskId = (await a.read()).tasks[0].id;
  await op("O", "claim", { taskId });
  await expect(a.exportTask(taskId)).rejects.toThrow(/completed/);
  const commit = "a".repeat(40), verification = "x".repeat(2048);
  for (let n = 0; n < 30; n++) {
    await op("O", "addChild", { taskId, title: `Child ${n}`, acceptance: "Independent test" });
    const childId = (await a.read()).children.at(-1)!.id;
    const assigned = await op("O", "startWorker", { childId }), worker = assigned.receipt!.agentId!;
    await op(worker, "begin", { childId });
    await op(worker, "work", { childId, result: JSON.stringify({ summary: "Done", repository: "fixture", branch: "work", commit, verification }) });
    const tester = (await op("O", "startTester", { childId })).receipt!.agentId!;
    await op(tester, "begin", { childId });
    await op(tester, "test", { childId, verdict: "pass", evidence: JSON.stringify({ testedCommit: commit, verification }) });
    await op("O", "merge", { childId, mergeRef: JSON.stringify({ repository: "fixture", target: "main", sourceCommit: commit, mergedCommit: commit, verification: "Verified" }) });
  }
  await op("O", "closePlan", { taskId });
  const state = await a.read();
  expect(state.receipts).toHaveLength(128);
  expect(new TextEncoder().encode(JSON.stringify(state)).length).toBeLessThan(220 * 1024);
  const backup = await a.exportTask(taskId);
  expect(JSON.parse(backup.text).children[0].result).toContain(verification);
  expect([...h.data.keys()].filter(k => k.startsWith("evidence/"))).toHaveLength(60);
  await expect(a.archiveTask(taskId, backup.revision, "wrong")).rejects.toThrow(/match/);
  expect((await a.read()).children).toHaveLength(30);
  await a.archiveTask(taskId, backup.revision, backup.digest);
  expect((await h.create().read()).children).toHaveLength(0);
  expect((await a.read()).tasks.filter(t => t.sourceId === "A")).toHaveLength(1);
  expect((await a.read()).tasks[0].archived?.digest).toBe(backup.digest);
  expect([...h.data.keys()].filter(k => k.startsWith("evidence/"))).toHaveLength(0);
});

test("cancel fences stale actors, replay preserves original allocation, and aborted calls never write", async () => {
  const h = harness(), a = h.create(); await a.register("O");
  let serial = 0;
  const op = async (actor: string, operation: string, payload: object) => a.act(actor, { requestId: `${++serial}`, expectedRevision: (await a.read()).revision, operation, payload });
  const taskId = (await a.read()).tasks[0].id;
  await op("O", "claim", { taskId }); await op("O", "addChild", { taskId, title: "X", acceptance: "Y" });
  const childId = (await a.read()).children[0].id;
  const action = { requestId: "assign", expectedRevision: (await a.read()).revision, operation: "startWorker", payload: { childId } };
  const first = await a.act("O", action); const worker = first.receipt!.agentId!;
  expect((await a.act("O", action)).receipt).toEqual(first.receipt);
  await op(worker, "begin", { childId }); await op(worker, "cancel", { childId, reason: "Process confirmed stopped" });
  expect((await a.read()).agents.find(a => a.id === worker)?.state).toBe("idle");
  await op("O", "startWorker", { childId });
  expect((await a.act("O", action)).receipt?.agentId).toBe(worker);
  await expect(op(worker, "work", { childId, result: "late" })).rejects.toThrow(/assigned/);
  const before = await a.read(), controller = new AbortController(); controller.abort();
  await expect(a.act("O", { requestId: "aborted", expectedRevision: before.revision, operation: "addChild", payload: { taskId, title: "No", acceptance: "No" } }, controller.signal)).rejects.toThrow(/cancelled/);
  expect(await a.read()).toEqual(before);
});
