import { describe, expect, test } from "bun:test";
import type { VoiceRecordingSegment } from "@reai/app-sdk/v1";
import {
  dayKeyOf,
  dayLabel,
  digestSourceKey,
  groupByDay,
  segmentDayKey,
  type VoiceDayDigest,
} from "../src/voice-digest";
import {
  discardDigestSession,
  prepareDigestRun,
  DIGEST_REFRESH_INTERVAL_MS,
  DIGEST_RETENTION_DAYS,
  planDigestWork,
  pruneDigests,
} from "../src/voice-digest-scheduler";

test("失败回合污染 Dsh 会话时只丢游标，保留旧总结给用户看", () => {
  const current = digest(TODAY, [], {
    backend: "dsh",
    dsh: { sessionId: "dsh-old", sentSegmentIds: ["a"], sentSegmentKeys: ["a@1"] },
  });
  const before = { [TODAY]: current };
  const next = discardDigestSession(before, TODAY);
  expect(next[TODAY]?.points).toEqual(current.points);
  expect(next[TODAY]?.dsh).toBeUndefined();
  expect(next).not.toBe(before);
  expect(discardDigestSession(next, TODAY)).toBe(next);
});

/** 固定一个本地「现在」：2026-08-22 14:50，避免用例跟着真实时钟跨天漂移。 */
const NOW = new Date(2026, 7, 22, 14, 50, 0).getTime();
const TODAY = dayKeyOf(new Date(NOW));
const YESTERDAY = dayKeyOf(new Date(2026, 7, 21));

function at(year: number, month: number, day: number, hour: number, minute: number): number {
  return new Date(year, month - 1, day, hour, minute, 0).getTime();
}

function segment(
  id: string,
  wallStartMs: number,
  overrides: Partial<VoiceRecordingSegment> = {},
): VoiceRecordingSegment {
  return {
    id,
    wallStartMs,
    durationMs: 12 * 60_000,
    transport: "usb_vendor_hid",
    transcriptText: `${id} 说的话`,
    transcribedAtMs: wallStartMs + 13 * 60_000,
    ...overrides,
  };
}

function digest(
  dayKey: string,
  segments: VoiceRecordingSegment[],
  overrides: Partial<VoiceDayDigest> = {},
): VoiceDayDigest {
  return {
    dayKey,
    points: ["要点"],
    segs: segments.length,
    chars: 10,
    fromMs: segments[0]?.wallStartMs ?? 0,
    toMs: segments[segments.length - 1]?.wallStartMs ?? 0,
    createdAt: new Date(NOW - 2 * DIGEST_REFRESH_INTERVAL_MS).toISOString(),
    final: false,
    sourceKey: digestSourceKey(segments),
    ...overrides,
  };
}

describe("按天分组与归天规则（R18）", () => {
  test("段归属按开始时间所在的本地日：23:40 开始跨到 00:25 的段归昨天", () => {
    const crossing = segment("y-late", at(2026, 8, 21, 23, 40), { durationMs: 45 * 60_000 });
    const early = segment("t-early", at(2026, 8, 22, 0, 10));
    expect(segmentDayKey(crossing)).toBe(YESTERDAY);
    expect(segmentDayKey(early)).toBe(TODAY);
  });

  test("groupByDay：最新的一天在前，组内保持传入顺序", () => {
    const items = [
      segment("t2", at(2026, 8, 22, 14, 3)),
      segment("t1", at(2026, 8, 22, 9, 48)),
      segment("y1", at(2026, 8, 21, 16, 5)),
      segment("d2", at(2026, 8, 20, 15, 10)),
    ];
    const groups = groupByDay(items, segmentDayKey);
    expect(groups.map((group) => group.dayKey)).toEqual([TODAY, YESTERDAY, "2026-08-20"]);
    expect(groups[0]?.items.map((item) => item.id)).toEqual(["t2", "t1"]);
  });

  test("天的标题：今天 / 昨天 / 「8 月 20 日 周四」，跨年才带年份", () => {
    expect(dayLabel(TODAY, TODAY)).toBe("今天");
    expect(dayLabel(YESTERDAY, TODAY)).toBe("昨天");
    expect(dayLabel("2026-08-20", TODAY)).toBe("8 月 20 日 周四");
    expect(dayLabel("2025-12-31", TODAY)).toBe("2025 年 12 月 31 日 周三");
  });

  test("素材指纹：段 id + 转写时刻；顺序无关，任一段增删或重转写都换指纹", () => {
    const a = segment("a", at(2026, 8, 22, 9, 0));
    const b = segment("b", at(2026, 8, 22, 10, 0));
    expect(digestSourceKey([a, b])).toBe(digestSourceKey([b, a]));
    expect(digestSourceKey([a, b])).not.toBe(digestSourceKey([a]));
    expect(digestSourceKey([a, b])).not.toBe(
      digestSourceKey([a, { ...b, transcribedAtMs: (b.transcribedAtMs ?? 0) + 1 }]),
    );
  });
});

describe("当日总结调度（planDigestWork）", () => {
  test("强制刷新那天已无素材时，仍保留同批次的 drop，供编排层先落盘再报错", () => {
    const stale = segment("deleted", at(2026, 8, 22, 9, 48));
    const existing = digest(TODAY, [stale]);
    const plan = planDigestWork({
      recordings: [],
      digests: { [TODAY]: existing },
      nowMs: NOW,
      listComplete: true,
    });

    const prepared = prepareDigestRun({
      recordings: [],
      digests: { [TODAY]: existing },
      plan,
      force: TODAY,
      nowMs: NOW,
    });

    expect(prepared.dirty).toBeTrue();
    expect(prepared.nextDigests).toEqual({});
    expect(prepared.forceWithoutSource).toBeTrue();
    expect(prepared.work).toEqual([]);
  });

  test("今天第一段结束（有转写）就生成；只有没转写的段时不生成也不撤", () => {
    const first = segment("t1", at(2026, 8, 22, 9, 48));
    const plan = planDigestWork({
      recordings: [first],
      digests: {},
      nowMs: NOW,
      listComplete: true,
    });
    expect(plan.generate.map((item) => [item.dayKey, item.final])).toEqual([[TODAY, false]]);
    expect(plan.generate[0]?.segments.map((item) => item.id)).toEqual(["t1"]);

    const untranscribed = planDigestWork({
      recordings: [segment("t1", at(2026, 8, 22, 9, 48), { transcriptText: null })],
      digests: { [TODAY]: digest(TODAY, [first]) },
      nowMs: NOW,
      listComplete: true,
    });
    expect(untranscribed.generate).toEqual([]);
    expect(untranscribed.drop).toEqual([]);
  });

  test("素材没变就不发请求；录音中的段不算（Host 只在段结束后才列出来，没转写的也不进素材）", () => {
    const segments = [segment("t1", at(2026, 8, 22, 9, 48)), segment("t2", at(2026, 8, 22, 11, 20))];
    const plan = planDigestWork({
      recordings: [...segments, segment("t3", at(2026, 8, 22, 14, 3), { transcriptText: "" })],
      digests: { [TODAY]: digest(TODAY, segments) },
      nowMs: NOW,
      listComplete: true,
    });
    expect(plan).toEqual({ generate: [], finalize: [], drop: [] });
  });

  test("新段结束后刷新，但最密每小时一次：距上次合成不足 1 小时就等", () => {
    const segments = [segment("t1", at(2026, 8, 22, 9, 48))];
    const fresh = segment("t2", at(2026, 8, 22, 14, 3));
    const recent = digest(TODAY, segments, {
      createdAt: new Date(NOW - 20 * 60_000).toISOString(),
    });
    const throttled = planDigestWork({
      recordings: [...segments, fresh],
      digests: { [TODAY]: recent },
      nowMs: NOW,
      listComplete: true,
    });
    expect(throttled.generate).toEqual([]);

    const due = planDigestWork({
      recordings: [...segments, fresh],
      digests: { [TODAY]: recent },
      nowMs: NOW + DIGEST_REFRESH_INTERVAL_MS,
      listComplete: true,
    });
    expect(due.generate.map((item) => item.dayKey)).toEqual([TODAY]);
    expect(due.generate[0]?.segments.map((item) => item.id)).toEqual(["t1", "t2"]);
  });

  test("合成失败按同样的 1 小时退避，不连环重试", () => {
    const segments = [segment("t1", at(2026, 8, 22, 9, 48))];
    const backoff = planDigestWork({
      recordings: segments,
      digests: {},
      nowMs: NOW,
      lastAttemptAt: { [TODAY]: NOW - 5 * 60_000 },
      listComplete: true,
    });
    expect(backoff.generate).toEqual([]);
    const retry = planDigestWork({
      recordings: segments,
      digests: {},
      nowMs: NOW,
      lastAttemptAt: { [TODAY]: NOW - DIGEST_REFRESH_INTERVAL_MS },
      listComplete: true,
    });
    expect(retry.generate.map((item) => item.dayKey)).toEqual([TODAY]);
  });

  test("过了午夜定稿：素材没变只标 final（不发请求）；素材变了再合一次并定稿", () => {
    const yesterdaySegments = [segment("y1", at(2026, 8, 21, 16, 5))];
    const unchanged = planDigestWork({
      recordings: yesterdaySegments,
      digests: { [YESTERDAY]: digest(YESTERDAY, yesterdaySegments) },
      nowMs: NOW,
      listComplete: true,
    });
    expect(unchanged).toEqual({ generate: [], finalize: [YESTERDAY], drop: [] });

    // 23:40 开始、午夜后才结束的段在定稿之后才进列表：归昨天、触发再合一次，结果定稿。
    const crossing = segment("y-late", at(2026, 8, 21, 23, 40), { durationMs: 45 * 60_000 });
    const changed = planDigestWork({
      recordings: [...yesterdaySegments, crossing],
      digests: { [YESTERDAY]: digest(YESTERDAY, yesterdaySegments, { final: true }) },
      nowMs: NOW,
      listComplete: true,
    });
    expect(changed.finalize).toEqual([]);
    expect(changed.generate.map((item) => [item.dayKey, item.final])).toEqual([[YESTERDAY, true]]);
    expect(changed.generate[0]?.segments.map((item) => item.id)).toEqual(["y1", "y-late"]);

    // 已定稿且素材没变：什么都不做。
    const settled = planDigestWork({
      recordings: yesterdaySegments,
      digests: { [YESTERDAY]: digest(YESTERDAY, yesterdaySegments, { final: true }) },
      nowMs: NOW,
      listComplete: true,
    });
    expect(settled).toEqual({ generate: [], finalize: [], drop: [] });
  });

  test("那一天一段带转写的素材都不剩：总结跟着撤；列表不完整时只撤覆盖得到的天", () => {
    const yesterdaySegments = [segment("y1", at(2026, 8, 21, 16, 5))];
    const todaySegments = [segment("t1", at(2026, 8, 22, 9, 48))];
    const complete = planDigestWork({
      recordings: todaySegments,
      digests: {
        [YESTERDAY]: digest(YESTERDAY, yesterdaySegments, { final: true }),
        [TODAY]: digest(TODAY, todaySegments),
      },
      nowMs: NOW,
      listComplete: true,
    });
    expect(complete.drop).toEqual([YESTERDAY]);

    // 列表只翻到今天（分页截断）：昨天的段只是翻不到，不能当成没了。
    const partial = planDigestWork({
      recordings: todaySegments,
      digests: { [YESTERDAY]: digest(YESTERDAY, yesterdaySegments, { final: true }) },
      nowMs: NOW,
      listComplete: false,
    });
    expect(partial.drop).toEqual([]);

    // 列表不完整但覆盖到了昨天（昨天还有别的段在列表里，只是素材段没了）：照撤。
    const covered = planDigestWork({
      recordings: [...todaySegments, segment("d2", at(2026, 8, 20, 15, 10))],
      digests: { [YESTERDAY]: digest(YESTERDAY, yesterdaySegments, { final: true }) },
      nowMs: NOW,
      listComplete: false,
    });
    expect(covered.drop).toEqual([YESTERDAY]);
  });

  test("多天同时待办：今天刷新、昨天定稿、前天撤，互不干扰", () => {
    const today = [segment("t1", at(2026, 8, 22, 9, 48))];
    const yesterday = [segment("y1", at(2026, 8, 21, 16, 5))];
    const plan = planDigestWork({
      recordings: [...today, ...yesterday],
      digests: {
        [TODAY]: digest(TODAY, []),
        [YESTERDAY]: digest(YESTERDAY, yesterday),
        "2026-08-20": digest("2026-08-20", [segment("d2", at(2026, 8, 20, 15, 10))], { final: true }),
      },
      nowMs: NOW,
      listComplete: true,
    });
    expect(plan.generate.map((item) => item.dayKey)).toEqual([TODAY]);
    expect(plan.finalize).toEqual([YESTERDAY]);
    expect(plan.drop).toEqual(["2026-08-20"]);
  });
});

describe("存储有界（pruneDigests）", () => {
  test(`只留最近 ${DIGEST_RETENTION_DAYS} 天`, () => {
    const old = new Date(NOW);
    old.setDate(old.getDate() - DIGEST_RETENTION_DAYS - 1);
    const edge = new Date(NOW);
    edge.setDate(edge.getDate() - DIGEST_RETENTION_DAYS);
    const kept = pruneDigests(
      {
        [TODAY]: digest(TODAY, []),
        [dayKeyOf(edge)]: digest(dayKeyOf(edge), []),
        [dayKeyOf(old)]: digest(dayKeyOf(old), []),
      },
      NOW,
    );
    expect(Object.keys(kept).sort()).toEqual([dayKeyOf(edge), TODAY].sort());
  });
});
