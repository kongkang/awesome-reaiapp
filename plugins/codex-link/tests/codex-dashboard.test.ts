import { describe, expect, test } from "bun:test";
import {
  buildDashboard,
  emptyLocalThreadState,
  markThreadSeen,
  markThreadUnseen,
  parseLocalThreadState,
  pruneLocalThreadState,
  resolveApprovalTarget,
  routeSkillAction,
  type CodexThread,
  type LocalThreadState,
  type RuntimeThreadSnapshot,
} from "../src/codex-model";

const NOW = Date.UTC(2026, 7, 11, 12);
const UUID = {
  waiting: "019ff15d-20e1-7123-a4b1-1807dcc44196",
  unread: "019ff12b-e08a-7c82-a762-ba9d4fa04d11",
  running: "019ff662-e08a-7c82-a762-ba9d4fa04d22",
  external: "019ff234-e08a-7c82-a762-ba9d4fa04d33",
  old: "019fc881-e08a-7c82-a762-ba9d4fa04d44",
};

function history(id: string, ageMinutes: number, cwd = `/work/${id}`): CodexThread {
  return {
    id,
    cwd,
    name: id,
    preview: "",
    // app-server 的 recencyAt 是 Unix 秒；view model 必须统一为毫秒。
    recencyAt: (NOW - ageMinutes * 60_000) / 1_000,
    status: { type: "idle" },
  };
}

function runtime(
  threadId: string,
  state: RuntimeThreadSnapshot["state"],
  ageMinutes: number,
  extra: Partial<RuntimeThreadSnapshot> = {},
): RuntimeThreadSnapshot {
  return {
    threadId,
    state,
    lastEventMs: NOW - ageMinutes * 60_000,
    managedByDriver: true,
    pendingRequests: [],
    ...extra,
  };
}

describe("Codex Link 0.3 调度模型", () => {
  test("Unix 秒统一成毫秒，并按 在等你→干完未看→其余→48h+ 分档", () => {
    const local: LocalThreadState = {
      version: 1,
      managed: {
        [UUID.waiting]: { createdAtMs: NOW - 60_000, cwd: "/work/waiting" },
        [UUID.unread]: { createdAtMs: NOW - 120_000, cwd: "/work/unread" },
        [UUID.running]: { createdAtMs: NOW - 180_000, cwd: "/work/running" },
      },
      seenAtMs: {},
    };
    const result = buildDashboard(
      [
        history(UUID.running, 2),
        history(UUID.unread, 38),
        history(UUID.external, 5),
        history(UUID.waiting, 4),
        history(UUID.old, 3_120),
      ],
      [
        runtime(UUID.waiting, "needsInput", 4, {
          waitingReason: "等待你批准命令",
          activeTurnId: "turn-waiting",
          pendingRequests: [{
            serverRequestId: 7,
            kind: "commandApproval",
            summary: "运行 bun test",
          }],
        }),
        runtime(UUID.unread, "completed", 38),
        runtime(UUID.running, "thinking", 2, { activeTurnId: "turn-running" }),
      ],
      local,
      NOW,
    );

    expect(result.waiting.map((item) => item.id)).toEqual([UUID.waiting]);
    expect(result.unseen.map((item) => item.id)).toEqual([UUID.unread]);
    expect(result.other.map((item) => item.id)).toEqual([UUID.running, UUID.external]);
    expect(result.far.map((item) => item.id)).toEqual([UUID.old]);
    expect(result.waiting[0]?.recencyAtMs).toBe(NOW - 4 * 60_000);
    expect(result.waiting[0]?.waitingReason).toBe("等待你批准命令");
  });

  test("只有 Driver 托管的完成任务会进入干完未看，外部历史绝不按时间猜", () => {
    const local = emptyLocalThreadState();
    const result = buildDashboard(
      [history(UUID.external, 1), history(UUID.unread, 2)],
      [runtime(UUID.unread, "completed", 2)],
      local,
      NOW,
    );
    expect(result.unseen.map((item) => item.id)).toEqual([UUID.unread]);
    expect(result.other.map((item) => item.id)).toEqual([UUID.external]);
  });

  test("手工已看与未看可逆，分页没出现的记录不会被清掉", () => {
    const initial: LocalThreadState = {
      version: 1,
      managed: {
        [UUID.unread]: { createdAtMs: NOW - 1_000, cwd: "/work/unread" },
      },
      seenAtMs: {},
    };
    const seen = markThreadSeen(initial, UUID.unread, NOW);
    expect(seen.seenAtMs[UUID.unread]).toBe(NOW);
    const unseen = markThreadUnseen(seen, UUID.unread);
    expect(unseen.seenAtMs[UUID.unread]).toBeUndefined();

    const pruned = pruneLocalThreadState(seen, NOW, {
      maxThreadRecords: 100,
      maxBytes: 256 * 1024,
    });
    expect(pruned.managed[UUID.unread]).toEqual(initial.managed[UUID.unread]);
    expect(pruned.seenAtMs[UUID.unread]).toBe(NOW);
  });

  test("损坏 KV 安全回空；90 天、条数和字节预算按 LRU 裁剪", () => {
    const parsed = parseLocalThreadState("{bad json");
    expect(parsed.state).toEqual(emptyLocalThreadState());
    expect(parsed.warning).toContain("损坏");

    const state = emptyLocalThreadState();
    for (let i = 0; i < 12; i += 1) {
      const id = `019ff${String(i).padStart(3, "0")}-e08a-7c82-a762-ba9d4fa0${String(i).padStart(4, "0")}`;
      state.managed[id] = {
        createdAtMs: NOW - i * 86_400_000,
        cwd: `/a/very/long/path/${"x".repeat(60)}/${i}`,
      };
      state.seenAtMs[id] = NOW - i * 86_400_000;
    }
    const pruned = pruneLocalThreadState(state, NOW, {
      maxAgeMs: 90 * 86_400_000,
      maxThreadRecords: 5,
      maxBytes: 950,
    });
    expect(Object.keys(pruned.managed).length).toBeLessThanOrEqual(5);
    expect(new TextEncoder().encode(JSON.stringify(pruned)).byteLength).toBeLessThanOrEqual(950);
    expect(pruned.managed["019ff000-e08a-7c82-a762-ba9d4fa00000"]).toBeDefined();
  });

  test("硬件审批只命中明确目标，多条歧义时 fail closed", () => {
    const pending = [
      { serverRequestId: 11, threadId: UUID.waiting, kind: "commandApproval" as const, summary: "A" },
      { serverRequestId: 12, threadId: UUID.unread, kind: "fileChangeApproval" as const, summary: "B" },
    ];
    expect(resolveApprovalTarget(pending, UUID.waiting)).toEqual({ ok: true, serverRequestId: 11 });
    expect(resolveApprovalTarget(pending)).toMatchObject({ ok: false, code: "AMBIGUOUS" });
    expect(resolveApprovalTarget(pending, UUID.external)).toMatchObject({ ok: false, code: "NOT_FOUND" });
  });

  test("Skill 对空闲 start、运行 steer、等待输入拒绝", () => {
    const skill = { name: "test-first", path: "/skills/test-first/SKILL.md" };
    expect(routeSkillAction(runtime(UUID.unread, "completed", 2), skill)).toEqual({
      method: "codex.start_turn",
      params: {
        threadId: UUID.unread,
        input: [{ type: "skill", name: skill.name, path: skill.path }],
      },
    });
    expect(routeSkillAction(
      runtime(UUID.running, "thinking", 1, { activeTurnId: "turn-running" }),
      skill,
    )).toEqual({
      method: "codex.steer_turn",
      params: {
        threadId: UUID.running,
        expectedTurnId: "turn-running",
        input: [{ type: "skill", name: skill.name, path: skill.path }],
      },
    });
    expect(() => routeSkillAction(runtime(UUID.waiting, "needsInput", 1), skill))
      .toThrow("正在等你处理");
  });
});
