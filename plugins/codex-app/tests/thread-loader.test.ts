import { resolveText } from "../src/i18n";
import { describe, expect, test } from "bun:test";

import { loadThreadPages } from "../src/thread-loader";

describe("Codex App 线程列表分页", () => {
  test("沿 nextCursor 读取所有页、去重并按更新时间排序", async () => {
    const cursors: Array<string | undefined> = [];
    const result = await loadThreadPages(async (cursor) => {
      cursors.push(cursor);
      if (!cursor) {
        return {
          data: [
            { id: "old", cwd: "/work/a", preview: "旧任务", updatedAt: 10 },
            { id: "shared", cwd: "/work/a", preview: "旧标题", updatedAt: 20 },
          ],
          nextCursor: "page-2",
        };
      }
      return {
        data: [
          { id: "shared", cwd: "/work/a", preview: "新标题", updatedAt: 30 },
          { id: "new", cwd: "/work/b", preview: "新任务", updatedAt: 40 },
        ],
        nextCursor: null,
      };
    });

    expect(cursors).toEqual([undefined, "page-2"]);
    expect(result.warning).toBeUndefined();
    expect(result.threads.map((row) => [row.id, row.name])).toEqual([
      ["new", "新任务"],
      ["shared", "新标题"],
      ["old", "旧任务"],
    ]);
  });

  test("后续页失败时保留成功页并显示真实警告，绝不假装完整", async () => {
    const result = await loadThreadPages(async (cursor) => {
      if (!cursor) {
        return {
          data: [{ id: "one", cwd: "/work/a", preview: "第一页", updatedAt: 10 }],
          nextCursor: "broken",
        };
      }
      throw new Error("transport down");
    });
    expect(result.threads.map((row) => row.id)).toEqual(["one"]);
    expect(resolveText(result.warning!)).toContain("只显示已读取的任务");
  });

  test("循环 cursor 会停止并报告不完整，避免后台无限轮询", async () => {
    const result = await loadThreadPages(async () => ({ data: [], nextCursor: "loop" }));
    expect(resolveText(result.warning!)).toContain("分页游标重复");
  });
});
