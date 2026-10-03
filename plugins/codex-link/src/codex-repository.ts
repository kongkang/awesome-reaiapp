import { t, readText, type TextSource, CodexMessageError } from "./codex-i18n";
import { accountSnapshot, type CodexAccount, type CodexAccountResponse } from "./codex-account";
import type { KeyValueStore } from "@reai/app-sdk/v1";
import type { CodexMethod } from "./codex-bridge";

/** Existing local state adapters expose basic KV methods, not Host 1.20 CAS. */
export type CodexStore = Pick<KeyValueStore, "get" | "set" | "delete" | "keys">;
import {
  buildDashboard,
  formatCodexError,
  emptyLocalThreadState,
  markThreadSeen,
  markThreadUnseen,
  parseLocalThreadState,
  pruneLocalThreadState,
  parseDesktopObservationState,
  type DesktopObservationState,
  type CodexThread,
  type DashboardGroups,
  type LocalThreadState,
  type RuntimeThreadSnapshot,
} from "./codex-model";

/** F06 新数据只用独立键；旧 state/compose-defaults 和 manifest 不变。 */
export const DESKTOP_OBSERVATION_KEY = "desktop-observation-v1";

export class DesktopObservationStorage {
  #store: CodexStore;
  #loaded?: Promise<void>;
  #state: DesktopObservationState = { version: 1, records: [] };
  #writable = false;
  #writes: Promise<void> = Promise.resolve();

  constructor(store: CodexStore) {
    this.#store = store;
  }

  async load(): Promise<{ state: DesktopObservationState; writable: boolean }> {
    if (!this.#loaded) {
      this.#loaded = this.#store.get(DESKTOP_OBSERVATION_KEY).then((raw) => {
        const parsed = parseDesktopObservationState(raw);
        this.#state = parsed.state;
        this.#writable = parsed.writable;
      }).catch((error) => {
        this.#loaded = undefined; // 读取故障可重试；格式未知不覆盖原值。
        throw error;
      });
    }
    await this.#loaded;
    return { state: parseDesktopObservationState(this.#state).state, writable: this.#writable };
  }

  save(next: DesktopObservationState): Promise<void> {
    // 捕获调用时的副本，排队期间调用方修改对象不能改变提交内容。
    const parsed = parseDesktopObservationState(next);
    const operation = this.#writes.then(async () => {
      await this.load();
      if (!this.#writable) throw new CodexMessageError("errors.desktopStore");
      if (!parsed.writable) throw new CodexMessageError("errors.desktopState");
      await this.#store.set(DESKTOP_OBSERVATION_KEY, parsed.state);
      this.#state = parsed.state; // 写失败不推进内存中的持久水位。
    });
    this.#writes = operation.catch(() => {});
    return operation;
  }
}

export interface DesktopThreadPage {
  data: CodexThread[];
  nextCursor?: string | null;
}

function checkedThreadPage(value: DesktopThreadPage): DesktopThreadPage {
  if (!value || !Array.isArray(value.data)
    || value.data.some(row => !row || typeof row.id !== "string" || !row.id)
    || (value.nextCursor != null && typeof value.nextCursor !== "string")) {
    throw new CodexMessageError("errors.historyInvalid");
  }
  return value;
}

export interface DesktopThreadPages {
  threads: CodexThread[];
  /** 仅表示注入分页遍历完整；不证明底层数据源健康或原生会话全覆盖。 */
  complete: boolean;
  /** 部分页重取时从此页开始；不能跳过尚未消费的行。null表示第一页。 */
  resumeCursor: string | null;
  reason?: "cancelled" | "timeout" | "page-limit" | "row-limit" | "cursor-cycle" | "invalid-page" | "read-failed";
}

function abortedOperation(): Error {
  const error = new CodexMessageError("errors.cancelled");
  error.name = "AbortError";
  return error;
}

/** provider 忽略 signal 时，调用方也能及时结束并丢弃晚到结果。 */
function abortableOperation<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(abortedOperation());
    if (signal.aborted) return abort();
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve().then(() => {
      if (signal.aborted) throw abortedOperation();
      return operation();
    }).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/**
 * 内部可取消分页；fetchPage由将来已核实范围/版本/无repair语义的adapter提供。
 * 此函数不绑定任何RPC，不会为观察启动/恢复/退订用户会话。
 */
export async function collectDesktopThreadPages(
  fetchPage: (cursor: string | null, signal: AbortSignal) => Promise<DesktopThreadPage>,
  options: { cursor?: string; signal?: AbortSignal; maxPages?: number; maxRows?: number; timeoutMs?: number } = {},
): Promise<DesktopThreadPages> {
  const maxPages = options.maxPages ?? 20;
  const maxRows = options.maxRows ?? 1_000;
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (![maxPages, maxRows, timeoutMs].every((value) => Number.isSafeInteger(value) && value > 0)
    || timeoutMs > 2_147_483_647) throw new CodexMessageError("errors.invalidPageBudget");
  const controller = new AbortController();
  let timedOut = false;
  const deadline = Date.now() + timeoutMs;
  const pastDeadline = () => {
    if (!controller.signal.aborted && Date.now() >= deadline) {
      timedOut = true;
      controller.abort();
    }
    return timedOut;
  };
  const cancel = () => controller.abort();
  options.signal?.addEventListener("abort", cancel, { once: true });
  if (options.signal?.aborted) controller.abort();
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  const rows = new Map<string, CodexThread>();
  const cursors = new Set<string | null>();
  let cursor: string | null = options.cursor ?? null;
  const partial = (reason: DesktopThreadPages["reason"]): DesktopThreadPages => ({
    threads: [...rows.values()], complete: false, resumeCursor: cursor, reason,
  });
  try {
    for (let pageIndex = 0; pageIndex < maxPages; pageIndex++) {
      if (pastDeadline() || controller.signal.aborted) return partial(timedOut ? "timeout" : "cancelled");
      if (cursors.has(cursor)) return partial("cursor-cycle");
      cursors.add(cursor);
      let page: DesktopThreadPage;
      try {
        page = await abortableOperation(() => fetchPage(cursor, controller.signal), controller.signal);
      } catch {
        return partial(controller.signal.aborted ? timedOut ? "timeout" : "cancelled" : "read-failed");
      }
      if (pastDeadline() || controller.signal.aborted) return partial(timedOut ? "timeout" : "cancelled");
      if (!page || !Array.isArray(page.data)
        || (page.nextCursor != null && (typeof page.nextCursor !== "string" || !page.nextCursor))) {
        return partial("invalid-page");
      }
      for (const row of page.data) {
        if (pastDeadline() || controller.signal.aborted) return partial(timedOut ? "timeout" : "cancelled");
        if (!row || typeof row.id !== "string" || !row.id) return partial("invalid-page");
        if (!rows.has(row.id)) {
          if (rows.size >= maxRows) return partial("row-limit");
          rows.set(row.id, { ...row });
        }
      }
      if (pastDeadline() || controller.signal.aborted) return partial(timedOut ? "timeout" : "cancelled");
      if (page.nextCursor == null) {
        return { threads: [...rows.values()], complete: true, resumeCursor: null };
      }
      cursor = page.nextCursor; // 空data但有cursor仍继续。
    }
    return partial("page-limit");
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", cancel);
  }
}

export interface DesktopDraftTarget {
  sourceId: string;
  epoch: string;
  mode: "new" | "continue";
  threadId?: string;
  draftId?: string;
}

export interface DesktopOperationContext {
  requestId: string;
  generation: number;
  target: Readonly<DesktopDraftTarget>;
  signal: AbortSignal;
}

export type DesktopOperationStatus =
  | "applied" | "cancelled" | "timeout" | "duplicate" | "unavailable" | "rejected" | "failed";

export interface DesktopOperationResult {
  status: DesktopOperationStatus;
  issue?: "request-budget";
}

export interface DesktopTextPort {
  /** 内部adapter端口，不是F04真实service的名称/参数合同。 */
  requestText(context: DesktopOperationContext): Promise<{ requestId: string; text: string }>;
}

function validDesktopTarget(target: DesktopDraftTarget): boolean {
  const id = (value: unknown) => typeof value === "string" && value.length > 0 && value.length <= 1_024;
  return id(target.sourceId) && id(target.epoch)
    && (target.mode === "new" || target.mode === "continue")
    && (target.mode !== "new" || target.threadId === undefined)
    && (target.mode !== "continue" || id(target.threadId))
    && (target.threadId === undefined || id(target.threadId))
    && (target.draftId === undefined || id(target.draftId));
}

/**
 * 插件内目标事务；只在操作结果和目标代次仍一致时同步消费一次。
 * 不提供默认Desktop/F04实现，不负责发送、审批或中断任何Codex回合。
 */
export class DesktopTargetOperations {
  #target?: Readonly<DesktopDraftTarget>;
  #generation = 0;
  #active?: AbortController;
  #requestIds = new Set<string>();
  #disposed = false;

  select(target?: DesktopDraftTarget): boolean {
    if (this.#disposed || (target !== undefined && !validDesktopTarget(target))) return false;
    const next = target
      ? { sourceId: target.sourceId, epoch: target.epoch, mode: target.mode,
        threadId: target.threadId, draftId: target.draftId }
      : undefined;
    if (JSON.stringify(next) === JSON.stringify(this.#target)) return true;
    this.cancel();
    this.#target = next ? Object.freeze(next) : undefined;
    return true;
  }

  cancel(): void {
    this.#generation++;
    this.#active?.abort();
    this.#active = undefined;
  }

  dispose(): void {
    this.cancel();
    this.#target = undefined;
    this.#disposed = true;
  }

  async run<T>(
    requestId: string,
    operation: (context: DesktopOperationContext) => Promise<T>,
    /** 消费应同步提交到已校验的目标；异步目标写入仍需provider自己的原子目标合同。 */
    consume: (value: T, context: DesktopOperationContext) => boolean,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<DesktopOperationResult> {
    if (this.#disposed || !this.#target) return { status: "unavailable" };
    if (!requestId || requestId.length > 1_024) return { status: "rejected" };
    if (this.#requestIds.has(requestId)) return { status: "duplicate" };
    // 不淘汰旧ID后重新消费；当前激活生命周期超预算时保持明确不可用。
    if (this.#requestIds.size >= 4_096) return { status: "unavailable", issue: "request-budget" };
    const timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
      return { status: "rejected" };
    }
    this.cancel(); // 新请求取代旧请求，不结束任何原生回合。
    this.#requestIds.add(requestId);
    const controller = new AbortController();
    this.#active = controller;
    const context: DesktopOperationContext = Object.freeze({
      requestId, generation: this.#generation, target: this.#target, signal: controller.signal,
    });
    let timedOut = false;
    const deadline = Date.now() + timeoutMs;
    const cancel = () => controller.abort();
    options.signal?.addEventListener("abort", cancel, { once: true });
    if (options.signal?.aborted) controller.abort();
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    const current = () => !this.#disposed && !controller.signal.aborted
      && this.#active === controller && this.#generation === context.generation
      && this.#target === context.target;
    try {
      const value = await abortableOperation(() => {
        if (!current()) throw abortedOperation();
        return operation(context);
      }, controller.signal);
      if (timedOut || Date.now() >= deadline) return { status: "timeout" };
      if (!current()) return { status: "cancelled" };
      // 同一个JS任务内检查并消费；await后的晚到/换目标不得到达这里。
      return { status: consume(value, context) === true ? "applied" : "rejected" };
    } catch {
      return { status: timedOut ? "timeout" : controller.signal.aborted ? "cancelled" : "failed" };
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", cancel);
      if (this.#active === controller) this.#active = undefined;
    }
  }

  async requestText(
    requestId: string,
    port: DesktopTextPort | undefined,
    consumeText: (text: string, context: DesktopOperationContext) => boolean,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<DesktopOperationResult> {
    if (!port) return { status: "unavailable" };
    return this.run(requestId, (context) => port.requestText(context), (response, context) => {
      if (!response || response.requestId !== context.requestId || typeof response.text !== "string"
        || !response.text.trim() || response.text.length > 64_000) return false;
      return consumeText(response.text, context);
    }, options);
  }
}

export type CodexCall = <T = unknown>(method: CodexMethod | string, params?: unknown) => Promise<T>;

export interface CodexStatus {
  connected: boolean;
  version?: string | null;
  threadCount: number;
  lastError?: string | null;
  lastErrorCode?: string | null;
  features?: string[] | Record<string, boolean>;
  desktopHandoffAvailable?: boolean;
  threads?: RuntimeThreadSnapshot[];
}

export interface TaskReasoningEffort {
  id: string;
  description?: string;
}

export interface TaskModel {
  id: string;
  displayName: string;
  isDefault: boolean;
  defaultEffort?: string;
  efforts: TaskReasoningEffort[];
}

export interface StartTaskOptions {
  cwd: string;
  text?: string;
  /**
   * 随这次对话一起带上的 Skill。
   *
   * 两条路都用它：拨杆档位预设指定的 Skill（C-1），以及 Action 层挂上来的 Skill
   * 被按下时（C-3b）。Host 的 turn 窄口本来就收 `{type:"skill", name, path}`
   * 这种输入行，所以不是新开通道、只是多发一行；路径必须是绝对路径（Host 会再
   * 校验一次）。
   *
   * 与 `text` 可以同时给（先 skill 后正文）；两个都空则不成立——起一个没有任何
   * 输入的回合，Codex 那边只会干等。
   */
  skill?: { name: string; path: string };
  model?: string;
  effort?: string;
  threadId?: string;
  clientUserMessageId?: string;
}

export type TaskCreationOutcome = "turn-failed" | "unknown";

export class TaskCreationError extends Error {
  constructor(
    private readonly displayMessage: TextSource,
    public readonly outcome: TaskCreationOutcome,
    public readonly threadId: string | undefined,
    public readonly clientUserMessageId: string,
    options?: ErrorOptions,
  ) {
    super(options?.cause === undefined ? readText(displayMessage) : `${readText(displayMessage)} · ${formatCodexError(options.cause)}`, options);
    this.name = "TaskCreationError";
  }
  getLocalizedMessage(): string {
    const message = readText(this.displayMessage);
    return this.cause === undefined ? message : `${message} · ${formatCodexError(this.cause)}`;
  }
}

export interface SkillMetadata {
  name: string;
  description?: string;
  shortDescription?: string | null;
  path: string;
  enabled?: boolean;
}

export interface SkillsListEntry {
  cwd: string;
  skills: SkillMetadata[];
  errors?: Array<{ path: string; message: string }>;
}

export interface CodexRepositorySnapshot {
  status: CodexStatus;
  dashboard: DashboardGroups;
  runtimeThreads: RuntimeThreadSnapshot[];
  skills: SkillsListEntry[];
  skillsCwd?: string;
  skillsError?: string;
  skillsErrorKind?: "read-failed";
  account?: CodexAccount;
  hasMoreThreads?: boolean;
  compatibility: { readOnly: boolean; message?: string };
}

/** 新任务表单上次用过的取值，只存下游窄口真收的三项。 */
export interface ComposeDefaults {
  cwd?: string;
  model?: string;
  effort?: string;
}

interface RepositoryOptions {
  now?: () => number;
  onStorageWarning?: (message: string) => void;
}

const STATE_KEY = "state";
/**
 * 与会话状态分开一个**键**（仍在 manifest 声明的同一个 `thread-state` 私有 store 里）：
 * 它们的生命周期无关，混在一条记录里会互相拖着做迁移。
 * 将来若要给 `thread-state` 升 schemaVersion，记得表单默认值不该被裹进那次迁移——
 * 到时候把它挪成独立 store（manifest 是多条车道的热区，挪的时候注意撞车）。
 */
const COMPOSE_DEFAULTS_KEY = "compose-defaults";
/** 存盘内容不可信（可能被旧版本、手改或损坏写过），读进来一律重新裁一遍。 */
const COMPOSE_DEFAULT_MAX_LENGTH = 4_096;

function composeDefaultField(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > COMPOSE_DEFAULT_MAX_LENGTH) return undefined;
  return trimmed;
}

export function parseComposeDefaults(value: unknown): ComposeDefaults {
  if (!value || typeof value !== "object") return {};
  const row = value as Record<string, unknown>;
  const next: ComposeDefaults = {};
  const cwd = composeDefaultField(row.cwd);
  const model = composeDefaultField(row.model);
  const effort = composeDefaultField(row.effort);
  if (cwd) next.cwd = cwd;
  if (model) next.model = model;
  if (effort) next.effort = effort;
  return next;
}

function supports(status: CodexStatus, feature: string): boolean {
  if (Array.isArray(status.features)) return status.features.includes(feature);
  return status.features?.[feature] === true;
}

function dataRows<T>(value: unknown): T[] {
  if (!value || typeof value !== "object") return [];
  const data = (value as { data?: unknown }).data;
  return Array.isArray(data) ? data as T[] : [];
}

function normalizeTaskModel(value: unknown): TaskModel[] {
  if (!value || typeof value !== "object") return [];
  const row = value as Record<string, unknown>;
  const id = [row.id, row.model].find((candidate) =>
    typeof candidate === "string" && candidate.trim()
  );
  if (typeof id !== "string") return [];
  const effortRows = Array.isArray(row.supportedReasoningEfforts)
    ? row.supportedReasoningEfforts
    : [];
  const efforts = effortRows.flatMap((candidate): TaskReasoningEffort[] => {
    if (typeof candidate === "string" && candidate.trim()) return [{ id: candidate.trim() }];
    if (!candidate || typeof candidate !== "object") return [];
    const effort = candidate as Record<string, unknown>;
    const effortId = [effort.reasoningEffort, effort.effort, effort.id].find((item) =>
      typeof item === "string" && item.trim()
    );
    if (typeof effortId !== "string") return [];
    return [{
      id: effortId.trim(),
      description: typeof effort.description === "string" ? effort.description.trim() || undefined : undefined,
    }];
  });
  return [{
    id: id.trim(),
    displayName: typeof row.displayName === "string" && row.displayName.trim()
      ? row.displayName.trim()
      : id.trim(),
    isDefault: row.isDefault === true,
    defaultEffort: typeof row.defaultReasoningEffort === "string"
      ? row.defaultReasoningEffort.trim() || undefined
      : undefined,
    efforts,
  }];
}

function creationResultIsUnknown(cause: unknown): boolean {
  const code = cause && typeof cause === "object" && typeof (cause as { code?: unknown }).code === "string"
    ? (cause as { code: string }).code
    : "";
  return code === "CODEX_LINK_TIMEOUT" || code === "CODEX_LINK_NOT_CONNECTED";
}

export class CodexRepository {
  #call: CodexCall;
  #store: CodexStore;
  #now: () => number;
  #onStorageWarning?: (message: string) => void;
  #loaded = false;
  #compatibilityKnown = false;
  #readOnly = false;
  #connectionError?: CodexMessageError;
  #taskOptionsSupported = false;
  #modelsPromise?: Promise<TaskModel[]>;
  #accountSupported = false;
  #account?: CodexAccount;
  #skillsCwd?: string;
  #accountSyncSupported = false;
  #lastSkillsReload?: { cwd: string | undefined; at: number };
  #history: CodexThread[] = [];
  #loadedPages = 1;
  #nextCursor?: string;
  #cursors = new Set<string>();
  #lastSnapshot?: CodexRepositorySnapshot;
  #loadMorePromise?: Promise<CodexRepositorySnapshot>;
  #refreshGeneration = 0;
  #composeDefaults?: ComposeDefaults;
  localState: LocalThreadState = emptyLocalThreadState();

  constructor(
    call: CodexCall | undefined,
    store: CodexStore,
    options: RepositoryOptions = {},
  ) {
    // 测试注入窄口时不应为了类型定义去加载真实 SDK bridge；产品默认值保持惰性。
    this.#call = call ?? (async <T>(method: string, params?: unknown) => {
      const { codexCall } = await import("./codex-bridge");
      return codexCall<T>(method as CodexMethod, params);
    });
    this.#store = store;
    this.#now = options.now ?? Date.now;
    this.#onStorageWarning = options.onStorageWarning;
  }

  async loadLocalState(): Promise<LocalThreadState> {
    if (this.#loaded) return this.localState;
    const raw = await this.#store.get(STATE_KEY);
    const parsed = parseLocalThreadState(raw);
    this.localState = pruneLocalThreadState(parsed.state, this.#now());
    this.#loaded = true;
    if (parsed.warning) {
      this.#onStorageWarning?.(parsed.warning);
      await this.#store.set(STATE_KEY, this.localState);
    }
    return this.localState;
  }

  /** 新任务表单的默认值：上次真正建成任务时用的目录 / 模型 / 强度。 */
  async loadComposeDefaults(): Promise<ComposeDefaults> {
    if (this.#composeDefaults) return this.#composeDefaults;
    this.#composeDefaults = parseComposeDefaults(await this.#store.get(COMPOSE_DEFAULTS_KEY));
    return this.#composeDefaults;
  }

  async saveComposeDefaults(next: ComposeDefaults): Promise<void> {
    const normalized = parseComposeDefaults(next);
    // 先落盘再更新内存缓存：反过来的话，写失败会留下「这次看起来记住了、重启又没有」的
    // 假象，而这类不一致最难被人发现。
    await this.#store.set(COMPOSE_DEFAULTS_KEY, normalized);
    this.#composeDefaults = normalized;
  }

  async #persist(next: LocalThreadState): Promise<void> {
    this.localState = pruneLocalThreadState(next, this.#now());
    await this.#store.set(STATE_KEY, this.localState);
  }

  #requireWrites(): void {
    if (this.#connectionError) throw this.#connectionError;
    if (this.#compatibilityKnown && this.#readOnly) {
      throw new CodexMessageError("errors.unsupportedOperations");
    }
  }

  #checkConnection(status: CodexStatus): void {
    if (status.connected) {
      this.#connectionError = undefined;
    } else if (status.lastError) {
      this.#connectionError = new CodexMessageError(
        status.lastErrorCode === "CODEX_LINK_VERSION_UNSUPPORTED"
          ? "connection.versionUnsupported" : "connection.unavailable",
        { detail: status.lastError },
      );
      throw this.#connectionError;
    }
    // No previous error means normal cold start; preserve the Host's connection wait.
  }

  async refresh(options: { forceReloadSkills?: boolean } = {}): Promise<CodexRepositorySnapshot> {
    // Even a failed status read must invalidate pages started by the previous refresh.
    const generation = ++this.#refreshGeneration;
    await this.loadLocalState();
    let status = await this.#call<CodexStatus>("codex.status", {});
    this.#checkConnection(status);
    this.#compatibilityKnown = true;
    this.#readOnly = !supports(status, "thread_state_v1");
    this.#taskOptionsSupported = supports(status, "task_options_v1");

    this.#accountSupported = supports(status, "account_v1");
    this.#accountSyncSupported = supports(status, "account_sync_v1");
    const [historyResult, account] = await Promise.all([
      this.#refreshHistoryWindow(),
      this.#accountSupported ? this.readAccount() : undefined,
    ]).catch(async (cause: unknown) => {
      // A handshake can fail after the initial status read. Prefer its exact reason.
      const latest = await this.#call<CodexStatus>("codex.status", {}).catch(() => undefined);
      if (latest) this.#checkConnection(latest);
      throw cause;
    });
    if (!status.connected) status = await this.#call<CodexStatus>("codex.status", {});
    this.#checkConnection(status);
    const history = dataRows<CodexThread>(historyResult);
    const defaults = await this.loadComposeDefaults();
    const skillsCwd = this.#skillsCwd ?? defaults.cwd ?? history.find(row => row.cwd)?.cwd;
    // 设计稿右栏：Skill 跟项目走、按目录分组一次列出——只读单一目录会让其他项目的
    // Skill 永远不露面。候选 = 主目录 + 会话历史里出现过的目录（历史按最近活跃排序，
    // 去重后的顺序就是「最近在用的项目」顺序），封顶 8 个控制单次读取成本。
    const skillCwds = [...new Set([
      ...(skillsCwd ? [skillsCwd] : []),
      ...history.map((row) => row.cwd?.trim() ?? "").filter(Boolean),
    ])].slice(0, 8);
    const skillsReadAt = this.#now();
    // skills/list alone does not register a filesystem watcher in Codex 0.153.4.
    // Bound cached polling even when no thread has registered the selected root.
    const forceReload = options.forceReloadSkills === true || !this.#lastSkillsReload
      || this.#lastSkillsReload.cwd !== skillCwds.join("\n")
      || skillsReadAt < this.#lastSkillsReload.at
      || skillsReadAt - this.#lastSkillsReload.at >= 60_000;
    let skillsError: string | undefined;
    const skillsResult = await this.#call<{ data?: SkillsListEntry[] }>("codex.list_skills", {
      ...(skillCwds.length > 0 ? { cwds: skillCwds } : {}), forceReload,
    }).catch(() => {
      skillsError = t("errors.skillsReadFailed");
      return { data: [] };
    });
    let runtimeThreads = status.threads ?? [];
    if (this.#readOnly) {
      const [activeResult] = await Promise.all([
        this.#call<{ data?: CodexThread[] }>("codex.list_active_threads", { limit: 50 }),
        this.#call("codex.drain_events", {}).catch(() => ({ events: [] })),
      ]);
      runtimeThreads = dataRows<CodexThread>(activeResult).map((thread) => ({
        threadId: thread.id,
        state: thread.status?.activeFlags?.some((flag) =>
          flag === "waitingOnApproval" || flag === "waitingOnUserInput"
        ) ? "needsInput" : "thinking",
        lastEventMs: (thread.recencyAt ?? thread.updatedAt ?? 0) * 1_000,
        managedByDriver: false,
        pendingRequests: [],
      }));
    }

    // Replace the complete loaded window atomically. Merging only page one with old
    // pages would retain externally archived rows forever; a failed page replaces none.
    if (generation !== this.#refreshGeneration && this.#lastSnapshot) return this.#lastSnapshot;
    if (forceReload && !skillsError) this.#lastSkillsReload = { cwd: skillCwds.join("\n"), at: skillsReadAt };
    this.#history = this.#mergeHistory(history, []);
    this.#loadedPages = historyResult.pages;
    this.#nextCursor = historyResult.nextCursor || undefined;
    this.#cursors = historyResult.cursors;
    const next: CodexRepositorySnapshot = {
      status,
      dashboard: buildDashboard(this.#history, runtimeThreads, this.localState, this.#now()),
      runtimeThreads,
      skills: dataRows<SkillsListEntry>(skillsResult),
      skillsCwd, skillsError, skillsErrorKind: skillsError ? "read-failed" : undefined, account, hasMoreThreads: !!this.#nextCursor,
      compatibility: this.#readOnly
        ? { readOnly: true, message: t("errors.unsupportedOperations") }
        : { readOnly: false },
    };
    this.#lastSnapshot = next;
    return next;
  }

  #threadParams(cursor?: string): Record<string, unknown> {
    return { limit: 100, archived: false, sortKey: "updated_at", sortDirection: "desc",
      modelProviders: [], useStateDbOnly: true,
      sourceKinds: ["cli", "vscode", "exec", "appServer", "subAgent", "subAgentReview", "subAgentCompact", "subAgentThreadSpawn", "subAgentOther", "unknown"],
      ...(cursor ? { cursor } : {}) };
  }

  async #refreshHistoryWindow(): Promise<DesktopThreadPage & { pages: number; cursors: Set<string> }> {
    const windowSize = this.#loadedPages;
    const data: CodexThread[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (let pages = 1; pages <= windowSize; pages++) {
      const page = checkedThreadPage(await this.#call<DesktopThreadPage>("codex.list_threads", this.#threadParams(cursor)));
      if (cursor) cursors.add(cursor);
      if (page.nextCursor && cursors.has(page.nextCursor)) throw new CodexMessageError("errors.historyCursor");
      data.push(...page.data);
      if (!page.nextCursor || pages === windowSize) return { data, nextCursor: page.nextCursor, pages, cursors };
      cursor = page.nextCursor;
    }
    throw new CodexMessageError("errors.historyRange");
  }

  #mergeHistory(first: CodexThread[], rest: CodexThread[]): CodexThread[] {
    return [...new Map([...rest, ...first].map(row => [row.id, row])).values()];
  }

  setSkillsCwd(cwd: string): void {
    if (!cwd.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(cwd)) throw new CodexMessageError("errors.absoluteDirectory");
    this.#skillsCwd = cwd;
  }

  loadMore(): Promise<CodexRepositorySnapshot> {
    if (this.#loadMorePromise) return this.#loadMorePromise;
    this.#loadMorePromise = this.#loadNextPage().finally(() => { this.#loadMorePromise = undefined; });
    return this.#loadMorePromise;
  }

  async #loadNextPage(): Promise<CodexRepositorySnapshot> {
    if (this.#connectionError) throw this.#connectionError;
    if (!this.#lastSnapshot) return this.refresh();
    if (!this.#nextCursor) return this.#lastSnapshot;
    const cursor = this.#nextCursor;
    const generation = this.#refreshGeneration;
    const result = checkedThreadPage(await this.#call<DesktopThreadPage>("codex.list_threads", this.#threadParams(cursor)));
    if (this.#connectionError) throw this.#connectionError;
    if (generation !== this.#refreshGeneration) return this.#lastSnapshot;
    if (result.nextCursor && (result.nextCursor === cursor || this.#cursors.has(result.nextCursor))) {
      this.#nextCursor = undefined;
      this.#lastSnapshot.hasMoreThreads = false;
      throw new CodexMessageError("errors.historyCursor");
    }
    this.#cursors.add(cursor);
    this.#loadedPages++;
    this.#nextCursor = result.nextCursor || undefined;
    this.#history = this.#mergeHistory(dataRows<CodexThread>(result), this.#history);
    this.#lastSnapshot = { ...this.#lastSnapshot,
      dashboard: buildDashboard(this.#history, this.#lastSnapshot.runtimeThreads, this.localState, this.#now()),
      hasMoreThreads: !!this.#nextCursor };
    return this.#lastSnapshot;
  }

  async readAccount(): Promise<CodexAccount> {
    try {
      this.#account = accountSnapshot(await this.#call<CodexAccountResponse>("codex.account_read", {}));
    } catch {
      this.#account = { state: "error" };
    }
    return this.#account;
  }

  async login(mode: "browser" | "deviceCode"): Promise<void> {
    await this.#call("codex.login_start", { mode });
  }

  async syncAccount(): Promise<void> {
    if (this.#accountSyncSupported) await this.#call("codex.account_sync", {});
  }

  async cancelLogin(loginId: string): Promise<void> {
    await this.#call("codex.login_cancel", { loginId });
  }

  async openLogin(loginId: string): Promise<void> {
    await this.#call("codex.login_open", { loginId });
  }

  async listTaskModels(force = false): Promise<TaskModel[]> {
    if (!this.#taskOptionsSupported) return [];
    if (force) this.#modelsPromise = undefined;
    if (!this.#modelsPromise) {
      this.#modelsPromise = this.#call<{ data?: unknown[] }>("codex.list_models", { limit: 100 })
        .then((result) => dataRows<unknown>(result).flatMap(normalizeTaskModel))
        .catch((cause) => {
          this.#modelsPromise = undefined;
          throw cause;
        });
    }
    return this.#modelsPromise;
  }

  async startTask(cwd: string, text: string): Promise<{ threadId: string; turn: unknown }>;
  async startTask(options: StartTaskOptions): Promise<{ threadId: string; turn: unknown }>;
  async startTask(
    cwdOrOptions: string | StartTaskOptions,
    legacyText?: string,
  ): Promise<{ threadId: string; turn: unknown }> {
    this.#requireWrites();
    if (this.#accountSupported) {
      const account = await this.readAccount();
      if (account.state === "error") throw new CodexMessageError("account.cannotConfirm");
      if (account.requiresOpenaiAuth && !account.account) throw new CodexMessageError("account.signInRequired");
    }
    const options: StartTaskOptions = typeof cwdOrOptions === "string"
      ? { cwd: cwdOrOptions, text: legacyText ?? "" }
      : cwdOrOptions;
    // 输入必须非空：先 skill 后正文。两个都空就别发——那是一个永远等不到内容的回合。
    const input: Array<Record<string, unknown>> = [];
    if (options.skill) {
      input.push({ type: "skill", name: options.skill.name, path: options.skill.path });
    }
    if (options.text?.trim()) input.push({ type: "text", text: options.text });
    if (input.length === 0) throw new CodexMessageError("errors.emptyTask");
    let threadId = options.threadId;
    const clientUserMessageId = options.clientUserMessageId ?? crypto.randomUUID();
    if (!threadId) {
      let started: { thread?: { id?: string } };
      try {
        started = await this.#call<{ thread?: { id?: string } }>("codex.start_thread", {
          cwd: options.cwd,
        });
      } catch (cause) {
        if (!creationResultIsUnknown(cause)) throw cause;
        throw new TaskCreationError(
          () => t("errors.creationUnknown"),
          "unknown",
          undefined,
          clientUserMessageId,
          { cause },
        );
      }
      threadId = started.thread?.id;
      if (!threadId) throw new CodexMessageError("errors.missingThreadId");
      try {
        await this.loadLocalState();
        await this.#persist({
          ...this.localState,
          managed: {
            ...this.localState.managed,
            [threadId]: { createdAtMs: this.#now(), cwd: options.cwd },
          },
        });
      } catch (cause) {
        throw new TaskCreationError(
          () => t("errors.persistFailed"),
          "unknown",
          threadId,
          clientUserMessageId,
          { cause },
        );
      }
    }
    // input 已在函数开头拼好（Skill 排在正文前面：先告诉 Codex 用哪套办法，
    // 再说这次要做什么；空正文不占一行，两个都空直接拒绝）。
    const params: Record<string, unknown> = { threadId, input };
    if (this.#taskOptionsSupported) {
      params.clientUserMessageId = clientUserMessageId;
      if (options.model) params.model = options.model;
      if (options.effort) params.effort = options.effort;
    }
    try {
      const turn = await this.#call("codex.start_turn", params);
      return { threadId, turn };
    } catch (cause) {
      const unknown = creationResultIsUnknown(cause);
      throw new TaskCreationError(
        () => unknown
          ? t("errors.firstTurnUnknown")
          : t("errors.firstTurnFailed"),
        unknown ? "unknown" : "turn-failed",
        threadId,
        clientUserMessageId,
        { cause },
      );
    }
  }

  async openThread(threadId: string): Promise<void> {
    this.#requireWrites();
    await this.#call("codex.open_thread", { threadId });
    await this.loadLocalState();
    const managed = { ...this.localState.managed };
    delete managed[threadId];
    await this.#persist(markThreadSeen({ ...this.localState, managed }, threadId, this.#now()));
  }

  async markSeen(threadId: string): Promise<void> {
    await this.loadLocalState();
    await this.#persist(markThreadSeen(this.localState, threadId, this.#now()));
  }

  async markUnseen(threadId: string): Promise<void> {
    await this.loadLocalState();
    await this.#persist(markThreadUnseen(this.localState, threadId));
  }

  async respondApproval(
    serverRequestId: number,
    decision: "approved" | "denied",
    reason?: string,
  ): Promise<void> {
    this.#requireWrites();
    await this.#call("codex.respond_approval", { serverRequestId, decision, reason });
  }

  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    this.#requireWrites();
    await this.#call("codex.interrupt_turn", { threadId, turnId });
  }

  async runSkill(
    thread: RuntimeThreadSnapshot,
    skill: { name: string; path: string },
  ): Promise<void> {
    this.#requireWrites();
    const { routeSkillAction } = await import("./codex-model");
    const action = routeSkillAction(thread, skill);
    await this.#call(action.method, action.params);
  }
}
