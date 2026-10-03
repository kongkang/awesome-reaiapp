import { message, type LocalizedText } from "./i18n";
import type { TaskRow } from "./codex-view";
import { normalizeListedThreads } from "./thread-state";

export interface ThreadLoadResult {
  threads: TaskRow[];
  warning?: LocalizedText;
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};

function nextCursorOf(payload: unknown): string | undefined {
  const cursor = record(payload).nextCursor;
  return typeof cursor === "string" && cursor.length > 0 ? cursor : undefined;
}

/**
 * 官方 thread/list 是游标分页。这里读取完整列表，并在后续页异常时保留已经拿到的
 * 真实记录，同时明确告诉 UI 数据并不完整；绝不补造线程。
 */
export async function loadThreadPages(
  fetchPage: (cursor?: string) => Promise<unknown>,
  maxPages = 20,
): Promise<ThreadLoadResult> {
  const byId = new Map<string, TaskRow>();
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let warning: LocalizedText | undefined;

  for (let page = 0; page < maxPages; page += 1) {
    let payload: unknown;
    try {
      payload = await fetchPage(cursor);
    } catch (cause) {
      if (page === 0) throw cause;
      warning = message("ui.m150");
      break;
    }
    for (const row of normalizeListedThreads(payload)) {
      const previous = byId.get(row.id);
      if (!previous || row.updatedAt >= previous.updatedAt) byId.set(row.id, row);
    }
    const next = nextCursorOf(payload);
    if (!next) break;
    if (seenCursors.has(next)) {
      warning = message("ui.m151");
      break;
    }
    seenCursors.add(next);
    cursor = next;
    if (page === maxPages - 1) {
      warning = message("ui.m180", { p0: maxPages });
    }
  }

  return {
    threads: [...byId.values()].sort((left, right) => right.updatedAt - left.updatedAt),
    ...(warning ? { warning } : {}),
  };
}
