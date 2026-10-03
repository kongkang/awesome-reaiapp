import { describe, expect, test } from "bun:test";
import {
  DesktopObservationModel,
  DESKTOP_IDENTITIES_PER_THREAD,
  DESKTOP_STATE_MAX_BYTES,
  desktopObservationFrame,
  desktopThreadGroup,
  parseDesktopObservationState,
  type DesktopObservation,
  type DesktopPresentationReceipt,
} from "../src/codex-model";

const result = { turnId: "turn-1", resultId: "result-1", status: "completed" as const };
function event(overrides: Partial<DesktopObservation> = {}): DesktopObservation {
  return { sourceId: "native-1", threadId: "thread-1", epoch: "connection-1", sequence: 1,
    observedAtMs: 1_000, origin: "live", kind: "status", activity: "running",
    activeTurnId: "turn-1", ...overrides };
}
function model(): DesktopObservationModel {
  const value = new DesktopObservationModel();
  value.connect("native-1", "connection-1", "verified-native");
  value.finishBaseline("connection-1");
  return value;
}
function receipt(overrides: Partial<DesktopPresentationReceipt> = {}): DesktopPresentationReceipt {
  return { kind: "presented", sourceId: "native-1", threadId: "thread-1",
    epoch: "connection-1", turnId: "turn-1", resultId: "result-1", ...overrides };
}

describe("F06 native 内部模型（不是 Desktop 实测）", () => {
  test("所有 running 进入运行档，不生成系统通知候选", () => {
    const value = model();
    for (let i = 0; i < 150; i++) {
      expect(value.apply(event({ threadId: "thread-" + i })).notice).toBeUndefined();
    }
    expect(value.groups().running).toHaveLength(150);
    expect(Object.keys(value.groups())).toEqual(["attention", "unseen", "running", "history"]);
  });

  test("等待、新结束、运行、已看历史互斥；未看结果不会按年龄或五条上限折叠", () => {
    const value = model();
    value.apply(event({ threadId: "waiting", activity: "needs-user", attentionId: "request-1" }));
    value.apply(event({ threadId: "running" }));
    for (let i = 0; i < 8; i++) {
      value.apply(event({ threadId: "done-" + i, kind: "turn-ended", activity: "idle",
        activeTurnId: undefined, result, observedAtMs: 1 }));
    }
    value.presented(receipt({ threadId: "done-0" }));
    const groups = value.groups();
    expect(groups.attention.map((row) => row.threadId)).toEqual(["waiting"]);
    expect(groups.unseen).toHaveLength(7);
    expect(groups.running.map((row) => row.threadId)).toEqual(["running"]);
    expect(groups.history.map((row) => row.threadId)).toEqual(["done-0"]);
    expect(value.visibleRows()).toHaveLength(9);
    const beforeExpand = value.snapshot();
    value.setHistoryExpanded(true);
    expect(value.visibleRows()).toHaveLength(10);
    expect(value.groups()).toEqual(groups);
    expect(value.snapshot()).toEqual(beforeExpand); // 展开不改变已看或会话状态。
    value.setHistoryExpanded(false);
    expect(value.visibleRows()).toHaveLength(9);
  });

  test("只有两类实时转换候选，同一事项/结果重复不再通知", () => {
    const value = model();
    expect(value.apply(event()).notice).toBeUndefined();
    expect(value.apply(event({ sequence: 2, activity: "needs-user", attentionId: "request-1" })).notice?.kind)
      .toBe("needs-user");
    expect(value.apply(event({ sequence: 3, activity: "needs-user", attentionId: "request-1" })).notice)
      .toBeUndefined();
    expect(value.apply(event({ sequence: 4, kind: "turn-ended", activity: "idle", activeTurnId: undefined, result })).notice?.kind)
      .toBe("turn-ended");
    expect(value.apply(event({ sequence: 5, kind: "turn-ended", activity: "idle", activeTurnId: undefined, result })).notice)
      .toBeUndefined();
    expect(value.apply(event({ sequence: 6, activity: "error", activeTurnId: undefined })).notice)
      .toBeUndefined();
  });

  test("启动/刷新/重连的旧终局和等待只对账，不制造新通知", () => {
    const value = new DesktopObservationModel();
    value.connect("native-1", "connection-1", "verified-native");
    expect(value.apply(event({ kind: "turn-ended", activity: "idle", result, activeTurnId: undefined })).notice)
      .toBeUndefined(); // baseline 尚未完成。
    value.finishBaseline("connection-1");
    expect(value.apply(event({ sequence: 2, kind: "snapshot", origin: "baseline", activity: "idle", result })).notice)
      .toBeUndefined();
    value.connect("native-1", "connection-2", "verified-native");
    expect(value.apply(event({ epoch: "connection-2", kind: "snapshot", origin: "baseline",
      activity: "needs-user", attentionId: "request-old" })).notice).toBeUndefined();
    value.finishBaseline("connection-2");
    expect(value.apply(event({ epoch: "connection-2", sequence: 2, activity: "needs-user",
      attentionId: "request-old" })).notice).toBeUndefined();
  });

  test("idle/notLoaded适配的unknown、断连都不产生完成", () => {
    const value = model();
    value.apply(event());
    value.apply(event({ sequence: 2, activity: "idle", activeTurnId: undefined }));
    expect(value.rows()[0]?.result).toBeUndefined();
    expect(value.groups().unseen).toEqual([]);
    value.apply(event({ sequence: 3, activity: "unknown", activeTurnId: undefined }));
    value.disconnect();
    expect(value.rows()[0]?.freshness).toBe("stale");
    expect(value.groups().history).toEqual([]);
  });

  test("未知来源、错误epoch、重复或乱序事件不能污染当前会话", () => {
    const value = new DesktopObservationModel();
    expect(value.connect("native-1", "connection-1", "unknown")).toBeFalse();
    expect(value.apply(event()).applied).toBeFalse();
    value.connect("native-1", "connection-1", "verified-native");
    value.finishBaseline("connection-1");
    value.apply(event({ sequence: 5 }));
    for (const invalid of [
      event({ sourceId: "other" }), event({ epoch: "old" }),
      event({ sequence: 4 }), event({ sequence: 5 }),
      event({ sequence: NaN }), event({ sequence: 6, kind: "status", result }),
    ]) expect(value.apply(invalid).applied).toBeFalse();
    expect(value.rows()[0]?.activity).toBe("running");
  });

  test("旧回合的晚到结束不能覆盖新的活动回合", () => {
    const value = model();
    value.apply(event({ activeTurnId: "turn-new", sequence: 8 }));
    expect(value.apply(event({ sequence: 9, kind: "turn-ended", activity: "idle",
      activeTurnId: undefined, result })).applied).toBeFalse();
    expect(value.groups().running[0]?.activeTurnId).toBe("turn-new");
  });

  test.each([
    { kind: "accepted" as const }, { sourceId: "other" }, { threadId: "other" },
    { epoch: "old" }, { turnId: "other" }, { resultId: "other" },
  ])("accepted/错目标/旧回执不标已看 %j", (invalid) => {
    const value = model();
    value.apply(event({ kind: "turn-ended", activity: "idle", activeTurnId: undefined, result }));
    expect(value.presented(receipt(invalid))).toBeFalse();
    expect(value.groups().unseen).toHaveLength(1);
    expect(value.groups().history).toEqual([]);
  });

  test("打开期间新结果到达，旧结果回执不能清新结果；新回合运行不入历史", () => {
    const value = model();
    value.apply(event({ kind: "turn-ended", activity: "idle", activeTurnId: undefined, result }));
    const newer = { ...result, resultId: "result-2", turnId: "turn-2" };
    value.apply(event({ sequence: 2, kind: "turn-ended", activity: "idle",
      activeTurnId: undefined, result: newer }));
    expect(value.presented(receipt())).toBeFalse();
    expect(value.groups().unseen).toHaveLength(1);
    expect(value.presented(receipt(newer))).toBeTrue();
    value.apply(event({ sequence: 3, activeTurnId: "turn-3" }));
    expect(value.groups().history).toEqual([]);
    expect(value.groups().running).toHaveLength(1);
  });

  test("同threadId跨实例不合并，重建只恢复历史水位不伪装实时", () => {
    const value = model();
    value.apply(event({ kind: "turn-ended", activity: "idle", activeTurnId: undefined, result }));
    value.presented(receipt());
    value.connect("native-2", "connection-2", "verified-native");
    value.finishBaseline("connection-2");
    value.apply(event({ sourceId: "native-2", epoch: "connection-2" }));
    expect(value.rows()).toHaveLength(2);
    const restored = new DesktopObservationModel(value.snapshot());
    expect(restored.rows().every((row) => row.freshness === "stale")).toBeTrue();
    expect(restored.groups().history[0]?.sourceId).toBe("native-1");
    expect(restored.presented(receipt())).toBeFalse();
  });

  test("新键严格解析；旧seen不会变成native阅读证据，未知/坏数据不可写", () => {
    expect(parseDesktopObservationState(undefined)).toMatchObject({ writable: true, state: { records: [] } });
    for (const raw of ["", "{broken", { version: 2, records: [] }, { version: 1, records: [], futureWatermark: 1 },
      { version: 1, managed: {}, seenAtMs: { "thread-1": 100 } },
      { version: 1, records: [{ sourceId: "source", threadId: "id", activity: "idle", result: {} }] },
    ]) expect(parseDesktopObservationState(raw).writable).toBeFalse();
    expect(desktopThreadGroup({ sourceId: "s", threadId: "t", activity: "unknown" })).toBeUndefined();
  });
});

describe("F06 Code Review 回归", () => {
  test("R1已看、R2未看后R1隔次重放不盖未读；重启重连同样保护", () => {
    let value = model();
    value.apply(event({ kind: "turn-ended", activity: "idle", activeTurnId: undefined, result }));
    value.presented(receipt());
    const newer = { ...result, turnId: "turn-2", resultId: "result-2" };
    value.apply(event({ sequence: 2, kind: "turn-ended", activity: "idle", activeTurnId: undefined, result: newer }));
    const replay = value.apply(event({ sequence: 3, kind: "turn-ended", activity: "idle", activeTurnId: undefined, result }));
    expect(replay.applied).toBeFalse();
    expect(replay.notice).toBeUndefined();
    expect(value.groups().unseen[0]?.result).toEqual(newer);
    expect(value.groups().history).toEqual([]);
    value = new DesktopObservationModel(value.snapshot());
    value.connect("native-1", "connection-2", "verified-native");
    expect(value.apply(event({ epoch: "connection-2", kind: "snapshot", origin: "baseline",
      activity: "idle", result })).applied).toBeFalse();
    expect(value.rows()[0]?.result).toEqual(newer);
  });

  test("事项A-B-A不重复通知，持久恢复也保留已知事项身份", () => {
    const value = model();
    value.apply(event({ activity: "needs-user", attentionId: "A" }));
    value.apply(event({ sequence: 2, activity: "needs-user", attentionId: "B" }));
    expect(value.apply(event({ sequence: 3, activity: "needs-user", attentionId: "A" })).notice).toBeUndefined();
    const restored = new DesktopObservationModel(value.snapshot());
    restored.connect("native-1", "connection-2", "verified-native");
    restored.finishBaseline("connection-2");
    expect(restored.apply(event({ epoch: "connection-2", activity: "needs-user", attentionId: "B" })).notice)
      .toBeUndefined();
  });

  test.each(["running", "needs-user"] as const)("无ID的%s状态不解除新活动回合身份", (activity) => {
    const value = model();
    value.apply(event({ activeTurnId: "turn-new" }));
    value.apply(event({ sequence: 2, activity, activeTurnId: undefined }));
    expect(value.apply(event({ sequence: 3, kind: "turn-ended", activity: "idle",
      activeTurnId: undefined, result })).applied).toBeFalse();
    expect(value.rows()[0]?.activeTurnId).toBe("turn-new");
    expect(value.rows()[0]?.activity).toBe(activity);
  });

  test("非法连接尝试不替换有效连接；无事项身份显式报告且不猜通知", () => {
    const value = model();
    expect(value.connect("other", "bad", "unknown")).toBeFalse();
    const applied = value.apply(event({ activity: "needs-user", activeTurnId: undefined }));
    expect(applied).toMatchObject({ applied: true, issue: "attention-identity-unavailable" });
    expect(applied.notice).toBeUndefined();
    expect(value.groups().attention).toHaveLength(1);
  });

  test("多会话交错状态遵守四档，未看结果加新运行仍排未看", () => {
    const value = model();
    value.apply(event({ threadId: "A" })); value.apply(event({ threadId: "B" }));
    value.apply(event({ sequence: 2, threadId: "A", activity: "needs-user", attentionId: "request" }));
    value.apply(event({ sequence: 2, threadId: "B", kind: "turn-ended", activity: "idle", activeTurnId: undefined, result }));
    value.apply(event({ sequence: 3, threadId: "B", activeTurnId: "new-turn" }));
    value.apply(event({ threadId: "C" }));
    expect(value.visibleRows().map((row) => row.threadId)).toEqual(["A", "B", "C"]);
    expect(value.groups().unseen[0]?.activity).toBe("running");
    value.apply(event({ sequence: 2, threadId: "C", activity: "idle", activeTurnId: undefined }));
    expect(value.visibleRows().map((row) => row.threadId)).toEqual(["A", "B"]);
    expect(value.rows().find((row) => row.threadId === "C")).toMatchObject({ activity: "idle", result: undefined });
  });

  test("快照只裁无身份的无档位行，无损压缩历史且不改变内存展示", () => {
    const value = model();
    value.apply(event({ threadId: "attention", activity: "needs-user", attentionId: "A" }));
    value.apply(event({ threadId: "unseen", kind: "turn-ended", activity: "idle", activeTurnId: undefined, result }));
    value.apply(event({ threadId: "running" }));
    for (let i = 0; i < 997; i++) {
      const threadId = "history-" + i;
      value.apply(event({ threadId, kind: "turn-ended", activity: "idle", activeTurnId: undefined, result, observedAtMs: i }));
      value.presented(receipt({ threadId }));
    }
    value.apply(event({ threadId: "unknown", activity: "unknown", activeTurnId: undefined }));
    const snapshot = value.snapshot();
    expect(snapshot.records.length).toBeLessThanOrEqual(1_000);
    expect(new TextEncoder().encode(JSON.stringify(snapshot)).byteLength).toBeLessThanOrEqual(DESKTOP_STATE_MAX_BYTES);
    expect(snapshot.records.filter((row) => ["attention", "unseen", "running"].includes(row.threadId))).toHaveLength(3);
    expect(snapshot.records.some((row) => row.threadId === "unknown")).toBeFalse();
    expect(snapshot.records.some((row) => row.threadId === "history-0")).toBeTrue();
    expect(snapshot.records.some((row) => row.threadId === "history-996")).toBeTrue();
    expect(value.groups().history).toHaveLength(997);
    expect(parseDesktopObservationState(snapshot).writable).toBeTrue();
    expect(new DesktopObservationModel(snapshot).rows().find((row) => row.threadId === "history-996")?.observedAtMs).toBe(996);
  });

  test("字节预算独立生效；保护记录超限明确失败，成为已看后可恢复", () => {
    const value = model();
    const longId = "x".repeat(800);
    for (let i = 0; i < 130; i++) {
      const threadId = "long-" + i;
      const longResult = { ...result, resultId: longId + i };
      value.apply(event({ threadId, kind: "turn-ended", activity: "idle", activeTurnId: undefined, result: longResult }));
    }
    expect(() => value.snapshot()).toThrow("保护记录超过持久预算");
    expect(value.groups().unseen).toHaveLength(130);
    for (let i = 0; i < 130; i++) value.presented(receipt({ threadId: "long-" + i, resultId: longId + i }));
    const recovered = value.snapshot();
    expect(recovered.records.length).toBe(130);
    expect(parseDesktopObservationState(recovered).writable).toBeTrue();
    expect(value.groups().history).toHaveLength(130);
  });

  test("身份预算满时明确保留水位，不淘汰旧ID后误报", () => {
    const value = model();
    for (let i = 0; i < DESKTOP_IDENTITIES_PER_THREAD; i++) {
      value.apply(event({ sequence: i + 1, kind: "turn-ended", activity: "idle", activeTurnId: undefined,
        result: { ...result, resultId: "r-" + i, turnId: "t-" + i } }));
    }
    expect(value.apply(event({ sequence: 999, kind: "turn-ended", activity: "idle", activeTurnId: undefined,
      result: { ...result, resultId: "overflow" } }))).toEqual({ applied: true, issue: "identity-budget" });
    expect(value.rows()[0]?.result?.resultId).toBe("overflow");
    expect(value.rows()[0]?.observationIssue).toBe("identity-budget");
    expect(value.rows()[0]?.observedResultIds).toHaveLength(DESKTOP_IDENTITIES_PER_THREAD);
    expect(parseDesktopObservationState(value.snapshot()).writable).toBeTrue();
    expect(value.rows()[0]?.freshness).toBe("stale");
    expect(value.apply(event({ sequence: 1_000, kind: "turn-ended", activity: "idle", activeTurnId: undefined,
      result: { ...result, resultId: "r-0", turnId: "t-0" } })).applied).toBeFalse();
  });
});

describe("F06 第二轮预算缺口回归", () => {
  test("缺口推进顺序且经普通idle/重建仍不允许旧或新回执标已看", () => {
    const value = model();
    for (let i = 0; i < DESKTOP_IDENTITIES_PER_THREAD; i++) {
      value.apply(event({ sequence: i + 1, kind: "turn-ended", activity: "idle", activeTurnId: undefined,
        result: { ...result, resultId: "r-" + i, turnId: "t-" + i } }));
    }
    const latest = { ...result, resultId: "overflow", turnId: "overflow-turn" };
    value.apply(event({ sequence: 999, kind: "turn-ended", activity: "idle", activeTurnId: undefined, result: latest }));
    expect(value.apply(event({ sequence: 998, activity: "idle", activeTurnId: undefined })).applied).toBeFalse();
    expect(value.apply(event({ sequence: 1_000, activity: "idle", activeTurnId: undefined })))
      .toMatchObject({ applied: true, issue: "identity-budget" });
    expect(value.presented(receipt({ resultId: "r-255", turnId: "t-255" }))).toBeFalse();
    expect(value.presented(receipt(latest))).toBeFalse();
    expect(value.groups().history).toHaveLength(0);
    expect(value.groups().attention[0]?.result).toEqual(latest);
    const snapshot = value.snapshot();
    expect(parseDesktopObservationState(snapshot).writable).toBeTrue();
    const restored = new DesktopObservationModel(snapshot);
    restored.connect("native-1", "connection-2", "verified-native");
    restored.finishBaseline("connection-2");
    restored.apply(event({ epoch: "connection-2", activity: "idle", activeTurnId: undefined }));
    expect(restored.presented(receipt({ ...latest, epoch: "connection-2" }))).toBeFalse();
    expect(restored.groups().attention).toHaveLength(1);
    expect(restored.groups().history).toHaveLength(0);
    expect(restored.snapshot().records[0]?.observationIssue).toBe("identity-budget");
  });

  test("事项身份预算满仍接收真实等待状态，保留缺口而不重报", () => {
    const value = model();
    for (let i = 0; i < DESKTOP_IDENTITIES_PER_THREAD; i++) {
      value.apply(event({ sequence: i + 1, activity: "needs-user", attentionId: "a-" + i }));
    }
    value.apply(event({ sequence: 257 }));
    const overflow = value.apply(event({ sequence: 258, activity: "needs-user", attentionId: "overflow" }));
    expect(overflow).toEqual({ applied: true, issue: "identity-budget" });
    expect(value.groups().attention[0]?.activity).toBe("needs-user");
    expect(value.rows()[0]?.lastAttentionId).toBe("overflow");
    expect(value.rows()[0]?.observedAttentionIds).toHaveLength(DESKTOP_IDENTITIES_PER_THREAD);
    expect(parseDesktopObservationState(value.snapshot()).writable).toBeTrue();
  });

  test("无法匹配活动回合与已知被取代结果返回不同的明确诊断", () => {
    const value = model();
    value.apply(event({ activeTurnId: "turn-new" }));
    expect(value.apply(event({ sequence: 2, kind: "turn-ended", activity: "idle", activeTurnId: undefined, result })))
      .toEqual({ applied: false, issue: "turn-identity-conflict" });
    value.apply(event({ sequence: 3, kind: "turn-ended", activity: "idle", activeTurnId: undefined,
      result: { ...result, turnId: "turn-new" } }));
    value.apply(event({ sequence: 4, kind: "turn-ended", activity: "idle", activeTurnId: undefined,
      result: { ...result, turnId: "turn-next", resultId: "result-next" } }));
    expect(value.apply(event({ sequence: 5, kind: "snapshot", origin: "baseline", activity: "idle", result })))
      .toEqual({ applied: false, issue: "result-superseded" });
  });
});

describe("F06 frame 映射器：DesktopObservedThread → Host TaskObservationFrame", () => {
  test("五值活动映射、revision=sequence+1、结果水位与已看透传、缺省时间不伪造更早开始", () => {
    const mapping: Array<[import("../src/codex-model").DesktopActivity,
      import("../src/codex-model").HostObservationActivity]> = [
      ["unknown", "unknown"], ["idle", "idle"], ["running", "running"],
      ["needs-user", "needsUser"], ["error", "problem"],
    ];
    for (const [activity, expected] of mapping) {
      const value = model();
      value.apply(event({ threadId: "t-" + activity, sequence: 2, activity }));
      const row = value.rows().find((r) => r.threadId === "t-" + activity)!;
      const mapped = desktopObservationFrame(row, { title: "会话 " + activity });
      expect(mapped.refused).toBeUndefined();
      expect(mapped.frame!.activity).toBe(expected);
      expect(mapped.frame!.revision).toBe(3);
      expect(mapped.frame!.entityId).toBe("t-" + activity);
      expect(mapped.frame!.sourceEpoch).toBe("connection-1");
      expect(mapped.frame!.freshness).toBe("current");
      expect(mapped.frame!.startedAt).toBe(1_000);
      expect(mapped.frame!.activatedAt).toBe(1_000);
    }
    const value = model();
    value.apply(event({ threadId: "t-done", sequence: 3, kind: "turn-ended", origin: "live",
      activity: "idle", result: { turnId: "turn-9", resultId: "result-9", status: "failed" } }));
    value.presented({ ...receipt(), threadId: "t-done", turnId: "turn-9", resultId: "result-9" });
    const row = value.rows().find((r) => r.threadId === "t-done")!;
    const mapped = desktopObservationFrame(row, { title: "x", startedAtMs: 500,
      openCommand: { id: "open-1", input: { threadId: "t-done" } } });
    expect(mapped.frame!.result).toEqual({ id: "result-9", outcome: "failed", endedAt: 1_000 });
    expect(mapped.frame!.seenResultId).toBe("result-9");
    expect(mapped.frame!.startedAt).toBe(500);
    expect(mapped.frame!.openCommand).toEqual({ id: "open-1", input: { threadId: "t-done" } });
  });

  test("保守拒绝：未在本连接观察过的恢复行、非法标题/实体/已看错位/openCommand", () => {
    const restored = new DesktopObservationModel({
      version: 1,
      records: [{ sourceId: "native-1", threadId: "thread-old", activity: "idle" }],
    });
    expect(desktopObservationFrame(restored.rows()[0]!, { title: "旧会话" }).refused).toBe("not-observed");
    const value = model();
    value.apply(event({ sequence: 1 }));
    const row = value.rows()[0]!;
    expect(desktopObservationFrame(row, { title: "   " }).refused).toBe("invalid-title");
    expect(desktopObservationFrame(row, { title: "bad\u0007title" }).refused).toBe("invalid-title");
    const odd = model();
    odd.apply(event({ threadId: "x".repeat(129), sequence: 1 }));
    expect(desktopObservationFrame(odd.rows()[0]!, { title: "ok" }).refused).toBe("invalid-entity");
    const badEpoch = model();
    badEpoch.apply(event({ sequence: 1 }));
    const rawEpoch = { ...badEpoch.rows()[0]!, epoch: "e".repeat(129) } as never;
    expect(desktopObservationFrame(rawEpoch, { title: "ok" }).refused).toBe("invalid-epoch");
    const mismatch = model();
    mismatch.apply(event({ sequence: 1 }));
    const raw = { ...mismatch.rows()[0]!, seenResultId: "result-other" } as never;
    expect(desktopObservationFrame(raw, { title: "ok" }).refused).toBe("seen-mismatch");
    expect(desktopObservationFrame(row, { title: "ok", openCommand: { id: "", input: {} } }).refused)
      .toBe("invalid-open-command");
    expect(desktopObservationFrame(row, { title: "ok", openCommand: { id: "open", input: "y".repeat(9_000) } }).refused)
      .toBe("oversized");
  });

  test("已看旧结果后新结果未看：帧带新结果、省略已看，不再整体拒收", () => {
    const value = model();
    value.apply(event({ threadId: "t-seen", sequence: 2, kind: "turn-ended", origin: "live",
      activity: "idle", result: { turnId: "turn-1", resultId: "result-1", status: "completed" } }));
    value.presented({ ...receipt(), threadId: "t-seen" });
    value.apply(event({ threadId: "t-seen", sequence: 3, kind: "turn-ended", origin: "live",
      activity: "idle", result: { turnId: "turn-2", resultId: "result-2", status: "completed" } }));
    const row = value.rows().find((r) => r.threadId === "t-seen")!;
    const mapped = desktopObservationFrame(row, { title: "会话" });
    expect(mapped.refused).toBeUndefined();
    expect(mapped.frame!.result?.id).toBe("result-2");
    expect(mapped.frame!.seenResultId).toBeUndefined();
  });

  test("长度按字节：中文标题超限安全截断不拒绝，截断后不超 512 字节", () => {
    const value = model();
    value.apply(event({ threadId: "t-wide", sequence: 1 }));
    const row = value.rows().find((r) => r.threadId === "t-wide")!;
    const mapped = desktopObservationFrame(row, { title: "开".repeat(200) });
    expect(mapped.refused).toBeUndefined();
    expect(mapped.frame!.title.length).toBeLessThan(200);
    expect(new TextEncoder().encode(mapped.frame!.title).byteLength).toBeLessThanOrEqual(512);
    expect(desktopObservationFrame(row, { title: "x".repeat(600) }).frame!.title).toHaveLength(512);
  });

  test("identity-budget 缺口行仍如实映射为 stale，不虚构已看", () => {
    const value = new DesktopObservationModel();
    value.connect("native-1", "connection-1", "verified-native");
    value.finishBaseline("connection-1");
    for (let i = 0; i < 256; i++) {
      value.apply(event({ threadId: "thread-budget", sequence: i + 1,
        kind: "turn-ended", origin: "live", activity: "idle",
        result: { turnId: "turn-" + i, resultId: "result-" + i, status: "completed" } }));
    }
    const budget = value.apply(event({ threadId: "thread-budget", sequence: 300,
      kind: "turn-ended", origin: "live", activity: "idle",
      result: { turnId: "turn-new", resultId: "result-new", status: "completed" } }));
    expect(budget.issue).toBe("identity-budget");
    const row = value.rows().find((r) => r.threadId === "thread-budget")!;
    const mapped = desktopObservationFrame(row, { title: "缺口" });
    expect(mapped.refused).toBeUndefined();
    expect(mapped.frame!.freshness).toBe("stale");
    expect(mapped.frame!.seenResultId).toBeUndefined();
  });
});
