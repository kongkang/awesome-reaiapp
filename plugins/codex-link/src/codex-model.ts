import { t, CodexMessageError } from "./codex-i18n";
/**
 * F06 内部观察模型。这里只处理已验证 adapter 的输入，不连接 Desktop、不投通知。
 * 旧 Host 的 Completed 摘要缺少事件出处，不能直接作为这个模型的输入。
 */
export type DesktopActivity = "unknown" | "idle" | "running" | "needs-user" | "error";
export type DesktopGroup = "attention" | "unseen" | "running" | "history";

export interface DesktopResult {
  turnId: string;
  resultId: string;
  status: "completed" | "interrupted" | "failed";
}

export interface DesktopObservation {
  sourceId: string;
  threadId: string;
  epoch: string;
  /** adapter 核实的同一连接内事件顺序，不能用历史文件时间替代。 */
  sequence: number;
  observedAtMs: number;
  origin: "baseline" | "live";
  kind: "snapshot" | "status" | "turn-ended";
  activity: DesktopActivity;
  activeTurnId?: string;
  /** 同一事项的稳定身份；缺失时仅显示等待并报告缺口，不猜身份或投通知。 */
  attentionId?: string;
  /** baseline adapter 须核实最新结果；无顺序证据不得重放未知的更旧结果。 */
  result?: DesktopResult;
}

export interface DesktopThreadRecord {
  sourceId: string;
  threadId: string;
  activity: DesktopActivity;
  activeTurnId?: string;
  result?: DesktopResult;
  seenResultId?: string;
  lastAttentionId?: string;
  lastCompletionId?: string;
  observedAtMs?: number;
  observedResultIds?: string[];
  observedAttentionIds?: string[];
  /** 未取得权威恢复证据前，普通状态/重连不能解除，也不能确认已看。 */
  observationIssue?: "identity-budget";
}

export interface DesktopObservationState {
  version: 1;
  records: DesktopThreadRecord[];
}

export interface DesktopObservedThread extends DesktopThreadRecord {
  epoch: string;
  sequence: number;
  observedAtMs: number;
  freshness: "fresh" | "stale";
}

export interface DesktopNoticeCandidate {
  kind: "needs-user" | "turn-ended";
  sourceId: string;
  threadId: string;
  eventKey: string;
}

export interface DesktopPresentationReceipt {
  kind: "presented" | "accepted";
  sourceId: string;
  threadId: string;
  epoch: string;
  turnId: string;
  resultId: string;
}

const DESKTOP_ID_LIMIT = 1_024;
export const DESKTOP_STATE_MAX_BYTES = 256 * 1_024;
const DESKTOP_STATE_MAX_RECORDS = 1_000;
export const DESKTOP_IDENTITIES_PER_THREAD = 256;

function desktopId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= DESKTOP_ID_LIMIT;
}

function desktopActivity(value: unknown): value is DesktopActivity {
  return ["unknown", "idle", "running", "needs-user", "error"].includes(value as string);
}

function desktopResult(value: unknown): value is DesktopResult {
  if (!value || typeof value !== "object") return false;
  const result = value as DesktopResult;
  return desktopId(result.turnId) && desktopId(result.resultId)
    && Object.keys(value).every((key) => ["turnId", "resultId", "status"].includes(key))
    && ["completed", "interrupted", "failed"].includes(result.status);
}

function desktopKey(sourceId: string, threadId: string): string {
  return JSON.stringify([sourceId, threadId]);
}

function cloneDesktopRecord(row: DesktopThreadRecord): DesktopThreadRecord {
  return {
    sourceId: row.sourceId,
    threadId: row.threadId,
    activity: row.activity,
    activeTurnId: row.activeTurnId,
    result: row.result ? { ...row.result } : undefined,
    seenResultId: row.seenResultId,
    lastAttentionId: row.lastAttentionId,
    lastCompletionId: row.lastCompletionId,
    observedAtMs: row.observedAtMs,
    observedResultIds: row.observedResultIds ? [...row.observedResultIds] : undefined,
    observedAttentionIds: row.observedAttentionIds ? [...row.observedAttentionIds] : undefined,
    observationIssue: row.observationIssue,
  };
}

function desktopIdentities(row: DesktopThreadRecord | undefined, kind: "result" | "attention"): Set<string> {
  return new Set((kind === "result"
    ? [...(row?.observedResultIds ?? []), row?.result?.resultId, row?.lastCompletionId, row?.seenResultId]
    : [...(row?.observedAttentionIds ?? []), row?.lastAttentionId])
    .filter((id): id is string => id !== undefined));
}

/** 删除可由同一行其他字段重建的重复表示，不删除任何已见身份。 */
function compactDesktopIdentities(row: DesktopThreadRecord): DesktopThreadRecord {
  const compact = { ...row };
  if (compact.lastCompletionId === compact.result?.resultId
    || compact.lastCompletionId === compact.seenResultId) delete compact.lastCompletionId;
  const representedResults = new Set([compact.result?.resultId, compact.seenResultId, compact.lastCompletionId]);
  const results = compact.observedResultIds?.filter((id) => !representedResults.has(id));
  if (results?.length) compact.observedResultIds = results;
  else delete compact.observedResultIds;
  const attentions = compact.observedAttentionIds?.filter((id) => id !== compact.lastAttentionId);
  if (attentions?.length) compact.observedAttentionIds = attentions;
  else delete compact.observedAttentionIds;
  return compact;
}

/** 只解析新键；失败保留原存储，由调用方停用持久写入，绝不清空回写。 */
export function parseDesktopObservationState(raw: unknown): {
  state: DesktopObservationState;
  writable: boolean;
} {
  const empty = (): DesktopObservationState => ({ version: 1, records: [] });
  if (raw === undefined || raw === null) return { state: empty(), writable: true };
  try {
    const text = typeof raw === "string" ? raw : JSON.stringify(raw);
    if (new TextEncoder().encode(text).byteLength > DESKTOP_STATE_MAX_BYTES) throw new Error();
    const value = JSON.parse(text) as DesktopObservationState;
    if (!value || value.version !== 1 || !Array.isArray(value.records)
      || !Object.keys(value).every((key) => ["version", "records"].includes(key))
      || value.records.length > DESKTOP_STATE_MAX_RECORDS) throw new Error();
    const keys = new Set<string>();
    const records = value.records.map((row) => {
      if (!row || !desktopId(row.sourceId) || !desktopId(row.threadId)
        || !desktopActivity(row.activity)) throw new Error();
      if (!Object.keys(row).every((key) => ["sourceId", "threadId", "activity", "activeTurnId",
        "result", "seenResultId", "lastAttentionId", "lastCompletionId", "observedAtMs",
        "observedResultIds", "observedAttentionIds", "observationIssue"].includes(key))) throw new Error();
      for (const id of [row.activeTurnId, row.seenResultId, row.lastAttentionId, row.lastCompletionId]) {
        if (id !== undefined && !desktopId(id)) throw new Error();
      }
      if (row.result !== undefined && !desktopResult(row.result)) throw new Error();
      if (row.observedAtMs !== undefined && finiteTimestamp(row.observedAtMs) === undefined) throw new Error();
      for (const ids of [row.observedResultIds, row.observedAttentionIds]) {
        if (ids !== undefined && (!Array.isArray(ids) || ids.length > DESKTOP_IDENTITIES_PER_THREAD
          || !ids.every(desktopId) || new Set(ids).size !== ids.length)) throw new Error();
      }
      if (row.observationIssue !== undefined && row.observationIssue !== "identity-budget") throw new Error();
      // 缺口状态保留最新结果/事项元数据，但不继续扩充已满的历史数组。
      const identityLimit = DESKTOP_IDENTITIES_PER_THREAD + (row.observationIssue ? 3 : 0);
      if (desktopIdentities(row, "result").size > identityLimit
        || desktopIdentities(row, "attention").size > identityLimit) throw new Error();
      const key = desktopKey(row.sourceId, row.threadId);
      if (keys.has(key)) throw new Error();
      keys.add(key);
      return cloneDesktopRecord(row);
    });
    return { state: { version: 1, records }, writable: true };
  } catch {
    return { state: empty(), writable: false };
  }
}

/** 仅此插件的分类；不改公共 Tab 排序，也不使用 48h 或条数把未看结果折走。 */
export function desktopThreadGroup(row: DesktopThreadRecord): DesktopGroup | undefined {
  if (row.observationIssue) return "attention";
  if (row.activity === "needs-user" || row.activity === "error") return "attention";
  if (row.result && row.seenResultId !== row.result.resultId) return "unseen";
  if (row.activity === "running") return "running";
  if (row.activity === "idle" && row.result && row.seenResultId === row.result.resultId) return "history";
  // 尚无可靠状态的目标留给连接诊断，不编造“已结束已看”来塞进历史。
  return undefined;
}

export class DesktopObservationModel {
  #rows = new Map<string, DesktopObservedThread>();
  #connection?: { sourceId: string; epoch: string };
  #baselineReady = false;
  #historyExpanded = false;

  constructor(state: DesktopObservationState = { version: 1, records: [] }) {
    const parsed = parseDesktopObservationState(state);
    for (const row of parsed.state.records) {
      this.#rows.set(desktopKey(row.sourceId, row.threadId), {
        ...row, epoch: "", sequence: -1, observedAtMs: row.observedAtMs ?? 0, freshness: "stale",
      });
    }
  }

  /** provenance 是未来受支持 adapter 的核验结果；此方法本身不取得任何权限。 */
  connect(sourceId: string, epoch: string, provenance: "verified-native" | "unknown"): boolean {
    if (provenance !== "verified-native" || !desktopId(sourceId) || !desktopId(epoch)) return false;
    this.disconnect();
    this.#connection = { sourceId, epoch };
    return true;
  }

  disconnect(): void {
    this.#connection = undefined;
    this.#baselineReady = false;
    for (const row of this.#rows.values()) row.freshness = "stale";
  }

  /** 分页/快照对账不完整时不调用，防止把重连历史作为新通知。 */
  finishBaseline(epoch: string): boolean {
    if (this.#connection?.epoch !== epoch) return false;
    this.#baselineReady = true;
    return true;
  }

  apply(event: DesktopObservation): {
    applied: boolean;
    notice?: DesktopNoticeCandidate;
    issue?: "identity-budget" | "attention-identity-unavailable" | "turn-identity-conflict" | "result-superseded";
  } {
    const connection = this.#connection;
    if (!connection || connection.sourceId !== event.sourceId || connection.epoch !== event.epoch
      || !desktopId(event.threadId) || !desktopActivity(event.activity)
      || !Number.isSafeInteger(event.sequence) || event.sequence < 0
      || finiteTimestamp(event.observedAtMs) === undefined
      || !["baseline", "live"].includes(event.origin)
      || !["snapshot", "status", "turn-ended"].includes(event.kind)
      || (event.kind === "snapshot" && event.origin !== "baseline")
      || (event.kind === "status" && event.result !== undefined)
      || (event.kind === "turn-ended" && (!event.result || !["idle", "error"].includes(event.activity)))
      || (event.activeTurnId !== undefined && !desktopId(event.activeTurnId))
      || (event.attentionId !== undefined && !desktopId(event.attentionId))
      || (event.result !== undefined && !desktopResult(event.result))) return { applied: false };
    const key = desktopKey(event.sourceId, event.threadId);
    const previous = this.#rows.get(key);
    if (previous?.epoch === event.epoch && event.sequence <= previous.sequence) return { applied: false };
    const resultIds = desktopIdentities(previous, "result");
    const attentionIds = desktopIdentities(previous, "attention");
    // 被更新结果取代的已知身份，即便以新 sequence/epoch 重放也不能退回。
    if (event.result && resultIds.has(event.result.resultId)
      && event.result.resultId !== previous?.result?.resultId) return { applied: false, issue: "result-superseded" };
    const identityBudget = previous?.observationIssue === "identity-budget"
      || (event.result && !resultIds.has(event.result.resultId) && resultIds.size >= DESKTOP_IDENTITIES_PER_THREAD)
      || (event.activity === "needs-user" && event.attentionId && !attentionIds.has(event.attentionId)
        && attentionIds.size >= DESKTOP_IDENTITIES_PER_THREAD);
    // 新回合已在运行，旧回合的晚到终局不能覆盖它或制造当前回合完成。
    if (event.kind === "turn-ended" && event.result && previous?.activeTurnId
      && previous.activeTurnId !== event.result.turnId
      && (previous.activity === "running" || previous.activity === "needs-user")) {
      return { applied: false, issue: "turn-identity-conflict" };
    }

    const row: DesktopObservedThread = {
      ...previous,
      sourceId: event.sourceId,
      threadId: event.threadId,
      activity: event.activity,
      activeTurnId: event.activeTurnId ?? (["running", "needs-user"].includes(event.activity)
        && previous?.epoch === event.epoch ? previous.activeTurnId : undefined),
      result: event.result ? { ...event.result } : previous?.result,
      epoch: event.epoch,
      sequence: event.sequence,
      observedAtMs: event.observedAtMs,
      freshness: "fresh",
    };
    if (identityBudget) {
      row.observationIssue = "identity-budget";
      row.freshness = "stale";
      if (event.result) row.lastCompletionId = event.result.resultId;
      if (event.activity === "needs-user" && event.attentionId) row.lastAttentionId = event.attentionId;
      this.#rows.set(key, row); // 接受活动/结果与sequence，但不虚构通知或恢复完整性。
      return { applied: true, issue: "identity-budget" };
    }
    let notice: DesktopNoticeCandidate | undefined;
    const live = this.#baselineReady && event.origin === "live";
    if (event.activity === "needs-user" && event.attentionId) {
      if (live && !attentionIds.has(event.attentionId)) {
        notice = { kind: "needs-user", sourceId: row.sourceId, threadId: row.threadId,
          eventKey: JSON.stringify([row.sourceId, row.threadId, "needs-user", event.attentionId]) };
      }
      row.lastAttentionId = event.attentionId;
      attentionIds.add(event.attentionId);
      row.observedAttentionIds = [...attentionIds];
    }
    if (event.result) {
      if (live && event.kind === "turn-ended" && !resultIds.has(event.result.resultId)
        && event.activity !== "running" && event.activity !== "needs-user") {
        notice = { kind: "turn-ended", sourceId: row.sourceId, threadId: row.threadId,
          eventKey: JSON.stringify([row.sourceId, row.threadId, "turn-ended", event.result.resultId]) };
      }
      row.lastCompletionId = event.result.resultId;
      resultIds.add(event.result.resultId);
      row.observedResultIds = [...resultIds];
    }
    this.#rows.set(key, row);
    return { applied: true, notice,
      ...(event.activity === "needs-user" && !event.attentionId
        ? { issue: "attention-identity-unavailable" as const } : {}) };
  }

  /** 调用方还须用目标事务校验请求代次；这里再次绑定当前连接和准确结果。 */
  presented(receipt: DesktopPresentationReceipt): boolean {
    const connection = this.#connection;
    if (receipt.kind !== "presented" || !connection || connection.sourceId !== receipt.sourceId
      || connection.epoch !== receipt.epoch) return false;
    const row = this.#rows.get(desktopKey(receipt.sourceId, receipt.threadId));
    if (!row || row.observationIssue || row.freshness !== "fresh" || row.epoch !== receipt.epoch
      || row.result?.turnId !== receipt.turnId || row.result?.resultId !== receipt.resultId) return false;
    row.seenResultId = receipt.resultId;
    return true;
  }

  rows(): DesktopObservedThread[] {
    return [...this.#rows.values()].map((row) => ({ ...row, ...cloneDesktopRecord(row),
      observedAtMs: row.observedAtMs }));
  }

  /** 只裁无档位且没有已见身份的行；已看/去重证据无损压缩，仍超限则明确失败。 */
  snapshot(): DesktopObservationState {
    const records = [...this.#rows.values()].map(cloneDesktopRecord);
    const encoder = new TextEncoder();
    const sizes = records.map((row) => encoder.encode(JSON.stringify(row)).byteLength);
    let count = records.length;
    let bytes = encoder.encode(JSON.stringify({ version: 1, records: [] })).byteLength
      + sizes.reduce((a, b) => a + b, 0) + Math.max(0, count - 1);
    const overBudget = () => count > DESKTOP_STATE_MAX_RECORDS || bytes > DESKTOP_STATE_MAX_BYTES;
    const candidates = records.flatMap((row, index) => {
      const group = desktopThreadGroup(row);
      return group === undefined && desktopIdentities(row, "result").size === 0
        && desktopIdentities(row, "attention").size === 0
        ? [{ index, time: row.observedAtMs ?? 0 }] : [];
    }).sort((a, b) => a.time - b.time || a.index - b.index);
    const removed = new Set<number>();
    for (const candidate of candidates) {
      if (!overBudget()) break;
      removed.add(candidate.index);
      bytes -= sizes[candidate.index]! + (count > 1 ? 1 : 0);
      count--;
    }
    const compactable = records.flatMap((row, index) => {
      const group = desktopThreadGroup(row);
      return !removed.has(index) && (group === undefined || group === "history")
        ? [{ index, time: row.observedAtMs ?? 0 }] : [];
    }).sort((a, b) => a.time - b.time || a.index - b.index);
    for (const { index } of compactable) {
      if (!overBudget()) break;
      const compact = compactDesktopIdentities(records[index]!);
      const size = encoder.encode(JSON.stringify(compact)).byteLength;
      bytes -= sizes[index]! - size;
      records[index] = compact;
    }
    // 没有供应方的身份过期/重放下界合同，不能按年龄或容量遗忘已看与去重事实。
    if (overBudget()) throw new CodexMessageError("errors.retentionBudget");
    return { version: 1, records: records.filter((_, index) => !removed.has(index)) };
  }

  setHistoryExpanded(expanded: boolean): void {
    this.#historyExpanded = expanded;
  }

  visibleRows(): DesktopObservedThread[] {
    const groups = this.groups();
    return [...groups.attention, ...groups.unseen, ...groups.running,
      ...(this.#historyExpanded ? groups.history : [])];
  }

  groups(): Record<DesktopGroup, DesktopObservedThread[]> {
    const groups: Record<DesktopGroup, DesktopObservedThread[]> = {
      attention: [], unseen: [], running: [], history: [],
    };
    for (const row of this.rows()) {
      const group = desktopThreadGroup(row);
      if (group) groups[group].push(row);
    }
    return groups;
  }
}

// ---------------------------------------------------------------------------
// P1 观察投影生产链路：frame 映射器 + 门面编排器（注入端口，不接生产 SDK）。
// 端口语义对齐 Host BackgroundTaskService 观察入口；SDK/Bridge 门面合同定稿后
// 由薄适配层转发，这里不解析 Codex 字段、不投通知、不取得任何权限。
// ---------------------------------------------------------------------------

export type HostObservationActivity = "running" | "needsUser" | "problem" | "idle" | "unknown";
export type HostObservationOutcome = "completed" | "failed" | "interrupted";

export interface HostObservationResult {
  id: string;
  outcome: HostObservationOutcome;
  endedAt: number;
}

export interface HostObservationOpenCommand {
  id: string;
  input: unknown;
}

/** Host `TaskObservationFrame` 的 camelCase 线形；不含 appId/Runtime 凭据。 */
export interface HostTaskObservationFrame {
  entityId: string;
  revision: number;
  sourceEpoch: string;
  title: string;
  startedAt: number;
  activatedAt: number;
  activity: HostObservationActivity;
  result?: HostObservationResult;
  seenResultId?: string;
  freshness: "current" | "stale";
  openCommand?: HostObservationOpenCommand;
}

const HOST_ACTIVITY: Record<DesktopActivity, HostObservationActivity> = {
  unknown: "unknown",
  idle: "idle",
  running: "running",
  "needs-user": "needsUser",
  error: "problem",
};

const HOST_OUTCOME: Record<DesktopResult["status"], HostObservationOutcome> = {
  completed: "completed",
  interrupted: "interrupted",
  failed: "failed",
};

export interface DesktopFrameMeta {
  /** 必须来自 adapter 的真实标题；映射器不编造。 */
  title: string;
  /** 缺省用 observedAtMs，不伪造更早开始。 */
  startedAtMs?: number;
  openCommand?: { id: string; input: unknown };
}

export type DesktopFrameRefusal =
  | "not-observed" | "invalid-title" | "invalid-entity" | "invalid-epoch"
  | "seen-mismatch" | "invalid-open-command" | "oversized";

export type DesktopFrameMapping =
  | { frame: HostTaskObservationFrame; refused?: undefined }
  | { frame?: undefined; refused: DesktopFrameRefusal };

const HOST_CONTROL = /\p{Cc}/u;
const encoder = new TextEncoder();

function byteLength(value: string): number {
  return encoder.encode(value).byteLength;
}

/** Host 按 UTF-8 字节限 512；展示字段超长安全截断优于拒绝（不切半个字符）。 */
function clampTitleBytes(title: string): string {
  if (byteLength(title) <= 512) return title;
  let out = "";
  for (const ch of title) {
    if (byteLength(out + ch) > 512) break;
    out += ch;
  }
  return out;
}

/** 纯映射：只转译已验证事实，拒绝规则全部保守（不猜身份、不虚构时间/已看）。 */
export function desktopObservationFrame(
  row: DesktopObservedThread,
  meta: DesktopFrameMeta,
): DesktopFrameMapping {
  if (row.epoch === "" || row.sequence < 0
    || !Number.isSafeInteger(row.observedAtMs) || row.observedAtMs < 0) {
    return { refused: "not-observed" };
  }
  if (byteLength(row.epoch) > 128 || HOST_CONTROL.test(row.epoch)) {
    return { refused: "invalid-epoch" };
  }
  const title = typeof meta.title === "string" ? clampTitleBytes(meta.title) : "";
  if (title.length === 0 || title.trim().length === 0 || HOST_CONTROL.test(title)) {
    return { refused: "invalid-title" };
  }
  if (row.threadId.length === 0 || byteLength(row.threadId) > 128 || HOST_CONTROL.test(row.threadId)) {
    return { refused: "invalid-entity" };
  }
  // 模型刻意保留旧已看与新结果不等作未看判据：相等才透传已看，新结果省略已看；
  // 只有「无结果却有已看」的真损坏数据才拒收。
  if (row.result === undefined && row.seenResultId !== undefined) {
    return { refused: "seen-mismatch" };
  }
  const open = meta.openCommand;
  if (open !== undefined
    && (typeof open.id !== "string" || open.id.length === 0 || byteLength(open.id) > 128 || HOST_CONTROL.test(open.id))) {
    return { refused: "invalid-open-command" };
  }
  const seenMatchesResult = row.result !== undefined && row.seenResultId === row.result.resultId;
  const frame: HostTaskObservationFrame = {
    entityId: row.threadId,
    revision: row.sequence + 1,
    sourceEpoch: row.epoch,
    title,
    startedAt: meta.startedAtMs ?? row.observedAtMs,
    activatedAt: row.observedAtMs,
    activity: HOST_ACTIVITY[row.activity],
    ...(row.result !== undefined
      ? { result: { id: row.result.resultId, outcome: HOST_OUTCOME[row.result.status], endedAt: row.observedAtMs } }
      : {}),
    ...(seenMatchesResult && row.seenResultId !== undefined ? { seenResultId: row.seenResultId } : {}),
    freshness: row.freshness === "fresh" ? "current" : "stale",
    ...(open !== undefined ? { openCommand: { id: open.id, input: open.input } } : {}),
  };
  // Host 按序列化字节限 8 KiB，且已看字段入库前预留同结果已看后的体积。
  const payload = byteLength(JSON.stringify(frame));
  const reserved = frame.result !== undefined && frame.seenResultId === undefined
    ? byteLength(JSON.stringify({ ...frame, seenResultId: frame.result.id }))
    : payload;
  if (payload > 8192 || reserved > 8192) {
    return { refused: "oversized" };
  }
  return { frame };
}

export type DesktopObservationErrorCode =
  | "invalid" | "stale-owner" | "stale-revision" | "capacity"
  | "rate-limited" | "restart-required" | "not-found" | "unavailable";

export class DesktopObservationPortError extends Error {
  constructor(readonly code: DesktopObservationErrorCode) {
    super("observation-port:" + code);
  }
}

function portErrorCode(error: unknown): DesktopObservationErrorCode {
  // 非端口错误（Bridge 传输失败/超时）按不可用降级，不当「跳过」静默吞掉。
  return error instanceof DesktopObservationPortError ? error.code : "unavailable";
}

export interface DesktopObservationOwnerHandle {
  sourceId: string;
  epoch: string;
  generation: number;
}

export interface DesktopObservationPageCursor {
  revision: number;
  generation: number;
  offset: number;
}

export interface DesktopObservationPageResult {
  items: HostTaskObservationFrame[];
  next?: DesktopObservationPageCursor;
  coverage: "complete" | "partial";
  revision: number;
}

export interface DesktopObservationSnapshotHandle {
  generation: number;
  rejections: number;
  serial: number;
}

/** 未来 SDK/Bridge 门面的注入端口；语义对齐 Host 观察入口，不在此实现。 */
export interface DesktopObservationPort {
  bind(sourceId: string, epoch: string): Promise<DesktopObservationOwnerHandle>;
  upsert(owner: DesktopObservationOwnerHandle, frame: HostTaskObservationFrame): Promise<void>;
  markSeen(owner: DesktopObservationOwnerHandle, entityId: string, revision: number, resultId: string): Promise<void>;
  remove(owner: DesktopObservationOwnerHandle, entityId: string,
    expectedEpoch: string, expectedRevision: number, deletionRevision: number): Promise<void>;
  stale(owner: DesktopObservationOwnerHandle): Promise<void>;
  clear(owner: DesktopObservationOwnerHandle): Promise<void>;
  beginSnapshot(owner: DesktopObservationOwnerHandle): Promise<DesktopObservationSnapshotHandle>;
  completeSnapshot(owner: DesktopObservationOwnerHandle, snapshot: DesktopObservationSnapshotHandle): Promise<void>;
  page(owner: DesktopObservationOwnerHandle, cursor: DesktopObservationPageCursor | undefined,
    limit: number): Promise<DesktopObservationPageResult>;
}

export interface DesktopProjectionStatus {
  attached: boolean;
  coverage: "unknown" | "partial" | "complete";
  degraded: boolean;
  lastError?: DesktopObservationErrorCode;
}

export type DesktopFrameMetaSource = (row: DesktopObservedThread) => DesktopFrameMeta;

/**
 * 把模型状态投影到 Host 观察集合：attach/baseline 快照、增量 upsert、
 * 仅真实呈现回执上报 seen、断连 stale、CAS remove、分页重试。
 * 不连接 Desktop、不解析 Codex 协议；生产接线等 SDK/Bridge 门面与 P2/L1/D0。
 */
export class DesktopObservationProjection {
  #owner?: DesktopObservationOwnerHandle;
  #coverage: DesktopProjectionStatus["coverage"] = "unknown";
  #degraded = false;
  #lastError?: DesktopObservationErrorCode;
  #lastPushed = new Map<string, { epoch: string; revision: number }>();

  constructor(readonly port: DesktopObservationPort, readonly model: DesktopObservationModel) {}

  status(): DesktopProjectionStatus {
    return {
      attached: this.#owner !== undefined,
      coverage: this.#coverage,
      degraded: this.#degraded,
      ...(this.#lastError !== undefined ? { lastError: this.#lastError } : {}),
    };
  }

  async attach(input: {
    sourceId: string;
    epoch: string;
    provenance: "verified-native" | "unknown";
  }): Promise<boolean> {
    if (!this.model.connect(input.sourceId, input.epoch, input.provenance)) return false;
    try {
      this.#owner = await this.port.bind(input.sourceId, input.epoch);
    } catch (error) {
      this.#lastError = portErrorCode(error);
      if (this.#lastError === "capacity" || this.#lastError === "rate-limited") this.#degraded = true;
      return false;
    }
    this.#lastPushed.clear();
    this.#coverage = "partial";
    this.#degraded = false;
    this.#lastError = undefined;
    return true;
  }

  async pushBaseline(
    meta: DesktopFrameMeta | DesktopFrameMetaSource,
    options: { completeDiscovery?: boolean } = {},
  ): Promise<{
    pushed: number;
    refused: number;
    leftover: number;
    complete: boolean;
    degraded: boolean;
    orphaned: boolean;
  }> {
    const owner = this.#owner;
    const rows = this.model.rows();
    if (owner === undefined) {
      return { pushed: 0, refused: rows.length, leftover: 0, complete: false,
        degraded: this.#degraded, orphaned: false };
    }
    const metaOf: DesktopFrameMetaSource = typeof meta === "function" ? meta : () => meta;
    let snapshot: DesktopObservationSnapshotHandle;
    try {
      snapshot = await this.port.beginSnapshot(owner);
    } catch (error) {
      this.#lastError = portErrorCode(error);
      this.#coverage = "partial";
      if (portErrorCode(error) === "stale-owner") await this.#handleOrphanOwner();
      return { pushed: 0, refused: rows.length, leftover: 0, complete: false,
        degraded: this.#degraded, orphaned: this.#owner === undefined };
    }
    let pushed = 0;
    let refused = 0;
    // 上一连接遗留行（epoch 不同）不推、不拒、不降级：交给 reconcileHost 清 Host 遗留。
    let leftover = 0;
    // 只统计本次 baseline 内的容量/速率/不可用拒绝，与 Host rejections 语义一致。
    let rejected = false;
    for (const row of rows) {
      if (row.epoch !== owner.epoch) {
        // 只有曾在非空 epoch 下被合法 apply 过的上一连接遗留行才计 leftover；
        // KV 恢复行（epoch 空串）必须继续走映射器 fail-closed 拒绝路径计入
        // refused，否则「零拒绝才 complete」的承诺会被绕过。
        if (row.epoch !== "") {
          leftover += 1;
          continue;
        }
      }
      const mapped = desktopObservationFrame(row, metaOf(row));
      if (mapped.refused !== undefined) {
        refused += 1;
        continue;
      }
      try {
        await this.port.upsert(owner, mapped.frame);
        this.#lastPushed.set(mapped.frame.entityId, {
          epoch: mapped.frame.sourceEpoch,
          revision: mapped.frame.revision,
        });
        pushed += 1;
      } catch (error) {
        const code = portErrorCode(error);
        this.#lastError = code;
        if (code === "stale-owner") {
          await this.#handleOrphanOwner();
          return { pushed, refused, leftover, complete: false,
            degraded: this.#degraded, orphaned: true };
        }
        if (code === "capacity" || code === "rate-limited" || code === "unavailable") {
          rejected = true;
          this.#degraded = true;
        }
        // stale-revision/invalid：Host 已有同代更新或映射问题，视为已同步，不降级。
      }
    }
    let complete = false;
    if (options.completeDiscovery === true && !rejected && refused === 0 && this.#owner === owner) {
      try {
        await this.port.completeSnapshot(owner, snapshot);
        complete = true;
        this.#coverage = "complete";
        this.#degraded = false;
      } catch (error) {
        this.#lastError = portErrorCode(error);
      }
    }
    if (!complete) this.#coverage = "partial";
    return { pushed, refused, leftover, complete, degraded: this.#degraded, orphaned: false };
  }

  async applyEvent(
    event: DesktopObservation,
    meta: DesktopFrameMeta,
  ): Promise<{
    applied: boolean;
    pushed: boolean;
    notice?: DesktopNoticeCandidate;
    issue?: "identity-budget" | "attention-identity-unavailable" | "turn-identity-conflict" | "result-superseded";
    refused?: DesktopFrameRefusal;
  }> {
    const outcome = this.model.apply(event);
    if (!outcome.applied) return { applied: false, pushed: false };
    const base = { applied: true, ...(outcome.notice !== undefined ? { notice: outcome.notice } : {}),
      ...(outcome.issue !== undefined ? { issue: outcome.issue } : {}) };
    const row = this.model.rows().find((r) => r.sourceId === event.sourceId && r.threadId === event.threadId);
    if (row === undefined) return { ...base, pushed: false };
    const mapped = desktopObservationFrame(row, meta);
    if (mapped.refused !== undefined) return { ...base, pushed: false, refused: mapped.refused };
    return { ...base, pushed: await this.#pushFrame(mapped.frame) };
  }

  async markSeen(
    receipt: DesktopPresentationReceipt,
  ): Promise<{ presented: boolean; reported: boolean }> {
    if (!this.model.presented(receipt)) return { presented: false, reported: false };
    const owner = this.#owner;
    const last = this.#lastPushed.get(receipt.threadId);
    if (owner === undefined || last === undefined) return { presented: true, reported: false };
    try {
      await this.port.markSeen(owner, receipt.threadId, last.revision, receipt.resultId);
      return { presented: true, reported: true };
    } catch (error) {
      const code = portErrorCode(error);
      this.#lastError = code;
      if (code === "stale-owner") await this.#handleOrphanOwner();
      // Host 已有更新/目标不在：本地已看保留，随下一帧透传，不回滚也不降级。
      return { presented: true, reported: false };
    }
  }

  async detach(): Promise<void> {
    const owner = this.#owner;
    this.#owner = undefined;
    this.#coverage = "unknown";
    if (owner !== undefined) {
      try {
        await this.port.stale(owner);
      } catch {
        // 尽力而为：端口不可用不阻塞本地断连。
      }
    }
    this.model.disconnect();
  }

  async removeThread(threadId: string, deletionRevision: number): Promise<boolean> {
    const owner = this.#owner;
    if (owner === undefined || !Number.isSafeInteger(deletionRevision) || deletionRevision <= 0) return false;
    const last = this.#lastPushed.get(threadId);
    try {
      await this.port.remove(owner, threadId, last?.epoch ?? owner.epoch, last?.revision ?? 0, deletionRevision);
      this.#lastPushed.delete(threadId);
      return true;
    } catch (error) {
      const code = portErrorCode(error);
      this.#lastError = code;
      if (code === "stale-owner") await this.#handleOrphanOwner();
      return false;
    }
  }

  async readHostPage(limit: number): Promise<{
    items: HostTaskObservationFrame[];
    coverage: "complete" | "partial";
    restarts: number;
    abandoned: boolean;
  }> {
    const owner = this.#owner;
    if (owner === undefined) return { items: [], coverage: "partial", restarts: 0, abandoned: true };
    const maxRestarts = 3;
    let restarts = 0;
    for (;;) {
      const items: HostTaskObservationFrame[] = [];
      let cursor: DesktopObservationPageCursor | undefined = undefined;
      let coverage: "complete" | "partial" = "partial";
      try {
        do {
          const page = await this.port.page(owner, cursor, limit);
          items.push(...page.items);
          cursor = page.next;
          coverage = page.coverage;
        } while (cursor !== undefined);
        this.#coverage = coverage;
        return { items, coverage, restarts, abandoned: false };
      } catch (error) {
        if (portErrorCode(error) === "restart-required" && restarts < maxRestarts) {
          restarts += 1;
          continue;
        }
        this.#lastError = portErrorCode(error);
        this.#coverage = "partial";
        return { items: [], coverage: "partial", restarts, abandoned: true };
      }
    }
  }

  /**
   * 基线对账闭环：重建本连接行的 CAS 记忆，并把 Host 上旧 epoch 遗留行
   * （上一连接推送、本连接未再出现）按跨 epoch 删除清掉。
   */
  async reconcileHost(): Promise<{ removed: number; rebuilt: number; abandoned: boolean }> {
    const owner = this.#owner;
    if (owner === undefined) return { removed: 0, rebuilt: 0, abandoned: true };
    const page = await this.readHostPage(250);
    if (page.abandoned) return { removed: 0, rebuilt: 0, abandoned: true };
    const local = new Set(this.model.rows()
      .filter((row) => row.epoch === owner.epoch)
      .map((row) => row.threadId));
    let removed = 0;
    let rebuilt = 0;
    for (const item of page.items) {
      if (item.sourceEpoch === owner.epoch) {
        this.#lastPushed.set(item.entityId, { epoch: item.sourceEpoch, revision: item.revision });
        rebuilt += 1;
        continue;
      }
      if (local.has(item.entityId)) continue;
      try {
        // 跨 epoch 删除只要求 deletionRevision 非零；CAS 用旧行自身 epoch/revision。
        await this.port.remove(owner, item.entityId, item.sourceEpoch, item.revision, 1);
        removed += 1;
      } catch (error) {
        const code = portErrorCode(error);
        this.#lastError = code;
        if (code === "stale-owner") {
          await this.#handleOrphanOwner();
          return { removed, rebuilt, abandoned: true };
        }
      }
    }
    return { removed, rebuilt, abandoned: false };
  }

  async #pushFrame(frame: HostTaskObservationFrame): Promise<boolean> {
    const owner = this.#owner;
    if (owner === undefined) return false;
    try {
      await this.port.upsert(owner, frame);
      this.#lastPushed.set(frame.entityId, { epoch: frame.sourceEpoch, revision: frame.revision });
      return true;
    } catch (error) {
      const code = portErrorCode(error);
      this.#lastError = code;
      if (code === "capacity" || code === "rate-limited" || code === "unavailable") {
        this.#degraded = true;
        this.#coverage = "partial";
        return false;
      }
      if (code === "stale-owner") {
        await this.#handleOrphanOwner();
        return false;
      }
      // stale-revision/invalid：Host 已有更新或映射问题，跳过，不降级。
      return false;
    }
  }

  async #handleOrphanOwner(): Promise<void> {
    this.#owner = undefined;
    this.#coverage = "unknown";
    this.model.disconnect();
  }
}

export interface CodexThread {
  id: string;
  cwd?: string;
  name?: string | null;
  preview?: string;
  /** Codex app-server `thread/list` 当前返回 Unix 秒。 */
  recencyAt?: number;
  updatedAt?: number;
  status?: {
    type?: "notLoaded" | "idle" | "systemError" | "active";
    activeFlags?: Array<"waitingOnApproval" | "waitingOnUserInput" | string>;
  };
  [key: string]: unknown;
}

export type PendingRequestKind =
  | "commandApproval"
  | "fileChangeApproval"
  | "permissionsApproval"
  | "userInput"
  | "otherApproval";

export interface PendingRequestSummary {
  serverRequestId?: number;
  threadId?: string;
  kind: PendingRequestKind;
  summary: string;
  receivedAtMs?: number;
}

export interface RuntimeThreadSnapshot {
  threadId: string;
  state: "thinking" | "completed" | "needsInput" | "error";
  lastEventMs: number;
  waitingReason?: string;
  activeTurnId?: string;
  managedByDriver: boolean;
  pendingRequests: PendingRequestSummary[];
}

export interface LocalThreadState {
  version: 1;
  managed: Record<string, { createdAtMs: number; cwd: string }>;
  seenAtMs: Record<string, number>;
}

export interface DashboardThread {
  id: string;
  cwd: string;
  title: string;
  preview: string;
  recencyAtMs: number;
  state: RuntimeThreadSnapshot["state"] | "idle";
  managedByDriver: boolean;
  waitingReason?: string;
  activeTurnId?: string;
  pendingRequests: PendingRequestSummary[];
  status: "hot" | "done" | "run" | "idle" | "error";
}

export interface DashboardGroups {
  waiting: DashboardThread[];
  unseen: DashboardThread[];
  failed: DashboardThread[];
  other: DashboardThread[];
  far: DashboardThread[];
}

export interface ThreadGroups {
  needsAttention: CodexThread[];
  active: CodexThread[];
  recent: CodexThread[];
}

const FORTY_EIGHT_HOURS_MS = 48 * 60 * 60 * 1_000;
const DEFAULT_LOCAL_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1_000;
const DEFAULT_LOCAL_MAX_RECORDS = 1_000;
const DEFAULT_LOCAL_MAX_BYTES = 256 * 1_024;

export function emptyLocalThreadState(): LocalThreadState {
  return { version: 1, managed: {}, seenAtMs: {} };
}

function finiteTimestamp(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

/** app-server 列表用秒，Host/local state 用毫秒；在边界统一一次。 */
export function unixTimestampMs(value: unknown): number {
  const timestamp = finiteTimestamp(value);
  if (timestamp === undefined) return 0;
  return timestamp < 100_000_000_000 ? Math.round(timestamp * 1_000) : Math.round(timestamp);
}

function recency(thread: CodexThread): number {
  return unixTimestampMs(thread.recencyAt ?? thread.updatedAt);
}

function newestFirst<T extends { id: string; recencyAtMs: number }>(left: T, right: T): number {
  return right.recencyAtMs - left.recencyAtMs || left.id.localeCompare(right.id);
}

export function needsAttention(thread: CodexThread): boolean {
  return thread.status?.type === "active"
    && (thread.status.activeFlags ?? []).some((flag) =>
      flag === "waitingOnApproval" || flag === "waitingOnUserInput"
    );
}

/** 保留 0.1 消费者的旧分组 API；0.2 页面使用 buildDashboard。 */
export function partitionThreads(
  recentRows: CodexThread[],
  activeRows: CodexThread[],
): ThreadGroups {
  const activeById = new Map<string, CodexThread>();
  for (const thread of activeRows) {
    if (thread?.id) activeById.set(thread.id, thread);
  }
  const active = [...activeById.values()];
  const byRecency = (left: CodexThread, right: CodexThread) => recency(right) - recency(left);
  return {
    needsAttention: active.filter(needsAttention).sort(byRecency),
    active: active.filter((thread) => !needsAttention(thread)).sort(byRecency),
    recent: recentRows
      .filter((thread) => thread?.id && !activeById.has(thread.id))
      .sort(byRecency),
  };
}

function fallbackRuntimeState(thread: CodexThread): DashboardThread["state"] {
  if (needsAttention(thread)) return "needsInput";
  if (thread.status?.type === "active") return "thinking";
  if (thread.status?.type === "systemError") return "error";
  return "idle";
}

function requestReason(request: PendingRequestSummary | undefined): string | undefined {
  if (!request) return undefined;
  if (request.kind === "userInput") {
    return request.summary || t("approval.inputUnavailable");
  }
  return request.summary ? t("approval.summary", { summary: request.summary }) : t("approval.waiting");
}

/**
 * 把历史、当前 Driver 连接状态与插件本地已读状态合成设计稿的四档。
 * 外部历史没有进程内真值，永远不能仅凭更新时间猜成“干完未看”。
 */
export function buildDashboard(
  historyRows: CodexThread[],
  runtimeRows: RuntimeThreadSnapshot[],
  local: LocalThreadState,
  nowMs = Date.now(),
): DashboardGroups {
  const historyById = new Map<string, CodexThread>();
  for (const row of historyRows) {
    if (row?.id) historyById.set(row.id, row);
  }
  const runtimeById = new Map(runtimeRows.filter((row) => row?.threadId).map((row) => [row.threadId, row]));
  const ids = new Set([
    ...historyById.keys(),
    ...runtimeById.keys(),
    ...Object.keys(local.managed),
  ]);

  const result: DashboardGroups = { waiting: [], unseen: [], failed: [], other: [], far: [] };
  for (const id of ids) {
    const history = historyById.get(id);
    const runtime = runtimeById.get(id);
    const managedRecord = local.managed[id];
    const managedByDriver = Boolean(runtime?.managedByDriver || managedRecord);
    const historyMs = history ? recency(history) : 0;
    const liveRecencyAtMs = Math.max(historyMs, finiteTimestamp(runtime?.lastEventMs) ?? 0);
    // createdAt 只负责让「thread/start 成功但首 turn 失败」的孤儿仍能露出来；
    // 一旦 app-server 有历史/事件真值，它不能把最后活动时间凭空写新。
    const recencyAtMs = liveRecencyAtMs || finiteTimestamp(managedRecord?.createdAtMs) || 0;
    // 本地 managed 只证明曾由 Driver 创建，不能证明缺失的 runtime 已经完成。
    // 重启/断连后的历史仍按列表事实展示；终局必须来自明确的运行时记录。
    const state = runtime?.state ?? (history ? fallbackRuntimeState(history) : "idle");
    const pendingRequests = runtime?.pendingRequests ?? [];
    const title = history ? threadTitle(history) : managedRecord?.cwd.split(/[\\/]/).filter(Boolean).at(-1) || id;
    const row: DashboardThread = {
      id,
      cwd: history?.cwd || managedRecord?.cwd || "",
      get title() { return history ? threadTitle(history) : title; },
      preview: cleanPromptText(history?.preview?.trim() || ""),
      recencyAtMs,
      state,
      managedByDriver,
      get waitingReason() { return runtime?.waitingReason || requestReason(pendingRequests[0]); },
      activeTurnId: runtime?.activeTurnId,
      pendingRequests,
      status: state === "needsInput" && managedByDriver
        ? "hot"
        : state === "completed" && managedByDriver && recencyAtMs > (local.seenAtMs[id] ?? 0)
          ? "done"
          : state === "thinking"
            ? "run"
            : state === "error"
              ? "error"
              : "idle",
    };

    if (recencyAtMs > 0 && nowMs - recencyAtMs >= FORTY_EIGHT_HOURS_MS) {
      result.far.push(row);
    } else if (row.status === "hot") {
      result.waiting.push(row);
    } else if (row.status === "done") {
      result.unseen.push(row);
    } else if (row.status === "error") {
      result.failed.push(row);
    } else {
      result.other.push(row);
    }
  }

  result.waiting.sort(newestFirst);
  result.unseen.sort(newestFirst);
  result.failed.sort(newestFirst);
  result.other.sort(newestFirst);
  result.far.sort(newestFirst);
  return result;
}

export interface DesktopOpenAvailability {
  disabled: boolean;
  label: string;
}

/**
 * UI 预检只用于解释当前状态，真正交接仍由 Host 打开路径做权威复核。
 * ownership feature 缺失表示旧 Host 的“未知”，不能按 false 禁用。
 */
export function desktopOpenAvailability(
  target: DashboardThread,
  runtimeRows: RuntimeThreadSnapshot[],
  capability: { handoffFeatureKnown: boolean; handoffAvailable?: boolean },
): DesktopOpenAvailability {
  const hostTarget = runtimeRows.find((thread) => thread.threadId === target.id);
  if (hostTarget?.managedByDriver && (hostTarget.state === "thinking" || hostTarget.state === "needsInput")) {
    return { disabled: true, get label() { return t("handoff.afterCompletion"); } };
  }
  if (hostTarget?.managedByDriver && runtimeRows.some((thread) =>
    thread.threadId !== target.id
    && thread.managedByDriver
    && (thread.state === "thinking" || thread.state === "needsInput")
  )) {
    return { disabled: true, get label() { return t("handoff.otherTasks"); } };
  }
  if (hostTarget?.managedByDriver && capability.handoffFeatureKnown && capability.handoffAvailable === false) {
    return { disabled: true, get label() { return t("handoff.unavailable"); } };
  }
  return { disabled: false, get label() { return t("handoff.open"); } };
}

function cloneLocalState(state: LocalThreadState): LocalThreadState {
  return {
    version: 1,
    managed: Object.fromEntries(
      Object.entries(state.managed).map(([id, record]) => [id, { ...record }]),
    ),
    seenAtMs: { ...state.seenAtMs },
  };
}

export function parseLocalThreadState(raw: unknown): {
  state: LocalThreadState;
  warning?: string;
} {
  if (raw === undefined || raw === null || raw === "") return { state: emptyLocalThreadState() };
  try {
    const value = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!value || typeof value !== "object" || (value as { version?: unknown }).version !== 1) {
      throw new Error("schema version 不是 1");
    }
    const input = value as Partial<LocalThreadState>;
    const state = emptyLocalThreadState();
    if (!input.managed || typeof input.managed !== "object" || !input.seenAtMs || typeof input.seenAtMs !== "object") {
      throw new Error("缺少 managed/seenAtMs");
    }
    for (const [id, record] of Object.entries(input.managed)) {
      if (!record || typeof record !== "object") continue;
      const createdAtMs = finiteTimestamp((record as { createdAtMs?: unknown }).createdAtMs);
      const cwd = (record as { cwd?: unknown }).cwd;
      if (createdAtMs !== undefined && typeof cwd === "string" && cwd.length > 0) {
        state.managed[id] = { createdAtMs, cwd };
      }
    }
    for (const [id, timestamp] of Object.entries(input.seenAtMs)) {
      const seenAtMs = finiteTimestamp(timestamp);
      if (seenAtMs !== undefined) state.seenAtMs[id] = seenAtMs;
    }
    return { state };
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    return { state: emptyLocalThreadState(), warning: `thread-state 已损坏，已安全回空：${detail}` };
  }
}

export function markThreadSeen(
  state: LocalThreadState,
  threadId: string,
  atMs = Date.now(),
): LocalThreadState {
  const next = cloneLocalState(state);
  next.seenAtMs[threadId] = atMs;
  return next;
}

export function markThreadUnseen(state: LocalThreadState, threadId: string): LocalThreadState {
  const next = cloneLocalState(state);
  delete next.seenAtMs[threadId];
  return next;
}

function serializedBytes(state: LocalThreadState): number {
  return new TextEncoder().encode(JSON.stringify(state)).byteLength;
}

export function pruneLocalThreadState(
  input: LocalThreadState,
  nowMs = Date.now(),
  options: {
    maxAgeMs?: number;
    maxThreadRecords?: number;
    maxBytes?: number;
  } = {},
): LocalThreadState {
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_LOCAL_MAX_AGE_MS;
  const maxThreadRecords = options.maxThreadRecords ?? DEFAULT_LOCAL_MAX_RECORDS;
  const maxBytes = options.maxBytes ?? DEFAULT_LOCAL_MAX_BYTES;
  const state = cloneLocalState(input);
  const ids = new Set([...Object.keys(state.managed), ...Object.keys(state.seenAtMs)]);
  const touchedAt = (id: string) => Math.max(
    state.managed[id]?.createdAtMs ?? 0,
    state.seenAtMs[id] ?? 0,
  );
  const remove = (id: string) => {
    delete state.managed[id];
    delete state.seenAtMs[id];
  };

  for (const id of ids) {
    const timestamp = touchedAt(id);
    if (timestamp > 0 && nowMs - timestamp > maxAgeMs) remove(id);
  }

  const newestIds = [...new Set([...Object.keys(state.managed), ...Object.keys(state.seenAtMs)])]
    .sort((left, right) => touchedAt(right) - touchedAt(left) || left.localeCompare(right));
  for (const id of newestIds.slice(Math.max(0, maxThreadRecords))) remove(id);

  const oldestIds = [...new Set([...Object.keys(state.managed), ...Object.keys(state.seenAtMs)])]
    .sort((left, right) => touchedAt(left) - touchedAt(right) || left.localeCompare(right));
  while (serializedBytes(state) > maxBytes && oldestIds.length > 0) {
    remove(oldestIds.shift()!);
  }
  if (serializedBytes(state) > maxBytes) {
    throw new CodexMessageError("errors.localBudget");
  }
  return state;
}

export type ApprovalTargetResult =
  | { ok: true; serverRequestId: number }
  | { ok: false; code: "NOT_FOUND" | "AMBIGUOUS"; message: string };

export function resolveApprovalTarget(
  pending: PendingRequestSummary[],
  selectedThreadId?: string,
): ApprovalTargetResult {
  const approvals = pending.filter((request): request is PendingRequestSummary & { serverRequestId: number } =>
    request.kind !== "userInput" && Number.isSafeInteger(request.serverRequestId)
  );
  const candidates = selectedThreadId
    ? approvals.filter((request) => request.threadId === selectedThreadId)
    : approvals;
  if (candidates.length === 1) return { ok: true, serverRequestId: candidates[0]!.serverRequestId };
  if (candidates.length === 0) {
    return { ok: false, code: "NOT_FOUND", message: t("errors.noApproval") };
  }
  return {
    ok: false,
    code: "AMBIGUOUS",
    message: selectedThreadId ? t("errors.multipleTaskApprovals") : t("errors.multipleApprovals"),
  };
}

export interface SkillReference {
  name: string;
  path: string;
}

export type SkillAction =
  | { method: "codex.start_turn"; params: { threadId: string; input: Array<{ type: "skill"; name: string; path: string }> } }
  | { method: "codex.steer_turn"; params: { threadId: string; expectedTurnId: string; input: Array<{ type: "skill"; name: string; path: string }> } };

export function routeSkillAction(thread: RuntimeThreadSnapshot, skill: SkillReference): SkillAction {
  const input = [{ type: "skill" as const, name: skill.name, path: skill.path }];
  if (thread.state === "needsInput") throw new CodexMessageError("errors.skillWhileWaiting");
  if (thread.state === "thinking") {
    if (!thread.activeTurnId) throw new CodexMessageError("errors.missingActiveTurn");
    return {
      method: "codex.steer_turn",
      params: { threadId: thread.threadId, expectedTurnId: thread.activeTurnId, input },
    };
  }
  return { method: "codex.start_turn", params: { threadId: thread.threadId, input } };
}

/** Bridge 会抛结构化对象；禁止用 String(object) 把诊断信息压成 [object Object]。 */
export function formatCodexError(cause: unknown): string {
  if (cause instanceof Error && "getLocalizedMessage" in cause && typeof cause.getLocalizedMessage === "function") return cause.getLocalizedMessage();
  if (cause instanceof Error && cause.message.trim()) return cause.message.trim();
  if (typeof cause === "string" && cause.trim()) return cause.trim();
  if (cause && typeof cause === "object") {
    const value = cause as Record<string, unknown>;
    const code = typeof value.code === "string" ? value.code.trim() : "";
    const message = [value.userMessage, value.message, value.diagnostic]
      .find((candidate) => typeof candidate === "string" && candidate.trim()) as string | undefined;
    if (code && message) return code + " · " + message.trim();
    if (message) return message.trim();
    if (code) return code;
    try {
      const rendered = JSON.stringify(value);
      if (rendered && rendered !== "{}") return rendered;
    } catch {
      // 继续使用稳定兜底，不让错误格式化本身抛异常。
    }
  }
  return t("errors.unknown");
}

/**
 * 展示用文本的收尾净化：只剥自动化流程写进提示词的 `<task>` 信封标记。
 * 标题和摘要直接面对用户，开头一截尖括号标记是无意义噪音；其余尖括号内容
 * 一律不动——这一页对 Codex 文本的防线是「永远按纯文本渲染」，不是替用户改写。
 */
export function cleanPromptText(text: string): string {
  return text
    .replace(/<\/?task>/gi, "")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .trim();
}

export function threadTitle(thread: CodexThread): string {
  const explicit = thread.name?.trim();
  if (explicit) return explicit;
  const preview = cleanPromptText(thread.preview ?? "").split("\n", 1)[0];
  if (preview) {
    const characters = Array.from(preview);
    return characters.length > 72 ? characters.slice(0, 71).join("") + "…" : preview;
  }
  return thread.cwd?.split(/[\\/]/).filter(Boolean).at(-1) || t("task.untitled");
}

export function formatRelativeTime(timestampMs: number, nowMs = Date.now()): string {
  if (!timestampMs) return t("time.unknown");
  const minutes = Math.max(0, Math.floor((nowMs - timestampMs) / 60_000));
  if (minutes < 1) return t("time.now");
  if (minutes < 60) return minutes === 1 ? t("time.minute") : t("time.minutes", { count: minutes });
  if (minutes < 1_440) return minutes < 120 ? t("time.hour") : t("time.hours", { count: Math.floor(minutes / 60) });
  return minutes < 2_880 ? t("time.day") : t("time.days", { count: Math.floor(minutes / 1_440) });
}
