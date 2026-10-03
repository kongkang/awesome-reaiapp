import { t, message } from "./i18n";
import type { FileChange, MaterialItem, StreamCard, TaskRow } from "./codex-view";

const UNNAMED_TASK = message("ui.m134");
const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};

function valueAt(value: unknown, ...path: string[]): unknown {
  let current = value;
  for (const key of path) current = asRecord(current)[key];
  return current;
}
function stringAt(value: unknown, ...path: string[]): string | undefined {
  const current = valueAt(value, ...path);
  return typeof current === "string" && current.length > 0 ? current : undefined;
}
function numberAt(value: unknown, ...path: string[]): number | undefined {
  const current = valueAt(value, ...path);
  return typeof current === "number" && Number.isFinite(current) ? current : undefined;
}
function arrayAt(value: unknown, ...path: string[]): unknown[] {
  const current = valueAt(value, ...path);
  return Array.isArray(current) ? current : [];
}
function epochMilliseconds(value: number | undefined): number {
  if (!value) return 0;
  return value < 10_000_000_000 ? value * 1000 : value;
}
function statusAt(value: unknown): string {
  return stringAt(value, "status", "type") ?? stringAt(value, "status") ?? "";
}

/** 把官方 `thread/list` 响应投影成侧边栏；不补造任何任务或目录。 */
export function normalizeListedThreads(payload: unknown): TaskRow[] {
  const data = arrayAt(payload, "data");
  const rows = data.length > 0 ? data : arrayAt(payload, "threads");
  return rows
    .map((raw): TaskRow | undefined => {
      const id = stringAt(raw, "id");
      const cwd = stringAt(raw, "cwd");
      if (!id || !cwd) return undefined;
      return {
        id,
        cwd,
        name:
          stringAt(raw, "name") ?? stringAt(raw, "preview") ??
          stringAt(raw, "title") ?? UNNAMED_TASK,
        updatedAt: epochMilliseconds(
          numberAt(raw, "updatedAt") ?? numberAt(raw, "updatedAtMs") ??
            numberAt(raw, "createdAt"),
        ),
        statusHint: statusAt(raw),
        needsDecision: false,
      };
    })
    .filter((row): row is TaskRow => Boolean(row))
    .sort((left, right) => right.updatedAt - left.updatedAt);
}

/** `thread/start` 返回真实线程后，在首个 turn 落盘前保留这条真实记录。 */
export function normalizeStartedThread(
  payload: unknown,
  requestedCwd: string,
  now = Date.now(),
): TaskRow | undefined {
  const nested = valueAt(payload, "thread");
  const thread = Object.keys(asRecord(nested)).length > 0 ? nested : payload;
  const id = stringAt(thread, "id");
  if (!id) return undefined;
  return {
    id,
    cwd: stringAt(thread, "cwd") ?? requestedCwd,
    name:
      stringAt(thread, "name") ?? stringAt(thread, "preview") ??
      stringAt(thread, "title") ?? message("ui.m021"),
    updatedAt: now,
    // app-server 在首个 turn 前还没有可读历史；不能把它标成“已完成”。
    statusHint: "notStarted",
    needsDecision: false,
  };
}

/**
 * 首 turn 被 app-server 接受后，线程仍要等首个用户消息处理后才落盘；这期间
 * 官方 `thread/read`(includeTurns) 会拒绝（"not materialized yet"），Host 又把
 * 这类协议错误收束成同一个 CODEX_TASKS_UNAVAILABLE，插件无法区分。因此对首次
 * 权威详情读取做**有界**宽限：窗口内读取失败保持占位详情静默降级，等下一轮
 * 轮询重试；超时后恢复真实失败路径，不能无限吞错误。
 */
export const FIRST_TURN_READ_GRACE_MS = 10_000;

/**
 * 宽限窗口的 10 秒上界不能依赖可回拨的墙钟：系统时钟回拨会让 deadline > now
 * 持续成立、等效延长吞错窗口。插件 WebView 必有单调递增的 performance.now，
 * 直接采用；没有 performance 的降级环境用「时间不回退」钳制的 Date.now——
 * 只在已见最大墙钟值上推进（deadline = max(已见 now) + 10s），回拨不延长窗口。
 */
export function createGraceClock(
  performanceNow: (() => number) | undefined,
  dateNow: () => number = () => Date.now(),
): () => number {
  if (performanceNow) return performanceNow;
  let maxWallSeen = 0;
  return () => {
    const wall = dateNow();
    if (wall > maxWallSeen) maxWallSeen = wall;
    return maxWallSeen;
  };
}

export const graceClockNow = createGraceClock(
  typeof performance !== "undefined" && typeof performance.now === "function"
    ? () => performance.now()
    : undefined,
);

export interface FirstTurnReadGuard {
  pendingThreadId: string | undefined;
  turnStarted: boolean;
  /** 宽限截止时刻（graceClockNow() 的单调毫秒）；0 表示未开启或权威详情已落地。 */
  graceDeadline: number;
}

export function isFirstTurnReadWithinGrace(
  guard: FirstTurnReadGuard,
  threadId: string,
  now: number,
): boolean {
  return (
    threadId !== "" &&
    guard.pendingThreadId === threadId &&
    guard.turnStarted &&
    guard.graceDeadline > now
  );
}

/**
 * 首 turn 发送成功后的开窗转移。宽限 deadline 每个「首 turn 周期」只设定一次：
 * turn 已被接受过（turnStarted=true，无论窗口仍在等待还是已被权威详情落地
 * 收窗）时原样返回，后续发送不得重开或延长——否则官方列表接管 pending 线程
 * 前的盲区内，真实读取失败会被静默吞掉、已落地详情被空占位替换。
 */
export function openFirstTurnReadGrace(
  turnStarted: boolean,
  graceDeadline: number,
  now: number,
): { turnStarted: boolean; graceDeadline: number } {
  if (turnStarted) return { turnStarted, graceDeadline };
  return { turnStarted: true, graceDeadline: now + FIRST_TURN_READ_GRACE_MS };
}

/**
 * 空线程占位详情：首 turn 前是 idle（thread/read 不可见，thread/start 的真实 id
 * 足以支撑可输入的空详情）；首 turn 已被接受、权威详情尚未就绪时是 active——
 * running 占位防止在不知道真实 turn id 时并发 start 第二个 turn。
 */
export function emptyThreadPlaceholder(turnStarted: boolean): {
  thread: { turns: unknown[]; status: { type: "idle" } | { type: "active" } };
} {
  return {
    thread: {
      turns: [],
      status: { type: turnStarted ? "active" : "idle" },
    },
  };
}

export function mergeThreadsWithPending(
  listed: TaskRow[],
  pending: TaskRow | undefined,
): { threads: TaskRow[]; pending: TaskRow | undefined } {
  if (!pending) return { threads: listed, pending: undefined };
  if (listed.some((row) => row.id === pending.id)) {
    return { threads: listed, pending: undefined };
  }
  return { threads: [pending, ...listed], pending };
}

function userInputText(input: unknown): string | undefined {
  const type = stringAt(input, "type");
  if (type === "text") return stringAt(input, "text");
  if (type === "mention") {
    const name = stringAt(input, "name") ?? stringAt(input, "path");
    return name ? `@${name}` : undefined;
  }
  if (type === "skill") {
    const name = stringAt(input, "name") ?? stringAt(input, "path");
    return name ? `$${name}` : undefined;
  }
  if (type === "localImage") return t("ui.m171", { p0: stringAt(input, "path") ?? t("ui.m135") });
  if (type === "image") return t("ui.m136");
  if (type === "localAudio") return t("ui.m172", { p0: stringAt(input, "path") ?? t("ui.m137") });
  if (type === "audio") return t("ui.m138");
  return undefined;
}
function stringList(value: unknown): string[] {
  return (Array.isArray(value) ? value : []).filter(
    (entry): entry is string => typeof entry === "string" && entry.length > 0,
  );
}
function fileChangeLabel(change: unknown): string {
  const kind = stringAt(change, "kind", "type") ?? stringAt(change, "kind");
  if (kind === "add") return t("ui.m139");
  if (kind === "delete") return t("ui.m140");
  return t("ui.m055");
}
function compactJson(value: unknown): string {
  try {
    return value === undefined ? "" : JSON.stringify(value).slice(0, 1000);
  } catch {
    return "";
  }
}

function activityText(item: unknown, type: string): string | undefined {
  if (type === "commandExecution") {
    const command = stringAt(item, "command");
    const output = stringAt(item, "aggregatedOutput")?.trim();
    return command ? t("ui.m173", { p0: command, p1: output ? `\n${output}` : "" }) : output;
  }
  if (type === "mcpToolCall" || type === "dynamicToolCall") {
    const label = [stringAt(item, "server") ?? stringAt(item, "namespace"), stringAt(item, "tool")]
      .filter(Boolean).join(" / ");
    return label ? t("ui.m174", { p0: label }) : t("ui.m141");
  }
  if (type === "collabAgentToolCall") return t("ui.m175", { p0: stringAt(item, "tool") ?? t("ui.m142") });
  if (type === "subAgentActivity") return t("ui.m176", { p0: stringAt(item, "kind") ?? stringAt(item, "agentPath") ?? t("ui.m143") });
  if (type === "webSearch") return t("ui.m177", { p0: stringAt(item, "query") ?? "" }).trim();
  if (type === "imageView") return t("ui.m178", { p0: stringAt(item, "path") ?? "" }).trim();
  if (type === "imageGeneration") return t("ui.m144");
  if (type === "enteredReviewMode") return t("ui.m145");
  if (type === "exitedReviewMode") return t("ui.m146");
  if (type === "contextCompaction") return t("ui.m147");
  if (type === "sleep") {
    const duration = numberAt(item, "durationMs");
    return duration ? t("ui.m179", { p0: Math.ceil(duration / 1000) }) : t("ui.m148");
  }
  return compactJson(valueAt(item, "arguments")) || undefined;
}

/** 官方 `thread/read` 的 turns/items 是选中任务对话与改动的唯一事实源。 */
export function buildThreadDetail(
  detail: unknown,
  thread: TaskRow | undefined,
): {
  stream: StreamCard[];
  fileChanges: FileChange[];
  materials: MaterialItem[];
  running: boolean;
  activeTurnId: string | undefined;
} {
  const stream: StreamCard[] = [];
  const changesByPath = new Map<string, FileChange>();
  const materialsByKey = new Map<string, MaterialItem>();
  const addMaterial = (material: MaterialItem) => {
    const key = `${material.icon}\u0000${material.title}\u0000${material.sub}`;
    if (!materialsByKey.has(key)) materialsByKey.set(key, material);
  };
  const turns = arrayAt(detail, "thread", "turns");
  for (const turn of turns) {
    for (const item of arrayAt(turn, "items")) {
      const type = stringAt(item, "type") ?? "";
      if (type === "userMessage") {
        const content = arrayAt(item, "content");
        for (const input of content) {
          const inputType = stringAt(input, "type");
          const path = stringAt(input, "path");
          if (inputType === "mention" && path) {
            addMaterial({
              icon: "file-text",
              title: stringAt(input, "name") ?? path.split("/").at(-1) ?? path,
              sub: path,
            });
          } else if ((inputType === "localImage" || inputType === "localAudio") && path) {
            addMaterial({
              icon: "file-text",
              title: path.split("/").at(-1) ?? path,
              sub: path,
            });
          }
        }
        const text = content.map(userInputText)
          .filter((entry): entry is string => Boolean(entry)).join("\n");
        if (text) stream.push({ kind: "user", text: text.slice(0, 4000) });
        continue;
      }
      if (type === "webSearch") {
        const query = stringAt(item, "query");
        if (query) addMaterial({ icon: "globe", title: t("ui.m149"), sub: query });
      } else if (type === "imageView") {
        const path = stringAt(item, "path");
        if (path) {
          addMaterial({
            icon: "file-text",
            title: path.split("/").at(-1) ?? path,
            sub: path,
          });
        }
      }
      if (type === "fileChange") {
        for (const change of arrayAt(item, "changes")) {
          const path = stringAt(change, "path");
          if (path) changesByPath.set(path, { path, label: fileChangeLabel(change) });
        }
        continue;
      }
      let text: string | undefined;
      if (type === "agentMessage" || type === "plan") text = stringAt(item, "text");
      else if (type === "reasoning") {
        text = [...stringList(valueAt(item, "summary")), ...stringList(valueAt(item, "content"))]
          .join("\n").trim();
      } else if (type === "hookPrompt") {
        text = arrayAt(item, "fragments")
          .map((fragment) => stringAt(fragment, "text") ?? stringAt(fragment, "content"))
          .filter((entry): entry is string => Boolean(entry)).join("\n");
      } else text = activityText(item, type);
      if (text) stream.push({ kind: "agent", body: text.slice(0, 4000) });
    }
  }
  const fileChanges = [...changesByPath.values()];
  if (fileChanges.length > 0) {
    stream.push({
      kind: "source",
      chips: fileChanges.slice(0, 3).map((change) => ({
        icon: "file-text" as const,
        label: change.path.split("/").at(-1) ?? change.path,
      })),
    });
  }
  const detailStatus = stringAt(detail, "thread", "status", "type");
  const activeTurn = [...turns].reverse().find(
    (turn) => stringAt(turn, "status") === "inProgress",
  );
  const activeTurnId = activeTurn ? stringAt(activeTurn, "id") : undefined;
  const turnRunning = Boolean(activeTurn);
  const running = turnRunning || /active|running|turn|stream/i.test(
    detailStatus ?? thread?.statusHint ?? "",
  );
  return {
    stream: stream.slice(-60),
    fileChanges,
    materials: [...materialsByKey.values()],
    running,
    activeTurnId,
  };
}
