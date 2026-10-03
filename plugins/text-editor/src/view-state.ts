import type { KeyValueStore, LocalTextDocument } from "@reai/app-sdk/v1";

import { isTeMode, type TeMode } from "./mode";

export const TEXT_EDITOR_VIEW_STATE_KEY = "current";

export interface TextEditorViewState {
  schemaVersion: 1;
  workspaceId: string;
  directory: string;
  documentPath?: string;
  mode: TeMode;
  searchQuery: string;
  wrapOn: boolean;
}

export type TextEditorViewStateStorage = Pick<KeyValueStore, "get" | "set">;

export interface TextEditorViewStateWriter {
  save(state: TextEditorViewState): Promise<void>;
}

export interface TextEditorViewStateFiles {
  listDirectory(workspaceId: string, path?: string): Promise<unknown>;
  readDocument(workspaceId: string, path: string): Promise<LocalTextDocument>;
}

export interface RestoredTextEditorViewState {
  state: TextEditorViewState;
  document?: LocalTextDocument;
}

const defaultViewState = (workspaceId = ""): TextEditorViewState => ({
  schemaVersion: 1,
  workspaceId,
  directory: "",
  mode: "document",
  searchQuery: "",
  wrapOn: true,
});

function boundedString(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.length <= max ? value : undefined;
}

function relativePath(value: unknown, allowEmpty: boolean): string | undefined {
  const path = boundedString(value, 4_096);
  if (path === undefined || (!allowEmpty && path.length === 0)) return undefined;
  if (
    path.includes("\0") ||
    path.startsWith("/") ||
    path.startsWith("\\") ||
    /^[a-z]:[\\/]/i.test(path) ||
    path.split(/[\\/]/).some((part) => part === "..")
  ) {
    return undefined;
  }
  return path.replaceAll("\\", "/");
}

/**
 * 只记视图定位，不复制文件内容。这样重新创建 Surface 时能回到原工作区/目录/文件，
 * 同时磁盘内容仍由 local.files@1 在恢复时重新读取和校验 revision。
 */
export function parseTextEditorViewState(value: unknown): TextEditorViewState | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  if (row.schemaVersion !== 1) return undefined;
  const workspaceId = boundedString(row.workspaceId, 128);
  if (workspaceId === undefined) return undefined;

  const state: TextEditorViewState = {
    schemaVersion: 1,
    workspaceId,
    directory: relativePath(row.directory, true) ?? "",
    mode: isTeMode(row.mode) ? row.mode : "document",
    searchQuery: boundedString(row.searchQuery, 512) ?? "",
    wrapOn: typeof row.wrapOn === "boolean" ? row.wrapOn : true,
  };
  const documentPath = relativePath(row.documentPath, false);
  if (workspaceId && documentPath) state.documentPath = documentPath;
  if (!workspaceId) state.directory = "";
  return state;
}

export async function loadTextEditorViewState(
  storage: TextEditorViewStateStorage,
): Promise<TextEditorViewState | undefined> {
  return parseTextEditorViewState(await storage.get<unknown>(TEXT_EDITOR_VIEW_STATE_KEY));
}

export async function saveTextEditorViewState(
  state: TextEditorViewState,
  storage: TextEditorViewStateStorage,
): Promise<void> {
  await storage.set(TEXT_EDITOR_VIEW_STATE_KEY, state);
}

/** Host KV 是异步写穿；串行化可避免较早的慢请求在稍后覆盖用户的最新操作。 */
export function createTextEditorViewStateWriter(
  storage: TextEditorViewStateStorage,
): TextEditorViewStateWriter {
  let pending: Promise<void> = Promise.resolve();
  return {
    save(state) {
      const snapshot = { ...state };
      const write = pending
        .catch(() => undefined)
        .then(() => saveTextEditorViewState(snapshot, storage));
      pending = write;
      return write;
    },
  };
}

/** 已保存的 workspace 已撤销时回到仍有效的首个授权，绝不拿旧 id 继续读文件。 */
export function resolveTextEditorViewState(
  saved: TextEditorViewState | undefined,
  workspaceIds: readonly string[],
): TextEditorViewState {
  if (saved && (saved.workspaceId === "" || workspaceIds.includes(saved.workspaceId))) {
    return saved;
  }
  return defaultViewState(workspaceIds[0] ?? "");
}

/**
 * 恢复不是只把几个字符串塞回 UI：必须用 Host Broker 重新验证目录并读取文件。
 * 目录失效退到工作区根；文件失效只清文件指针，不能拖垮仍有效的文件夹授权。
 */
export async function restoreTextEditorViewState(
  saved: TextEditorViewState | undefined,
  workspaceIds: readonly string[],
  files: TextEditorViewStateFiles,
): Promise<RestoredTextEditorViewState> {
  let state = resolveTextEditorViewState(saved, workspaceIds);
  if (!state.workspaceId) return { state };

  if (state.directory) {
    try {
      await files.listDirectory(state.workspaceId, state.directory);
    } catch {
      state = { ...state, directory: "" };
    }
  }

  if (!state.documentPath) return { state };
  try {
    const document = await files.readDocument(state.workspaceId, state.documentPath);
    return { state, document };
  } catch {
    const { documentPath: _, ...withoutDocument } = state;
    return { state: withoutDocument };
  }
}
