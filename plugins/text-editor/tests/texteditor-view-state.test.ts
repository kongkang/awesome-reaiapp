import { describe, expect, test } from "bun:test";

import {
  loadTextEditorViewState,
  resolveTextEditorViewState,
  restoreTextEditorViewState,
  saveTextEditorViewState,
  TEXT_EDITOR_VIEW_STATE_KEY,
  type TextEditorViewState,
  type TextEditorViewStateStorage,
} from "../src/view-state";

function hostKvClient(
  rows = new Map<string, unknown>(),
): TextEditorViewStateStorage & { rows: Map<string, unknown> } {
  return {
    rows,
    async get<T = unknown>(key: string): Promise<T | undefined> {
      return rows.get(key) as T | undefined;
    },
    async set(key: string, value: unknown): Promise<void> {
      rows.set(key, value);
    },
  };
}

const savedState = (): TextEditorViewState => ({
  schemaVersion: 1,
  workspaceId: "workspace-b",
  directory: "docs/notes",
  documentPath: "docs/notes/today.md",
  mode: "source",
  searchQuery: "today",
  wrapOn: false,
});

describe("文本编辑器 Surface 视图状态", () => {
  test("Host 销毁并重建两个独立 Surface 后仍恢复完整视图状态", async () => {
    const hostRows = new Map<string, unknown>();
    const surfaceA = hostKvClient(hostRows);
    await saveTextEditorViewState(savedState(), surfaceA);

    // 新 client 模拟旧 incognito WebView 已销毁、插件重新 activate；只有 Host 后端共享。
    const surfaceB = hostKvClient(hostRows);
    expect(await loadTextEditorViewState(surfaceB)).toEqual(savedState());
    expect(surfaceB.rows.has(TEXT_EDITOR_VIEW_STATE_KEY)).toBe(true);
  });

  test("授权仍存在时保留选择；授权已撤销时安全回到首个有效工作区", () => {
    const saved = savedState();
    expect(resolveTextEditorViewState(saved, ["workspace-a", "workspace-b"])).toEqual(saved);
    expect(resolveTextEditorViewState(saved, ["workspace-a"])).toEqual({
      schemaVersion: 1,
      workspaceId: "workspace-a",
      directory: "",
      mode: "document",
      searchQuery: "",
      wrapOn: true,
    });
  });

  test("用户停在工作区清单时不擅自进入第一个文件夹", () => {
    const overview: TextEditorViewState = {
      ...savedState(),
      workspaceId: "",
      directory: "",
      documentPath: undefined,
    };
    expect(resolveTextEditorViewState(overview, ["workspace-a"])).toEqual(overview);
  });

  test("损坏、绝对或父级逃逸路径不进入恢复链路", async () => {
    const storage = hostKvClient();
    storage.rows.set(
      TEXT_EDITOR_VIEW_STATE_KEY,
      {
        ...savedState(),
        directory: "../../private",
        documentPath: "/tmp/secret.txt",
      },
    );

    expect(await loadTextEditorViewState(storage)).toEqual({
      ...savedState(),
      directory: "",
      documentPath: undefined,
    });
  });

  test("Host KV 故障向挂载层报告，由挂载层决定降级且不影响文件 Broker", async () => {
    const broken: TextEditorViewStateStorage = {
      async get() {
        throw new Error("blocked");
      },
      async set() {
        throw new Error("quota");
      },
    };
    expect(loadTextEditorViewState(broken)).rejects.toThrow("blocked");
    expect(saveTextEditorViewState(savedState(), broken)).rejects.toThrow("quota");
  });

  test("恢复时真实读取原 workspace 的子目录和文件", async () => {
    const calls: string[] = [];
    const restored = await restoreTextEditorViewState(
      savedState(),
      ["workspace-a", "workspace-b"],
      {
        async listDirectory(workspaceId, path) {
          calls.push(`list:${workspaceId}:${path}`);
          return {};
        },
        async readDocument(workspaceId, path) {
          calls.push(`read:${workspaceId}:${path}`);
          return {
            workspaceId,
            path,
            content: "# today",
            revision: "sha256:today",
            size: 7,
          };
        },
      },
    );

    expect(calls).toEqual([
      "list:workspace-b:docs/notes",
      "read:workspace-b:docs/notes/today.md",
    ]);
    expect(restored.state).toEqual(savedState());
    expect(restored.document?.content).toBe("# today");
  });

  test("目录或文件消失时保留有效 workspace 并逐级降级", async () => {
    const restored = await restoreTextEditorViewState(
      savedState(),
      ["workspace-b"],
      {
        async listDirectory() {
          throw new Error("directory moved");
        },
        async readDocument() {
          throw new Error("file removed");
        },
      },
    );

    expect(restored).toEqual({
      state: {
        schemaVersion: 1,
        workspaceId: "workspace-b",
        directory: "",
        mode: "source",
        searchQuery: "today",
        wrapOn: false,
      },
    });
  });
});
