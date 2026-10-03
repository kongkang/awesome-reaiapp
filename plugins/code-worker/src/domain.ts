/**
 * Plugin-owned task rules, independent of DOM, HTTP and Agent launchers.
 * Authentication, CAS and report validation belong to authority.ts and the Host
 * gateway. Actor IDs are resolved from Host-issued credentials, never HTTP input.
 * Assigning an Agent does not consume an execution slot; begin does.
 */
export const ROLES = ["orchestrator", "worker", "tester"] as const;
export type Role = typeof ROLES[number];
export type Limits = Record<Role, number>;
export type ChildStatus = "queued" | "working" | "awaiting_test" | "testing" | "passed" | "merged" | "rework";
export type RootStage = "queued" | "planning" | "running" | "merging" | "done";
export interface Agent {
  id: string; role: Role; state: "idle" | "running" | "waiting"; taskId: string | null; childId: string | null;
}
export interface Task {
  id: string; sourceId: string; title: string; goal: string; owner: string | null;
  status: "open" | "done"; planClosed: boolean; withdrawn?: boolean; archived?: { digest: string; children: number };
}
export interface Attempt {
  attempt: number; worker: string | null; tester: string | null;
  result: string | null; verdict: "pass" | "fail" | null; evidence: string | null;
}
export interface Child extends Attempt {
  id: string; taskId: string; title: string; acceptance: string; status: ChildStatus;
  mergeRef: string | null; history: Attempt[];
}
export interface Board {
  schema: "code-worker.rules.v1"; revision: number; serial: number;
  limits: Limits; tasks: Task[]; children: Child[]; agents: Agent[];
  // Authority persists these with the state and applies a bounded retry window.
  receipts: { actorId: string; requestId: string; fingerprint: string; revision: number; at?: number; agentId?: string }[];
}
export interface PlannedDemand { id: string; title: string; body: string; status: string; archived?: boolean; trashed?: boolean }
export const DEFAULT_LIMITS: Limits = { orchestrator: 3, worker: 10, tester: 6 };
export const OP_FIELDS = {
  claim: ["taskId"], addChild: ["taskId", "title", "acceptance"], closePlan: ["taskId"],
  begin: ["childId"], cancel: ["childId", "reason"],
  startWorker: ["childId"], startTester: ["childId"], work: ["childId", "result"],
  test: ["childId", "verdict", "evidence"], merge: ["childId", "mergeRef"],
} as const;
export type Operation = keyof typeof OP_FIELDS;
export interface Envelope { requestId: string; expectedRevision: number; operation: Operation; payload: Record<string, unknown> }
export class RuleError extends Error {
  constructor(readonly code: "SCHEMA" | "CONFLICT" | "FORBIDDEN" | "NOT_FOUND" | "STATE" | "QUOTA" | "STORAGE_PRESSURE", message: string) {
    super(message); this.name = "RuleError";
  }
}
const fail = (code: RuleError["code"], message: string): never => { throw new RuleError(code, message); };
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= 8_000;
const clone = <T>(value: T): T => structuredClone(value);
const find = <T extends { id: string }>(items: T[], id: unknown): T =>
  items.find(item => item.id === id) ?? fail("NOT_FOUND", "Record not found");
export function newBoard(limits = DEFAULT_LIMITS): Board {
  validateLimits(limits);
  return { schema: "code-worker.rules.v1", revision: 0, serial: 0, limits: { ...limits }, tasks: [], children: [], agents: [], receipts: [] };
}
export function validateLimits(value: unknown): asserts value is Limits {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("SCHEMA", "Invalid limits");
  const fields = value as Record<string, unknown>;
  if (Object.keys(fields).length !== 3 || ROLES.some(role => !Object.hasOwn(fields, role) || !Number.isSafeInteger(fields[role]) || (fields[role] as number) < 0))
    fail("SCHEMA", "Limits must be non-negative safe integers");
}
export function quota(board: Board) {
  return Object.fromEntries(ROLES.map(role => {
    const running = board.agents.filter(a => a.role === role && a.state === "running").length;
    return [role, { running, limit: board.limits[role], available: board.limits[role] - running }];
  })) as Record<Role, { running: number; limit: number; available: number }>;
}
export function stage(board: Board, task: Task): RootStage {
  if (task.status === "done") return "done";
  if (!task.owner) return "queued";
  const children = board.children.filter(c => c.taskId === task.id);
  if (!children.length) return "planning";
  return children.every(c => ["passed", "merged"].includes(c.status)) ? "merging" : "running";
}
/** Only the trusted planned-feedback intake may invoke this; never take a browser import as authority. */
export function admitPlanned(previous: Board, demands: PlannedDemand[]): Board {
  const next = clone(previous);
  for (const task of next.tasks) {
    const planned = demands.some(d => d.id === task.sourceId && d.status === "planned" && !d.archived && !d.trashed);
    if (task.withdrawn !== !planned) task.withdrawn = !planned;
  }
  for (const demand of demands) {
    if (demand.status !== "planned" || demand.archived || demand.trashed || next.tasks.some(t => t.sourceId === demand.id)) continue;
    if (!text(demand.id) || !text(demand.title) || !text(demand.body)) fail("SCHEMA", "Planned demand requires source, title and goal");
    next.tasks.push({ id: `R-${++next.serial}`, sourceId: demand.id, title: demand.title, goal: demand.body, owner: null, status: "open", planClosed: false, withdrawn: false });
  }
  if (JSON.stringify(next.tasks) !== JSON.stringify(previous.tasks)) next.revision++;
  return next;
}
/** Runtime-verified registration, separate from Agent-authored actions. */
export function registerOrchestrator(previous: Board, id: string): Board {
  if (!text(id) || previous.agents.some(a => a.id === id)) fail("SCHEMA", "Agent identity must be unique");
  const next = clone(previous);
  next.agents.push({ id, role: "orchestrator", state: "idle", taskId: null, childId: null });
  next.revision++; return next;
}
export function setLimits(previous: Board, limits: Limits): Board {
  validateLimits(limits);
  const counts = quota(previous);
  if (ROLES.some(role => limits[role] < counts[role].running)) fail("QUOTA", "Limit cannot be below running Agents");
  const next = clone(previous); next.limits = { ...limits }; next.revision++; return next;
}
function validateEnvelope(value: Envelope) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some(k => !["requestId", "expectedRevision", "operation", "payload"].includes(k)) ||
      !text(value.requestId) || !Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 0 ||
      !Object.hasOwn(OP_FIELDS, value.operation)) fail("SCHEMA", "Invalid action envelope");
  const payload = value.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) fail("SCHEMA", "Invalid action payload");
  const fields: readonly string[] = OP_FIELDS[value.operation];
  if (Object.keys(payload).length !== fields.length || fields.some(k => !Object.hasOwn(payload, k) || !text(payload[k])))
    fail("SCHEMA", "Missing, unknown or invalid writable field");
  if (value.operation === "test" && !["pass", "fail"].includes(payload.verdict as string)) fail("SCHEMA", "Invalid verdict");
}
function own(a: Agent, task: Task) {
  if (a.role !== "orchestrator" || task.owner !== a.id) fail("FORBIDDEN", "Task is outside this Agent's scope");
  if (task.status === "done") fail("STATE", "Task is complete");
}
function capacity(board: Board, role: Role) {
  if (quota(board)[role].available <= 0) fail("QUOTA", "Concurrent execution limit reached");
}
function finish(board: Board, task: Task) {
  const children = board.children.filter(c => c.taskId === task.id);
  if (task.planClosed && children.length && children.every(c => c.status === "merged")) {
    task.status = "done"; find(board.agents, task.owner).state = "idle";
  }
}
function execution(board: Board, role: "worker" | "tester", task: Task, child: Child): Agent {
  let id: string;
  do { id = `${role === "worker" ? "W" : "T"}-${++board.serial}`; } while (board.agents.some(a => a.id === id));
  const agent: Agent = { id, role, state: "waiting", taskId: task.id, childId: child.id };
  board.agents.push(agent); return agent;
}
/** Pure transition: on any failure the original state is unchanged. No network side effects. */
export function transition(previous: Board, actorId: string, action: Envelope, trusted?: { fingerprint: string; at: number }): Board {
  validateEnvelope(action);
  const actor = find(previous.agents, actorId);
  const fingerprint = trusted?.fingerprint ?? JSON.stringify([action.operation, action.expectedRevision, Object.entries(action.payload).sort(([a], [b]) => a.localeCompare(b))]);
  const receipt = previous.receipts.find(r => r.actorId === actorId && r.requestId === action.requestId);
  if (receipt) {
    if (receipt.fingerprint !== fingerprint) fail("CONFLICT", "Request ID reused with different content");
    return clone(previous);
  }
  if (action.expectedRevision !== previous.revision) fail("CONFLICT", "Read the current revision before submitting");
  const board = clone(previous), a = find(board.agents, actor.id), p = action.payload, op = action.operation;
  if (op === "claim") {
    const task = find(board.tasks, p.taskId);
    if (a.role !== "orchestrator") fail("FORBIDDEN", "Only an orchestrator may claim");
    if (task.owner || task.withdrawn || task.status !== "open" || a.state === "running") fail("STATE", "Task or orchestrator already locked");
    capacity(board, "orchestrator");
    task.owner = a.id; a.taskId = task.id; a.state = "running";
  } else if (op === "addChild" || op === "closePlan") {
    const task = find(board.tasks, p.taskId); own(a, task);
    if (task.planClosed) fail("STATE", "Decomposition is already complete");
    if (op === "addChild") {
      board.children.push({ id: `C-${++board.serial}`, taskId: task.id, title: (p.title as string).trim(), acceptance: (p.acceptance as string).trim(), status: "queued", attempt: 0, worker: null, tester: null, result: null, verdict: null, evidence: null, mergeRef: null, history: [] });
    } else {
      if (!board.children.some(c => c.taskId === task.id)) fail("STATE", "A complete decomposition must contain children");
      task.planClosed = true; finish(board, task);
    }
  } else {
    const child = find(board.children, p.childId), task = find(board.tasks, child.taskId);
    if (["startWorker", "startTester", "merge"].includes(op)) own(a, task);
    if (op === "begin") {
      const assigned = a.role === "worker" ? child.worker === a.id && child.status === "queued" : a.role === "tester" && child.tester === a.id && child.status === "awaiting_test";
      if (!assigned || a.state !== "waiting") fail("FORBIDDEN", "Agent is not assigned to begin this attempt");
      capacity(board, a.role); a.state = "running";
      child.status = a.role === "worker" ? "working" : "testing";
    } else if (op === "cancel") {
      if (a.role === "orchestrator") own(a, task);
      else if (![child.worker, child.tester].includes(a.id) || a.state === "idle") fail("FORBIDDEN", "Agent is not assigned to this attempt");
      if (["passed", "merged", "rework"].includes(child.status)) fail("STATE", "Attempt already finished");
      for (const agent of board.agents.filter(x => [child.worker, child.tester].includes(x.id))) agent.state = "idle";
      child.status = "rework"; child.verdict = "fail"; child.evidence = JSON.stringify({ cancelledBy: a.id, reason: p.reason });
    } else if (op === "startWorker") {
      if (!["queued", "rework"].includes(child.status)) fail("STATE", "Child is not waiting for work");
      if (child.worker && find(board.agents, child.worker).state === "waiting") fail("STATE", "Worker is already assigned");
      if (child.attempt) child.history.push({ attempt: child.attempt, worker: child.worker, tester: child.tester, result: child.result, verdict: child.verdict, evidence: child.evidence });
      const worker = execution(board, "worker", task, child);
      Object.assign(child, { status: "queued", attempt: child.attempt + 1, worker: worker.id, tester: null, result: null, verdict: null, evidence: null, mergeRef: null });
    } else if (op === "work") {
      if (a.role !== "worker" || child.worker !== a.id || a.state !== "running" || child.status !== "working") fail("FORBIDDEN", "Worker is not assigned to this attempt");
      child.result = (p.result as string).trim(); child.status = "awaiting_test"; a.state = "idle";
    } else if (op === "startTester") {
      if (child.status !== "awaiting_test") fail("STATE", "Worker has not delivered");
      if (child.tester && find(board.agents, child.tester).state === "waiting") fail("STATE", "Tester is already assigned");
      child.tester = execution(board, "tester", task, child).id;
    } else if (op === "test") {
      if (a.role !== "tester" || child.tester !== a.id || child.worker === a.id || a.state !== "running" || child.status !== "testing") fail("FORBIDDEN", "Tester is not assigned to this attempt");
      child.verdict = p.verdict as "pass" | "fail"; child.evidence = (p.evidence as string).trim();
      child.status = child.verdict === "pass" ? "passed" : "rework"; a.state = "idle";
    } else if (op === "merge") {
      if (child.status !== "passed" || child.verdict !== "pass" || !child.result || !child.evidence) fail("STATE", "Independent test evidence is required before merge");
      child.mergeRef = (p.mergeRef as string).trim(); child.status = "merged"; finish(board, task);
    }
  }
  board.revision++;
  const assignedChild = board.children.find(c => c.id === p.childId);
  const agentId = op === "startWorker" ? assignedChild?.worker : op === "startTester" ? assignedChild?.tester : null;
  board.receipts.push({ actorId, requestId: action.requestId, fingerprint, revision: board.revision, ...(trusted ? { at: trusted.at } : {}), ...(agentId ? { agentId } : {}) });
  return board;
}
export function adminSnapshot(board: Board) {
  return clone({ revision: board.revision, tasks: board.tasks.map(t => ({ ...t, stage: stage(board, t) })), children: board.children, agents: board.agents, quota: quota(board) });
}
export type AdminSnapshot = ReturnType<typeof adminSnapshot>;
export function project(board: Board, actorId: string) {
  const a = find(board.agents, actorId);
  const tasks = board.tasks.filter(t => a.role === "orchestrator" ? t.owner === a.id : t.id === a.taskId);
  const ids = new Set(tasks.map(t => t.id));
  const children = board.children.filter(c => ids.has(c.taskId) && (a.role === "orchestrator" || c.id === a.childId && (a.role === "worker" ? c.worker === a.id : c.tester === a.id)));
  const writable: Operation[] = a.role === "orchestrator" ? ["claim", "addChild", "closePlan", "startWorker", "startTester", "merge", "cancel"] : a.role === "worker" ? ["begin", "work", "cancel"] : ["begin", "test", "cancel"];
  return clone({ schema: board.schema, revision: board.revision, identity: { id: a.id, role: a.role }, writable,
    ...(a.role === "orchestrator" ? { quota: quota(board), claimable: board.tasks.filter(t => !t.owner && !t.withdrawn).map(({ id, title }) => ({ id, title })) } : {}),
    tasks: tasks.map(t => a.role === "orchestrator" ? { ...t, stage: stage(board, t) } : { id: t.id, title: t.title, goal: t.goal }),
    children: children.map(c => a.role === "orchestrator" ? c : { id: c.id, taskId: c.taskId, title: c.title, acceptance: c.acceptance, status: c.status, attempt: c.attempt, result: c.result, verdict: c.verdict, evidence: c.evidence }),
    agents: board.agents.filter(x => x.id === a.id || a.role === "orchestrator" && ids.has(x.taskId ?? "")),
  });
}
export function writeSchemas(operations: readonly Operation[]) {
  return Object.fromEntries(operations.map(op => [op, { type: "object", additionalProperties: false, required: OP_FIELDS[op], properties: Object.fromEntries(OP_FIELDS[op].map(name => [name, { type: "string", minLength: 1, maxLength: 8_000, ...(name === "verdict" ? { enum: ["pass", "fail"] } : {}) }])) }]));
}
