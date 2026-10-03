import { describe, expect, test } from "bun:test";

import {
  createTextEditorViewStateWriter,
  type TextEditorViewState,
  type TextEditorViewStateStorage,
} from "../src/view-state";

const state = (searchQuery: string): TextEditorViewState => ({
  schemaVersion: 1,
  workspaceId: "workspace-a",
  directory: "docs",
  documentPath: "docs/acceptance.md",
  mode: "document",
  searchQuery,
  wrapOn: true,
});

describe("文本编辑器 Host KV 写穿顺序", () => {
  test("慢的早期写入不能在快速连续操作后覆盖最新快照", async () => {
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const committed: string[] = [];
    let callCount = 0;
    const storage: TextEditorViewStateStorage = {
      async get() {
        return undefined;
      },
      async set(_key, value) {
        callCount += 1;
        if (callCount === 1) await firstGate;
        committed.push((value as TextEditorViewState).searchQuery);
      },
    };
    const writer = createTextEditorViewStateWriter(storage);

    const first = writer.save(state("旧"));
    const latest = writer.save(state("最新"));
    await Promise.resolve();
    expect(committed).toEqual([]);
    releaseFirst?.();
    await Promise.all([first, latest]);

    expect(committed).toEqual(["旧", "最新"]);
  });

  test("一次失败不会永久毒死后续写入队列", async () => {
    let failed = false;
    const committed: string[] = [];
    const storage: TextEditorViewStateStorage = {
      async get() {
        return undefined;
      },
      async set(_key, value) {
        if (!failed) {
          failed = true;
          throw new Error("disk unavailable");
        }
        committed.push((value as TextEditorViewState).searchQuery);
      },
    };
    const writer = createTextEditorViewStateWriter(storage);

    await expect(writer.save(state("失败"))).rejects.toThrow("disk unavailable");
    await writer.save(state("恢复"));

    expect(committed).toEqual(["恢复"]);
  });
});
