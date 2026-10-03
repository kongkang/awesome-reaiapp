/** Local task authority. All writes use the Host's durable CAS, including receipts. */
import type { KeyValueStore } from "@reai/app-sdk/v1";
import { admitPlanned, newBoard, project, registerOrchestrator, RuleError, setLimits, transition, validateLimits, type Board, type Child, type Envelope, type Limits, type PlannedDemand } from "./domain";

const STATE = "state", RETRY_MS = 86_400_000, MAX_RECEIPTS = 128, STATE_BYTES = 220 * 1024;
const enc = new TextEncoder();
function live(signal?: AbortSignal) { if (signal?.aborted) throw new Error("Call cancelled; reconcile the original request before retrying"); }
const evidenceRef = /^archive:(C-[0-9]+):([a-f0-9]{64})$/;

function error(code: RuleError["code"], message: string): never { throw new RuleError(code, message); }
const object = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
const str = (x: unknown): x is string => typeof x === "string" && x.trim().length > 0;
const sha = (x: unknown): x is string => typeof x === "string" && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(x);
export async function digest(value: string) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(value)))].map(x => x.toString(16).padStart(2, "0")).join("");
}
function canonical(x: unknown): string {
  if (Array.isArray(x)) return `[${x.map(canonical).join(",")}]`;
  if (object(x)) return `{${Object.keys(x).sort().map(k => `${JSON.stringify(k)}:${canonical(x[k])}`).join(",")}}`;
  return JSON.stringify(x);
}
function validateStored(x: unknown): asserts x is Board {
  if (!object(x) || x.schema !== "code-worker.rules.v1" || !Number.isSafeInteger(x.revision) || (x.revision as number) < 0 || !Number.isSafeInteger(x.serial) || (x.serial as number) < 0 ||
      !Array.isArray(x.tasks) || !Array.isArray(x.children) || !Array.isArray(x.agents) || !Array.isArray(x.receipts)) error("SCHEMA", "Stored task data is invalid; it was not reset");
  try { validateLimits(x.limits); } catch { error("SCHEMA", "Stored limits are invalid"); }
  const tasks = x.tasks as Board["tasks"], children = x.children as Board["children"], agents = x.agents as Board["agents"];
  for (const list of [tasks, children, agents]) if (list.some(v => !object(v) || !str(v.id)) || new Set(list.map(v => v.id)).size !== list.length) error("SCHEMA", "Stored record identities are invalid");
  if (tasks.some(t => !str(t.sourceId) || !str(t.title) || !str(t.goal) || !["open", "done"].includes(t.status) || typeof t.planClosed !== "boolean" || t.owner !== null && !agents.some(a => a.id === t.owner && a.role === "orchestrator")) ||
      children.some(c => !tasks.some(t => t.id === c.taskId) || !str(c.title) || !str(c.acceptance) || !Number.isSafeInteger(c.attempt) || !["queued", "working", "awaiting_test", "testing", "passed", "merged", "rework"].includes(c.status) || !Array.isArray(c.history)) ||
      agents.some(a => !["orchestrator", "worker", "tester"].includes(a.role) || !["idle", "waiting", "running"].includes(a.state)) ||
      x.receipts.some(r => !object(r) || !str(r.actorId) || !str(r.requestId) || !str(r.fingerprint) || !Number.isSafeInteger(r.revision))) error("SCHEMA", "Stored task relationships are invalid");
  const nullableText = (v: unknown) => v === null || str(v);
  const attemptValid = (c: Board["children"][number] | Board["children"][number]["history"][number], taskId: string, childId: string) =>
    Number.isSafeInteger(c.attempt) && c.attempt >= 0 && [null, "pass", "fail"].includes(c.verdict) &&
    nullableText(c.result) && nullableText(c.evidence) &&
    ([ ["worker", c.worker], ["tester", c.tester] ] as const).every(([role, id]) => id === null || agents.some(a => a.id === id && a.role === role && a.taskId === taskId && a.childId === childId));
  if (new Set(tasks.map(t => t.sourceId)).size !== tasks.length ||
      tasks.some(t => t.withdrawn !== undefined && typeof t.withdrawn !== "boolean" || t.archived !== undefined && (!object(t.archived) || !/^[a-f0-9]{64}$/.test(t.archived.digest) || !Number.isSafeInteger(t.archived.children) || t.status !== "done" || children.some(c => c.taskId === t.id))) ||
      children.some(c => !nullableText(c.mergeRef) || !attemptValid(c, c.taskId, c.id) || c.history.some(h => !object(h) || !attemptValid(h, c.taskId, c.id))) ||
      agents.some(a => !nullableText(a.taskId) || !nullableText(a.childId) || (a.role !== "orchestrator" && !children.some(c => c.id === a.childId && c.taskId === a.taskId)) || (a.role === "orchestrator" && (a.childId !== null || a.taskId !== null && !tasks.some(t => t.id === a.taskId && t.owner === a.id)))) ||
      x.receipts.some(r => r.at !== undefined && (!Number.isSafeInteger(r.at) || r.at < 0))) error("SCHEMA", "Stored execution references are invalid");
}
function report(value: unknown, fields: string[]) {
  if (typeof value !== "string" || enc.encode(value).length > 4096) error("SCHEMA", "A structured Agent report of at most 4096 bytes is required");
  let data: unknown; try { data = JSON.parse(value); } catch { error("SCHEMA", "A structured Agent report is required"); }
  if (!object(data) || Object.keys(data).length !== fields.length || fields.some(k => !str(data[k]) || enc.encode(data[k] as string).length > 2048)) error("SCHEMA", "Invalid Agent report fields");
  if (typeof data.verification === "string" && data.verification.startsWith("archive:")) error("SCHEMA", "Agent reports cannot supply internal archive references");
  return data as Record<string, string>;
}
function validateReport(board: Board, action: Envelope) {
  const p = action.payload;
  if (!object(p)) return;
  if (action.operation === "work") {
    const r = report(p.result, ["summary", "repository", "branch", "commit", "verification"]);
    if (!sha(r.commit)) error("SCHEMA", "Worker report requires a commit SHA");
  }
  if (action.operation === "test" || action.operation === "merge") {
    const c = board.children.find(c => c.id === p.childId);
    // Ownership and state errors are decided by the pure transition, not evidence lookup.
    if (!c?.result) return;
    const work = JSON.parse(c.result) as Record<string, string>;
    if (action.operation === "test") {
      const r = report(p.evidence, ["testedCommit", "verification"]);
      if (!sha(r.testedCommit) || r.testedCommit !== work.commit) error("SCHEMA", "Tester commit must match the Worker commit");
    } else {
      const r = report(p.mergeRef, ["repository", "target", "sourceCommit", "mergedCommit", "verification"]);
      if (!sha(r.mergedCommit) || r.sourceCommit !== work.commit || r.repository !== work.repository) error("SCHEMA", "Merge report must match the tested repository and commit");
    }
  }
}
export function createAuthority(store: KeyValueStore, planned: () => Promise<{ demands: PlannedDemand[] }>, defaults?: Limits) {
  async function load(): Promise<Board> {
    const raw = await store.get(STATE);
    if (raw !== undefined) { validateStored(raw); return raw; }
    const initial = newBoard(defaults);
    if (await store.compareAndSet(STATE, undefined, initial)) return initial;
    const raced = await store.get(STATE); validateStored(raced); return raced;
  }
  async function commit(previous: Board, next: Board, signal?: AbortSignal) {
    live(signal);
    const now = Date.now();
    next.receipts = next.receipts.filter(r => r.at !== undefined && now - r.at <= RETRY_MS).slice(-MAX_RECEIPTS);
    // Preserve full evidence in immutable content-addressed records; active state keeps concise reports.
    for (const child of next.children) {
      for (const attempt of [...child.history, child]) {
        for (const key of ["result", "evidence"] as const) {
          const raw = attempt[key]; if (!raw) continue;
          let data: Record<string, unknown>; try { data = JSON.parse(raw); } catch { continue; }
          if (typeof data.verification !== "string" || data.verification.startsWith("archive:")) continue;
          const ref = await digest(raw); live(signal); await store.set(`evidence/${child.id}/${ref}`, raw);
          attempt[key] = JSON.stringify({ ...data, verification: `archive:${child.id}:${ref}` });
        }
      }
    }
    if (enc.encode(JSON.stringify(next)).length > STATE_BYTES) error("STORAGE_PRESSURE", "Task storage is full; export and archive completed tasks before continuing");
    live(signal);
    if (!await store.compareAndSet(STATE, previous, next)) error("CONFLICT", "State changed; read the current revision and retry");
    return next;
  }
  async function read(signal?: AbortSignal): Promise<Board> {
    live(signal); const feed = await planned(); live(signal);
    if (!object(feed) || !Array.isArray(feed.demands)) error("SCHEMA", "Planned feed contains invalid data");
    for (let n = 0; n < 8; n++) {
      const old = await load(); live(signal);
      if (feed.demands.some(d => !object(d) || !str(d.id) || !str(d.title) || !str(d.body) || d.status !== "planned") || new Set(feed.demands.map(d => d.id)).size !== feed.demands.length) error("SCHEMA", "Invalid planned demand snapshot");
      const next = admitPlanned(old, feed.demands);
      if (next.revision === old.revision) return old;
      try { return await commit(old, next, signal); } catch (e) { if (!(e instanceof RuleError) || e.code !== "CONFLICT" || n === 7) throw e; }
    }
    return error("CONFLICT", "Task intake is busy");
  }
  async function replace(transform: (old: Board) => Board) {
    for (let n = 0; n < 8; n++) {
      const old = await read(), next = transform(old);
      try { return await commit(old, next); } catch (e) { if (!(e instanceof RuleError) || e.code !== "CONFLICT" || n === 7) throw e; }
    }
    return error("CONFLICT", "Task store is busy");
  }
  async function expand(child: Child) {
    const result = structuredClone(child);
    for (const attempt of [...result.history, result]) for (const key of ["result", "evidence"] as const) {
      const raw = attempt[key]; if (!raw) continue;
      let data: { verification?: string }; try { data = JSON.parse(raw); } catch { continue; }
      if (typeof data.verification === "string" && data.verification.startsWith("archive:")) {
        const ref = evidenceRef.exec(data.verification);
        if (!ref || ref[1] !== child.id) error("SCHEMA", "Invalid evidence reference");
        const text = await store.get<string>(`evidence/${ref[1]}/${ref[2]}`);
        if (!text || await digest(text) !== ref[2]) error("SCHEMA", "Stored evidence is missing or corrupted");
        attempt[key] = text;
      }
    }
    return result;
  }
  async function exportTask(state: Board, taskId: string) {
    const task = state.tasks.find(t => t.id === taskId);
    if (!task || task.status !== "done" || task.archived) error("STATE", "Only unarchived completed tasks may be exported and cleaned");
    const children = await Promise.all(state.children.filter(c => c.taskId === taskId).map(expand));
    const archive = { schema: "code-worker.export.v1", evidenceSource: "agent-report", task, children,
      agents: state.agents.filter(a => a.taskId === taskId || a.id === task.owner) };
    const text = JSON.stringify(archive, null, 2);
    return { text, digest: await digest(text), revision: state.revision };
  }
  return {
    read,
    async exportTask(taskId: string) { return exportTask(await read(), taskId); },
    async archiveTask(taskId: string, expectedRevision: number, expectedDigest: string) {
      const old = await read();
      if (old.revision !== expectedRevision) error("CONFLICT", "State changed; export a fresh backup before cleanup");
      const exported = await exportTask(old, taskId);
      if (exported.digest !== expectedDigest) error("CONFLICT", "Backup does not match the completed task");
      const next = structuredClone(old), children = next.children.filter(c => c.taskId === taskId);
      const removed = new Set(next.agents.filter(a => a.taskId === taskId && a.role !== "orchestrator").map(a => a.id));
      next.children = next.children.filter(c => c.taskId !== taskId);
      next.agents = next.agents.filter(a => !removed.has(a.id));
      for (const agent of next.agents) if (agent.taskId === taskId) { agent.taskId = null; agent.childId = null; }
      next.receipts = next.receipts.filter(r => !removed.has(r.actorId));
      next.tasks.find(t => t.id === taskId)!.archived = { digest: expectedDigest, children: children.length };
      next.revision++;
      await commit(old, next);
      // Keys are unique to monotonic child IDs. No other task can reference them.
      // Cleanup is best effort AFTER the durable tombstone; a failed delete never loses active work.
      const prefixes = children.map(c => `evidence/${c.id}/`);
      let cleanupPending = false;
      try { for (const key of await store.keys()) if (prefixes.some(p => key.startsWith(p))) await store.delete(key); }
      catch { cleanupPending = true; }
      return { board: next, cleanupPending };
    },
    async snapshot(actor: string) { return project(await read(), actor); },
    async register(id: string) { return replace(old => registerOrchestrator(old, id)); },
    async limits(limits: Limits) { return replace(old => setLimits(old, limits)); },
    async detail(childId: string, actor?: string) {
      const state = await read();
      if (actor && !project(state, actor).children.some(c => c.id === childId)) error("FORBIDDEN", "Child is outside the Agent scope");
      const child = state.children.find(c => c.id === childId); if (!child) error("NOT_FOUND", "Child not found");
      return expand(child);
    },
    async act(actor: string, input: unknown, signal?: AbortSignal) {
      live(signal);
      if (!object(input)) error("SCHEMA", "Action envelope is required");
      const action = input as unknown as Envelope, old = await read(signal);
      const fingerprint = await digest(canonical([action.operation, action.expectedRevision, action.payload]));
      live(signal);
      const next = transition(old, actor, action, { fingerprint, at: Date.now() });
      // Check authorization before returning evidence errors, to avoid cross-scope information leaks.
      if (next.revision === old.revision) return { board: old, receipt: old.receipts.find(r => r.actorId === actor && r.requestId === action.requestId) };
      validateReport(old, action);
      const board = await commit(old, next, signal);
      return { board, receipt: board.receipts.find(r => r.actorId === actor && r.requestId === action.requestId) };
    },
  };
}
export type Authority = ReturnType<typeof createAuthority>;
