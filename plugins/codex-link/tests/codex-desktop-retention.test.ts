import { expect, test } from "bun:test";
import {
  DESKTOP_STATE_MAX_BYTES,
  DesktopObservationModel,
  parseDesktopObservationState,
  type DesktopObservation,
} from "../src/codex-model";

// Existing internal adapter/receipt contract sequences, not native Desktop E2E.
function connected(epoch = "first") {
  const model = new DesktopObservationModel();
  model.connect("native", epoch, "verified-native");
  model.finishBaseline(epoch);
  return model;
}

function ended(threadId: string, resultId: string, extra: Partial<DesktopObservation> = {}): DesktopObservation {
  return { sourceId: "native", threadId, epoch: "first", sequence: 1,
    observedAtMs: 1, origin: "live", kind: "turn-ended", activity: "idle",
    result: { turnId: "turn", resultId, status: "completed" }, ...extra };
}

function see(model: DesktopObservationModel, threadId: string, resultId: string) {
  expect(model.presented({ kind: "presented", sourceId: "native", threadId,
    epoch: "first", turnId: "turn", resultId })).toBeTrue();
}

test("byte pressure: save/restart/baseline preserves every exact presented result without replay notices", () => {
  const model = connected();
  const ids = Array.from({ length: 130 }, (_, i) => "x".repeat(800) + i);
  for (const [i, id] of ids.entries()) {
    model.apply(ended("history-" + i, id));
    see(model, "history-" + i, id);
  }
  const superseded = ids[0]!;
  model.apply({ ...ended("history-0", "unused"), result: undefined, kind: "status",
    activity: "needs-user", attentionId: "old-request", sequence: 2 });
  ids[0] = "y".repeat(800);
  model.apply(ended("history-0", ids[0], { sequence: 3 }));
  see(model, "history-0", ids[0]);
  const snapshot = model.snapshot();
  expect(new TextEncoder().encode(JSON.stringify(snapshot)).byteLength).toBeLessThanOrEqual(DESKTOP_STATE_MAX_BYTES);
  expect(parseDesktopObservationState(snapshot).writable).toBeTrue();
  const restored = new DesktopObservationModel(snapshot);
  restored.connect("native", "second", "verified-native");
  for (const [i, id] of ids.entries()) {
    expect(restored.apply(ended("history-" + i, id, {
      epoch: "second", origin: "baseline", kind: "snapshot",
    })).notice).toBeUndefined();
  }
  expect(restored.groups().unseen).toHaveLength(0);
  expect(restored.groups().history).toHaveLength(ids.length);
  expect(restored.apply(ended("history-0", superseded, { epoch: "second", sequence: 2 })))
    .toEqual({ applied: false, issue: "result-superseded" });
  restored.finishBaseline("second");
  for (const [i, id] of ids.entries()) {
    expect(restored.apply(ended("history-" + i, id, { epoch: "second", sequence: 2 })).notice).toBeUndefined();
  }
  expect(restored.apply({ ...ended("history-0", "unused"), epoch: "second", sequence: 3,
    result: undefined, kind: "status", activity: "needs-user", attentionId: "old-request" }).notice).toBeUndefined();
  expect(restored.apply(ended("history-0", ids[0]!, { epoch: "second", sequence: 4 })).notice).toBeUndefined();
  // The old receipt must not acknowledge a genuinely different result.
  expect(restored.apply(ended("history-0", "new-result", { epoch: "second", sequence: 5 })).notice?.kind).toBe("turn-ended");
  expect(restored.groups().unseen.map(row => row.threadId)).toEqual(["history-0"]);
});

test("unclassified rows with known attention identities cannot be silently evicted", () => {
  const model = connected();
  model.apply({ ...ended("remember", "unused"), result: undefined, kind: "status",
    activity: "needs-user", attentionId: "request-1", observedAtMs: 0 });
  model.apply({ ...ended("remember", "unused"), result: undefined, kind: "status",
    activity: "unknown", sequence: 2, observedAtMs: 0 });
  for (let i = 0; i < 1_000; i++) {
    model.apply({ ...ended("empty-" + i, "unused"), result: undefined, kind: "status",
      activity: "unknown", observedAtMs: i + 1 });
  }
  const restored = new DesktopObservationModel(model.snapshot());
  restored.connect("native", "second", "verified-native");
  restored.finishBaseline("second");
  const replay = restored.apply({ ...ended("remember", "unused"), epoch: "second",
    result: undefined, kind: "status", activity: "needs-user", attentionId: "request-1" });
  expect(replay.applied).toBeTrue();
  expect(replay.notice).toBeUndefined();
});

test("record capacity: explicit failure preserves in-memory seen evidence instead of dropping old histories", () => {
  const model = connected();
  for (let i = 0; i < 1_001; i++) {
    model.apply(ended("history-" + i, "result"));
    see(model, "history-" + i, "result");
  }
  expect(() => { model.snapshot(); }).toThrow("保护记录超过持久预算");
  expect(model.groups().history).toHaveLength(1_001);
  expect(model.groups().unseen).toHaveLength(0);
});
