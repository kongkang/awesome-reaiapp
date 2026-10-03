import type { StreamItem } from "@reai/agent-ui";

export type AnalysisStatus = "idle" | "queued" | "processing" | "resolved" | "needs-input";
export type SuggestionStatus = "pending" | "accepted" | "dismissed";
export type ConversationKey = "app" | `task:${string}`;

export interface TodoAnalysis {
  status: AnalysisStatus;
  summary?: string;
  updatedAt?: string;
}

export interface TodoReminder {
  enabled: boolean;
  at?: string;
}

export interface TodoConflict {
  withTaskId?: string;
  reason: string;
}

export interface TodoRecurrence {
  frequency: "daily" | "weekly";
  interval: number;
  startDate: string;
  endDate?: string;
  weekdays?: number[];
  completedDates: string[];
  stoppedAt?: string;
}

export interface TodoNode {
  id: string;
  title: string;
  parentId?: string;
  done: boolean;
  createdAt: string;
  updatedAt: string;
  scheduledDate?: string;
  startAt?: string;
  endAt?: string;
  deadlineAt?: string;
  people: string[];
  location?: string;
  importance: number;
  reminder: TodoReminder;
  conflicts: TodoConflict[];
  recurrence?: TodoRecurrence;
  analysis: TodoAnalysis;
}

export interface ProposedTodoNode {
  title: string;
  scheduledDate?: string;
  startAt?: string;
  endAt?: string;
  deadlineAt?: string;
  importance?: number;
  people?: string[];
  location?: string;
}

export interface TodoSuggestion {
  id: string;
  taskId: string;
  kind: "subtask" | "field" | "complete-parent";
  title: string;
  detail: string;
  confidence: number;
  status: SuggestionStatus;
  proposedNode?: ProposedTodoNode;
  proposedPatch?: Partial<Pick<TodoNode, "scheduledDate" | "startAt" | "endAt" | "deadlineAt" | "location" | "people" | "importance" | "reminder">>;
  createdAt: string;
  decidedAt?: string;
}

/**
 * 这里没有 notifications 字段，是刻意的（V1.3 / 合同 §5）。
 * 「有事要你处理」是全平台共有的语义，呈现权归 Host 的全局通知中心；App 只负责
 * 产生事件并署名。在 App 里再存一份账本，迟早会和 Host 那份对不上。
 */
export interface TodoState {
  version: 2;
  nodes: TodoNode[];
  suggestions: TodoSuggestion[];
  conversations: Partial<Record<ConversationKey, StreamItem[]>>;
  processedEventIds: string[];
}

export type TodoNodePatch = Partial<Pick<TodoNode,
  "title" | "done" | "scheduledDate" | "startAt" | "endAt" | "deadlineAt" |
  "people" | "location" | "importance" | "reminder" | "conflicts" | "recurrence" | "analysis"
>>;

export type TodoPushEnvelope =
  | {
      kind: "data_update";
      eventId: string;
      taskId: string;
      patch: TodoNodePatch;
      suggestions?: TodoSuggestion[];
    }
  | {
      kind: "user_notification";
      eventId: string;
      taskId?: string;
      title: string;
      body: string;
    }
  | {
      kind: "client_action";
      eventId: string;
      action: "start_voice_conversation";
      payload?: { conversationKey?: ConversationKey };
    };

export interface TodoDisplayItem {
  node: TodoNode;
  dateKey: string;
  done: boolean;
  occurrenceId?: string;
}

export interface TodoOccurrence {
  occurrenceId: string;
  nodeId: string;
  dateKey: string;
  done: boolean;
}

type CreateTodoNodeInput = Omit<Partial<TodoNode>, "createdAt" | "updatedAt" | "analysis" | "reminder" | "people" | "conflicts"> & {
  id: string;
  title: string;
  now: Date;
  analysis?: TodoAnalysis;
  reminder?: TodoReminder;
  people?: string[];
  conflicts?: TodoConflict[];
};

const MAX_PROCESSED_EVENTS = 200;

export function createEmptyTodoState(): TodoState {
  return {
    version: 2,
    nodes: [],
    suggestions: [],
    conversations: {},
    processedEventIds: [],
  };
}

export function createTodoNode(input: CreateTodoNodeInput): TodoNode {
  const timestamp = input.now.toISOString();
  return {
    id: input.id,
    title: input.title,
    ...(input.parentId ? { parentId: input.parentId } : {}),
    done: input.done ?? false,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...(input.scheduledDate ? { scheduledDate: input.scheduledDate } : {}),
    ...(input.startAt ? { startAt: input.startAt } : {}),
    ...(input.endAt ? { endAt: input.endAt } : {}),
    ...(input.deadlineAt ? { deadlineAt: input.deadlineAt } : {}),
    people: [...(input.people ?? [])],
    ...(input.location ? { location: input.location } : {}),
    importance: input.importance ?? 50,
    reminder: input.reminder ? { ...input.reminder } : { enabled: false },
    conflicts: [...(input.conflicts ?? [])],
    ...(input.recurrence ? {
      recurrence: {
        ...input.recurrence,
        completedDates: [...input.recurrence.completedDates],
        ...(input.recurrence.weekdays ? { weekdays: [...input.recurrence.weekdays] } : {}),
      },
    } : {}),
    analysis: input.analysis ? { ...input.analysis } : { status: "resolved" },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeNode(value: unknown, now: Date): TodoNode | undefined {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.title !== "string") return undefined;
  const createdAt = typeof value.createdAt === "string" ? value.createdAt : now.toISOString();
  const normalized = createTodoNode({
    ...(value as Partial<TodoNode>),
    id: value.id,
    title: value.title,
    now: new Date(createdAt),
    done: value.done === true,
    analysis: isRecord(value.analysis) && typeof value.analysis.status === "string"
      ? value.analysis as unknown as TodoAnalysis
      : { status: "resolved" },
    people: Array.isArray(value.people) ? value.people.filter((person): person is string => typeof person === "string") : [],
    conflicts: Array.isArray(value.conflicts) ? value.conflicts.filter(isRecord).map((entry) => ({
      ...(typeof entry.withTaskId === "string" ? { withTaskId: entry.withTaskId } : {}),
      reason: typeof entry.reason === "string" ? entry.reason : "时间可能冲突",
    })) : [],
    reminder: isRecord(value.reminder) ? {
      enabled: value.reminder.enabled === true,
      ...(typeof value.reminder.at === "string" ? { at: value.reminder.at } : {}),
    } : { enabled: false },
  });
  return {
    ...normalized,
    createdAt,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : createdAt,
  };
}

export function migrateTodoState(value: unknown, now = new Date()): TodoState {
  if (Array.isArray(value)) {
    return {
      ...createEmptyTodoState(),
      nodes: value.map((entry) => normalizeNode(entry, now)).filter((node): node is TodoNode => Boolean(node)),
    };
  }
  if (!isRecord(value) || value.version !== 2) return createEmptyTodoState();
  return {
    version: 2,
    nodes: Array.isArray(value.nodes)
      ? value.nodes.map((entry) => normalizeNode(entry, now)).filter((node): node is TodoNode => Boolean(node))
      : [],
    suggestions: Array.isArray(value.suggestions)
      ? value.suggestions.filter(isRecord).filter((entry) => typeof entry.id === "string" && typeof entry.taskId === "string") as unknown as TodoSuggestion[]
      : [],
    conversations: isRecord(value.conversations) ? value.conversations as TodoState["conversations"] : {},
    // 旧存档里的 notifications 在这里被丢掉：账本已经归 Host，不再往 App 状态里搬。
    processedEventIds: Array.isArray(value.processedEventIds)
      ? value.processedEventIds.filter((id): id is string => typeof id === "string").slice(-MAX_PROCESSED_EVENTS)
      : [],
  };
}

export function localDateKey(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function parseLocalDateKey(value: string): Date {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year ?? 1970, (month ?? 1) - 1, day ?? 1, 12, 0, 0, 0);
}

export function addLocalDays(dateKey: string, days: number): string {
  const date = parseLocalDateKey(dateKey);
  date.setDate(date.getDate() + days);
  return localDateKey(date);
}

export function childrenOf(state: TodoState, parentId: string): TodoNode[] {
  return state.nodes.filter((node) => node.parentId === parentId);
}

export function addChildNode(
  state: TodoState,
  parentId: string,
  input: Omit<CreateTodoNodeInput, "parentId">,
): TodoState {
  const node = createTodoNode({ ...input, parentId });
  return { ...state, nodes: [...state.nodes, node] };
}

function daysBetween(from: string, to: string): number {
  return Math.round((parseLocalDateKey(to).getTime() - parseLocalDateKey(from).getTime()) / 86_400_000);
}

export function occurrenceForDate(node: TodoNode, dateKey: string): TodoOccurrence | undefined {
  const recurrence = node.recurrence;
  if (!recurrence || recurrence.stoppedAt) return undefined;
  if (dateKey < recurrence.startDate || (recurrence.endDate && dateKey > recurrence.endDate)) return undefined;
  const elapsed = daysBetween(recurrence.startDate, dateKey);
  if (elapsed < 0) return undefined;
  if (recurrence.frequency === "daily" && elapsed % Math.max(1, recurrence.interval) !== 0) return undefined;
  if (recurrence.frequency === "weekly") {
    const weekIndex = Math.floor(elapsed / 7);
    if (weekIndex % Math.max(1, recurrence.interval) !== 0) return undefined;
    const weekday = parseLocalDateKey(dateKey).getDay();
    const weekdays = recurrence.weekdays?.length ? recurrence.weekdays : [parseLocalDateKey(recurrence.startDate).getDay()];
    if (!weekdays.includes(weekday)) return undefined;
  }
  return {
    occurrenceId: `${node.id}@${dateKey}`,
    nodeId: node.id,
    dateKey,
    done: recurrence.completedDates.includes(dateKey),
  };
}

function scheduledDateOf(node: TodoNode): string | undefined {
  if (node.startAt) return localDateKey(new Date(node.startAt));
  if (node.scheduledDate) return node.scheduledDate;
  if (node.deadlineAt) return localDateKey(new Date(node.deadlineAt));
  return undefined;
}

export function timelineForDate(state: TodoState, dateKey: string, _now = new Date()): TodoDisplayItem[] {
  const items: TodoDisplayItem[] = [];
  for (const node of state.nodes) {
    if (node.recurrence) {
      const occurrence = occurrenceForDate(node, dateKey);
      if (occurrence) items.push({ node, dateKey, done: occurrence.done, occurrenceId: occurrence.occurrenceId });
      continue;
    }
    if (scheduledDateOf(node) === dateKey) items.push({ node, dateKey, done: node.done });
  }
  return items.sort((left, right) => {
    const leftFixed = Boolean(left.node.startAt);
    const rightFixed = Boolean(right.node.startAt);
    if (leftFixed !== rightFixed) return leftFixed ? -1 : 1;
    if (leftFixed && rightFixed) return new Date(left.node.startAt!).getTime() - new Date(right.node.startAt!).getTime();
    return right.node.importance - left.node.importance || left.node.createdAt.localeCompare(right.node.createdAt);
  });
}

export function undatedNodes(state: TodoState): TodoNode[] {
  return state.nodes
    .filter((node) => !node.parentId && !node.recurrence && !node.scheduledDate && !node.startAt && !node.deadlineAt)
    .sort((left, right) => right.importance - left.importance || left.createdAt.localeCompare(right.createdAt));
}

export function overdueNodes(state: TodoState, now = new Date()): TodoNode[] {
  const today = localDateKey(now);
  return state.nodes.filter((node) => {
    if (node.done || node.parentId || node.recurrence) return false;
    if (node.deadlineAt) return new Date(node.deadlineAt).getTime() < now.getTime();
    const date = node.startAt ? localDateKey(new Date(node.startAt)) : node.scheduledDate;
    return Boolean(date && date < today);
  }).sort((left, right) => (left.deadlineAt ?? left.startAt ?? left.scheduledDate ?? "").localeCompare(right.deadlineAt ?? right.startAt ?? right.scheduledDate ?? ""));
}

export function futureDateKeys(state: TodoState, today: string): string[] {
  const keys = new Set<string>();
  for (const node of state.nodes) {
    const key = scheduledDateOf(node);
    if (key && key > today) keys.add(key);
  }
  return [...keys].sort();
}

export function markOccurrence(state: TodoState, nodeId: string, dateKey: string, done: boolean, now: Date): TodoState {
  return {
    ...state,
    nodes: state.nodes.map((node) => {
      if (node.id !== nodeId || !node.recurrence) return node;
      const dates = new Set(node.recurrence.completedDates);
      if (done) dates.add(dateKey); else dates.delete(dateKey);
      return {
        ...node,
        updatedAt: now.toISOString(),
        recurrence: { ...node.recurrence, completedDates: [...dates].sort() },
      };
    }),
  };
}

export function updateNode(state: TodoState, nodeId: string, patch: TodoNodePatch, now: Date): TodoState {
  return {
    ...state,
    nodes: state.nodes.map((node) => node.id === nodeId ? {
      ...node,
      ...patch,
      updatedAt: now.toISOString(),
      ...(patch.people ? { people: [...patch.people] } : {}),
      ...(patch.conflicts ? { conflicts: [...patch.conflicts] } : {}),
    } : node),
  };
}

export function acceptSuggestion(
  state: TodoState,
  suggestionId: string,
  now: Date,
  idFactory: () => string = () => crypto.randomUUID(),
): TodoState {
  const suggestion = state.suggestions.find((candidate) => candidate.id === suggestionId);
  if (!suggestion || suggestion.status !== "pending") return state;
  let next = {
    ...state,
    suggestions: state.suggestions.map((candidate) => candidate.id === suggestionId
      ? { ...candidate, status: "accepted" as const, decidedAt: now.toISOString() }
      : candidate),
  };
  if (suggestion.kind === "subtask" && suggestion.proposedNode) {
    next = addChildNode(next, suggestion.taskId, {
      id: idFactory(),
      now,
      analysis: { status: "resolved", summary: "由日程助理建议并经用户确认" },
      ...suggestion.proposedNode,
    });
  } else if (suggestion.kind === "field" && suggestion.proposedPatch) {
    next = updateNode(next, suggestion.taskId, suggestion.proposedPatch, now);
  } else if (suggestion.kind === "complete-parent") {
    next = updateNode(next, suggestion.taskId, { done: true }, now);
  }
  return next;
}

export function dismissSuggestion(state: TodoState, suggestionId: string, now: Date): TodoState {
  return {
    ...state,
    suggestions: state.suggestions.map((candidate) => candidate.id === suggestionId && candidate.status === "pending"
      ? { ...candidate, status: "dismissed", decidedAt: now.toISOString() }
      : candidate),
  };
}

function rememberEvent(processedEventIds: string[], eventId: string): string[] {
  return [...processedEventIds, eventId].slice(-MAX_PROCESSED_EVENTS);
}

export function applyPushEnvelope(state: TodoState, envelope: TodoPushEnvelope, now = new Date()): TodoState {
  if (state.processedEventIds.includes(envelope.eventId)) return state;
  const processedEventIds = rememberEvent(state.processedEventIds, envelope.eventId);
  if (envelope.kind === "client_action") return { ...state, processedEventIds };
  if (envelope.kind === "user_notification") {
    /**
     * 呈现权归 Host（合同 §5）：App 记下 eventId 保证幂等，不在本地累积通知。
     * 当前 host-support-matrix 还没有「插件 → Host 全局通知」这条能力，
     * 所以这一档暂时没有落点——但落点缺失不构成在 App 里重开一个铃铛的理由。
     * App 自己这一侧的出声方式是「助理需要补信息时自己拉开来问」，
     * 由 needs-input 的状态跃迁驱动，见 todo-view 的 aside 追问。
     */
    return { ...state, processedEventIds };
  }
  const updated = updateNode(state, envelope.taskId, envelope.patch, now);
  const existing = new Set(updated.suggestions.map((suggestion) => suggestion.id));
  return {
    ...updated,
    processedEventIds,
    suggestions: [
      ...updated.suggestions,
      ...(envelope.suggestions ?? []).filter((suggestion) => !existing.has(suggestion.id)),
    ],
  };
}

export function pendingSuggestions(state: TodoState, taskId: string): TodoSuggestion[] {
  return state.suggestions
    .filter((suggestion) => suggestion.taskId === taskId && suggestion.status === "pending")
    .sort((left, right) => right.confidence - left.confidence || left.createdAt.localeCompare(right.createdAt));
}

export function allChildrenDone(state: TodoState, taskId: string): boolean {
  const children = childrenOf(state, taskId);
  return children.length > 0 && children.every((child) => child.done);
}

export function conversationKeyForTask(taskId?: string): ConversationKey {
  return taskId ? `task:${taskId}` : "app";
}
