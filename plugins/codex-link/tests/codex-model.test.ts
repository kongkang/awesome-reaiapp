import { describe, expect, test } from "bun:test";
import {
  buildDashboard,
  desktopOpenAvailability,
  emptyLocalThreadState,
  formatCodexError,
  partitionThreads,
  type CodexThread,
} from "../src/codex-model";

const thread = (
  id: string,
  status: CodexThread["status"],
  recencyAt: number,
): CodexThread => ({
  id,
  cwd: `/work/${id}`,
  name: id,
  preview: "",
  recencyAt,
  status,
});

describe("Codex Link V1 数据模型", () => {
  test.each([
    [undefined, "idle"],
    [{ type: "idle" }, "idle"],
    [{ type: "notLoaded" }, "idle"],
    [{ type: "future-state" }, "idle"],
    [{ type: "active", activeFlags: [] }, "thinking"],
    [{ type: "active", activeFlags: ["waitingOnApproval"] }, "needsInput"],
    [{ type: "active", activeFlags: ["waitingOnUserInput"] }, "needsInput"],
    [{ type: "systemError" }, "error"],
  ] as const)("旧托管记录缺少 runtime 时，列表 %j 不推断完成", (status, expected) => {
    const local = emptyLocalThreadState();
    local.managed.stale = { createdAtMs: 100, cwd: "/work/stale" };
    const dashboard = buildDashboard(
      [{ id: "stale", recencyAt: 1, status: status as CodexThread["status"] }],
      [],
      local,
      2_000,
    );
    const rows = [...dashboard.waiting, ...dashboard.unseen, ...dashboard.failed, ...dashboard.other, ...dashboard.far];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.state).toBe(expected);
    expect(dashboard.unseen).toEqual([]);
    expect(local.managed.stale).toEqual({ createdAtMs: 100, cwd: "/work/stale" });
  });

  test("Host 托管真值与插件 KV managed 记录保持分离", () => {
    const local = emptyLocalThreadState();
    local.managed.stale = { createdAtMs: 100, cwd: "/work/stale" };
    const dashboard = buildDashboard(
      [{ id: "stale", cwd: "/work/stale", name: "旧记录", recencyAt: 1 }],
      [],
      local,
      2_000,
    );
    const row = [...dashboard.waiting, ...dashboard.unseen, ...dashboard.failed, ...dashboard.other, ...dashboard.far][0]!;
    expect(row.managedByDriver).toBeTrue();
    expect(desktopOpenAvailability(row, [], {
      handoffFeatureKnown: true,
      handoffAvailable: false,
    })).toEqual({ disabled: false, label: "在 Codex 打开" });
  });

  test("Desktop 交接只按 Host 活动态与明确 ownership 能力禁用", () => {
    const local = emptyLocalThreadState();
    const runtime = [
      { threadId: "target", state: "completed" as const, lastEventMs: 10, managedByDriver: true, pendingRequests: [] },
      { threadId: "other", state: "thinking" as const, lastEventMs: 11, managedByDriver: true, pendingRequests: [] },
    ];
    const target = buildDashboard([{ id: "target", cwd: "/work", recencyAt: 1 }], runtime, local, 20).unseen[0]!;
    expect(desktopOpenAvailability(target, runtime, {
      handoffFeatureKnown: true,
      handoffAvailable: true,
    })).toEqual({ disabled: true, label: "等其他任务完成" });
    expect(desktopOpenAvailability(target, [runtime[0]!], {
      handoffFeatureKnown: true,
      handoffAvailable: false,
    })).toEqual({ disabled: true, label: "当前连接无法交接" });
    expect(desktopOpenAvailability(target, [runtime[0]!], {
      handoffFeatureKnown: false,
      handoffAvailable: undefined,
    })).toEqual({ disabled: false, label: "在 Codex 打开" });
  });

  test("结构化 BridgeError 显示真实 code 和用户消息", () => {
    expect(formatCodexError({
      code: "CODEX_LINK_NOT_CONNECTED",
      userMessage: "未连接到 Codex app-server",
      retryable: false,
    })).toBe("CODEX_LINK_NOT_CONNECTED · 未连接到 Codex app-server");
    expect(formatCodexError({ code: "BROKEN", message: "协议不兼容" }))
      .toBe("BROKEN · 协议不兼容");
    expect(formatCodexError(new Error("本地进程退出"))).toBe("本地进程退出");
    expect(formatCodexError({ unexpected: true })).not.toContain("[object Object]");
  });

  test("待处理在最上方，运行中其次，最近对话去重并按活跃时间排序", () => {
    const waiting = thread("waiting", {
      type: "active",
      activeFlags: ["waitingOnApproval"],
    }, 10);
    const running = thread("running", { type: "active", activeFlags: [] }, 20);
    const recent = thread("recent", { type: "idle" }, 30);
    const duplicate = thread("running", { type: "notLoaded" }, 40);

    const grouped = partitionThreads([recent, duplicate], [running, waiting]);
    expect(grouped.needsAttention.map((item) => item.id)).toEqual(["waiting"]);
    expect(grouped.active.map((item) => item.id)).toEqual(["running"]);
    expect(grouped.recent.map((item) => item.id)).toEqual(["recent"]);
  });
});
