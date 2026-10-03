import { describe, expect, test, spyOn } from "bun:test";
import type { CodexStore } from "../src/codex-repository";
import {
  DESKTOP_OBSERVATION_KEY, DesktopObservationStorage, collectDesktopThreadPages,
} from "../src/codex-repository";
import { DesktopObservationModel, parseLocalThreadState, markThreadSeen, type DesktopObservationState } from "../src/codex-model";

function storeFixture(initial: Record<string, unknown> = {}) {
  const data = new Map(Object.entries(initial));
  const writes: string[] = [];
  let failWrite = false;
  const store: CodexStore = {
    get: async <T>(key: string) => data.get(key) as T | undefined,
    set: async (key: string, value: unknown) => {
      if (failWrite) throw new Error("disk full");
      writes.push(key); data.set(key, structuredClone(value));
    },
    delete: async (key: string) => { writes.push("delete:" + key); data.delete(key); },
    keys: async () => [...data.keys()],
  };
  return { data, writes, store, fail: (value: boolean) => { failWrite = value; } };
}
const state: DesktopObservationState = {
  version: 1, records: [{ sourceId: "native", threadId: "thread", activity: "idle",
    result: { turnId: "turn", resultId: "result", status: "completed" }, seenResultId: "result" }],
};

describe("F06 独立观察键", () => {
  test("旧版state读写不碰新键，新版读旧键不伪造native已看", async () => {
    const old = { version: 1, managed: {}, seenAtMs: { thread: 100 } };
    const fixture = storeFixture({ state: old, "compose-defaults": { cwd: "/keep" }, [DESKTOP_OBSERVATION_KEY]: state });
    const parsed = parseLocalThreadState(await fixture.store.get("state"));
    await fixture.store.set("state", markThreadSeen(parsed.state, "thread", 200));
    const repository = new DesktopObservationStorage(fixture.store);
    expect((await repository.load()).state).toEqual(state);
    expect(fixture.writes).toEqual(["state"]);
    expect(fixture.data.get("compose-defaults")).toEqual({ cwd: "/keep" });
    const oldOnly = new DesktopObservationStorage(storeFixture({ state: old }).store);
    expect((await oldOnly.load()).state.records).toEqual([]);
  });

  test.each(["{broken", "", { version: 2, records: [] }])("新键坏/未知格式零回写且后续save不覆盖 %j", async (raw) => {
    const fixture = storeFixture({ [DESKTOP_OBSERVATION_KEY]: raw, state: { keep: "legacy" } });
    const repository = new DesktopObservationStorage(fixture.store);
    expect((await repository.load()).writable).toBeFalse();
    await expect(repository.save(state)).rejects.toThrow("原值已保留");
    expect(fixture.writes).toEqual([]);
    expect(fixture.data.get(DESKTOP_OBSERVATION_KEY)).toEqual(raw);
    expect(fixture.data.get("state")).toEqual({ keep: "legacy" });
  });

  test("写失败不推进持久缓存，重试成功后再更新；外部修改返回值不污染缓存", async () => {
    const fixture = storeFixture();
    const repository = new DesktopObservationStorage(fixture.store);
    await repository.load();
    fixture.fail(true);
    await expect(repository.save(state)).rejects.toThrow("disk full");
    expect((await repository.load()).state.records).toEqual([]);
    fixture.fail(false);
    await repository.save(state);
    const loaded = await repository.load();
    loaded.state.records[0]!.seenResultId = "tampered";
    expect((await repository.load()).state.records[0]!.seenResultId).toBe("result");
    expect(fixture.writes).toEqual([DESKTOP_OBSERVATION_KEY]);
  });

  test("模型身份容量超限明确拒绝保存，旧持久状态及其他键保持可恢复", async () => {
    const fixture = storeFixture({ [DESKTOP_OBSERVATION_KEY]: state, state: { keep: "legacy" } });
    const repository = new DesktopObservationStorage(fixture.store);
    const model = new DesktopObservationModel((await repository.load()).state);
    model.connect("native", "next", "verified-native");
    model.finishBaseline("next");
    for (let i = 0; i < 1_000; i++) {
      const threadId = "new-" + i;
      model.apply({ sourceId: "native", threadId, epoch: "next", sequence: 1,
        observedAtMs: i + 1, kind: "turn-ended", origin: "live", activity: "idle",
        result: { turnId: "turn", resultId: "result", status: "completed" } });
      model.presented({ kind: "presented", sourceId: "native", threadId, epoch: "next",
        turnId: "turn", resultId: "result" });
    }
    await expect(Promise.resolve().then(() => repository.save(model.snapshot())))
      .rejects.toThrow("保护记录超过持久预算");
    expect(fixture.writes).toEqual([]);
    expect((await repository.load()).state).toEqual(state);
    expect((await new DesktopObservationStorage(fixture.store).load()).state).toEqual(state);
    expect(fixture.data.get("state")).toEqual({ keep: "legacy" });
    expect(model.groups().history).toHaveLength(1_001);
  });
});

describe("F06 元数据分页（注入页，不连接真实server）", () => {
  test("跨首100/空页继续cursor，跨页ID去重", async () => {
    const cursors: Array<string | null> = [];
    const value = await collectDesktopThreadPages(async (cursor) => {
      cursors.push(cursor);
      if (cursor === null) return { data: Array.from({ length: 100 }, (_, i) => ({ id: "t" + i })), nextCursor: "empty" };
      if (cursor === "empty") return { data: [], nextCursor: "last" };
      return { data: [{ id: "t99" }, { id: "t100" }] };
    });
    expect(cursors).toEqual([null, "empty", "last"]);
    expect(value.complete).toBeTrue();
    expect(value.threads).toHaveLength(101);
  });

  test("循环cursor、页数上限不谎报完整", async () => {
    const cycle = await collectDesktopThreadPages(async () => ({ data: [], nextCursor: "repeat" }));
    expect(cycle).toMatchObject({ complete: false, reason: "cursor-cycle", resumeCursor: "repeat" });
    const limited = await collectDesktopThreadPages(async () => ({ data: [{ id: "1" }], nextCursor: "next" }), { maxPages: 1 });
    expect(limited).toMatchObject({ complete: false, reason: "page-limit", resumeCursor: "next" });
  });

  test("行数预算命中保留当前页cursor，不跳过该页未消费的行", async () => {
    const value = await collectDesktopThreadPages(async () => ({ data: [{ id: "a" }, { id: "b" }], nextCursor: "after" }), { maxRows: 1 });
    expect(value).toMatchObject({ complete: false, reason: "row-limit", resumeCursor: null, threads: [{ id: "a" }] });
  });

  test("中途故障保留已读页并标partial，坏响应不当空成功", async () => {
    const partial = await collectDesktopThreadPages(async (cursor) => {
      if (cursor === null) return { data: [{ id: "a" }], nextCursor: "b" };
      throw new Error("offline");
    });
    expect(partial).toMatchObject({ complete: false, reason: "read-failed", threads: [{ id: "a" }], resumeCursor: "b" });
    const bad = await collectDesktopThreadPages(async () => ({ data: undefined } as never));
    expect(bad).toMatchObject({ complete: false, reason: "invalid-page" });
  });

  test("取消和不响应provider的超时及时结束，晚到页不消费", async () => {
    const controller = new AbortController();
    let resolvePage!: (page: { data: Array<{ id: string }> }) => void;
    const pending = collectDesktopThreadPages(() => new Promise((resolve) => { resolvePage = resolve; }), { signal: controller.signal });
    await Promise.resolve();
    controller.abort();
    expect(await pending).toMatchObject({ complete: false, reason: "cancelled", threads: [] });
    resolvePage({ data: [{ id: "late" }] });
    const timeout = await collectDesktopThreadPages(() => new Promise(() => {}), { timeoutMs: 2 });
    expect(timeout).toMatchObject({ complete: false, reason: "timeout", threads: [] });
  });

  test("已取消时不调用provider", async () => {
    const controller = new AbortController(); controller.abort();
    let calls = 0;
    const value = await collectDesktopThreadPages(async () => { calls++; return { data: [] }; }, { signal: controller.signal });
    expect(calls).toBe(0);
    expect(value.reason).toBe("cancelled");
  });
});

describe("F06 分页与存储审查回归", () => {
  test("provider跨过deadline但timer未执行时不得消费页或报告完整", async () => {
    let now = 1_000;
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    try {
      const value = await collectDesktopThreadPages(async () => {
        now += 100;
        return { data: [{ id: "too-late" }] };
      }, { timeoutMs: 20 });
      expect(value).toEqual({ threads: [], complete: false, resumeCursor: null, reason: "timeout" });
    } finally { clock.mockRestore(); }
  });

  test("超限save零写入且缓存保留，下一次有效save恢复", async () => {
    const fixture = storeFixture(); const repository = new DesktopObservationStorage(fixture.store);
    await repository.save(state);
    const oversized: DesktopObservationState = { version: 1, records: Array.from({ length: 1_001 },
      (_, i) => ({ sourceId: "native", threadId: "t" + i, activity: "running" })) };
    await expect(repository.save(oversized)).rejects.toThrow("超过存储预算");
    expect(fixture.writes).toHaveLength(1);
    expect((await repository.load()).state).toEqual(state);
    await repository.save({ version: 1, records: [] });
    expect((await repository.load()).state.records).toEqual([]);
  });

  test("首次save隐式load，重叠save严格按序且捕获调用时副本", async () => {
    const fixture = storeFixture();
    let release!: () => void;
    let started!: () => void;
    const firstWrite = new Promise<void>((resolve) => { release = resolve; });
    const writingStarted = new Promise<void>((resolve) => { started = resolve; });
    const originalSet = fixture.store.set;
    let entered = 0;
    fixture.store.set = async (key, data) => {
      entered++;
      if (entered === 1) { started(); await firstWrite; }
      await originalSet(key, data);
    };
    const repository = new DesktopObservationStorage(fixture.store);
    const first = repository.save(state);
    const next = structuredClone(state); next.records[0]!.threadId = "next";
    const second = repository.save(next);
    next.records[0]!.threadId = "mutated";
    await writingStarted;
    expect(entered).toBe(1);
    release(); await first; await second;
    expect((await repository.load()).state.records[0]?.threadId).toBe("next");
    expect(entered).toBe(2);
  });

  test("从部分页cursor继续并合并，不丢未消费行", async () => {
    const read = async (cursor: string | null) => cursor === null
      ? { data: [{ id: "a" }], nextCursor: "page-2" }
      : { data: [{ id: "b" }, { id: "c" }] };
    const first = await collectDesktopThreadPages(read, { maxRows: 2 });
    expect(first).toMatchObject({ complete: false, reason: "row-limit", resumeCursor: "page-2" });
    const next = await collectDesktopThreadPages(read, { cursor: first.resumeCursor! });
    expect(next.complete).toBeTrue();
    expect([...new Set([...first.threads, ...next.threads].map((row) => row.id))]).toEqual(["a", "b", "c"]);
  });
});
