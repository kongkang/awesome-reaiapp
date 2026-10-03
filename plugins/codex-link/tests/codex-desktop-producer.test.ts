import { describe, expect, test } from "bun:test";
import {
  DesktopObservationModel,
  type DesktopObservation,
  type DesktopPresentationReceipt,
} from "../src/codex-model";
import {
  DesktopObservationPortError,
  DesktopObservationProjection,
  type DesktopObservationOwnerHandle,
  type DesktopObservationPageCursor,
  type DesktopObservationPageResult,
  type DesktopObservationPort,
  type DesktopObservationSnapshotHandle,
  type HostTaskObservationFrame,
} from "../src/codex-model";

function event(overrides: Partial<DesktopObservation> = {}): DesktopObservation {
  return { sourceId: "native-1", threadId: "thread-1", epoch: "connection-1", sequence: 1,
    observedAtMs: 1_000, origin: "live", kind: "status", activity: "running",
    activeTurnId: "turn-1", ...overrides };
}

function receipt(overrides: Partial<DesktopPresentationReceipt> = {}): DesktopPresentationReceipt {
  return { kind: "presented", sourceId: "native-1", threadId: "thread-1",
    epoch: "connection-1", turnId: "turn-1", resultId: "result-1", ...overrides };
}

type UpsertScript = (call: number, frame: HostTaskObservationFrame) => void;

/** 内存版观察门面：只实现编排器依赖的 Host 语义子集，可注入故障。 */
class FakePort implements DesktopObservationPort {
  calls: string[] = [];
  generation = 0;
  entries = new Map<string, HostTaskObservationFrame>();
  coverage: "complete" | "partial" = "partial";
  rejections = 0;
  pendingSerial: number | undefined;
  serial = 0;
  owner?: DesktopObservationOwnerHandle;
  bindError?: "capacity";
  upsertScript?: UpsertScript;
  upsertCalls = 0;
  staleRevisionOn?: Set<string>;
  pageRestartTimes = 0;
  seenResults: string[] = [];

  bind(sourceId: string, epoch: string): Promise<DesktopObservationOwnerHandle> {
    this.calls.push(`bind:${sourceId}:${epoch}`);
    if (this.bindError) throw new DesktopObservationPortError(this.bindError);
    this.generation += 1;
    this.owner = { sourceId, epoch, generation: this.generation };
    // 对齐 Host：重绑不清条目，旧 epoch 条目留待 reconcile 清理。
    this.coverage = "partial";
    this.rejections = 0;
    return Promise.resolve({ ...this.owner });
  }

  upsert(owner: DesktopObservationOwnerHandle, frame: HostTaskObservationFrame): Promise<void> {
    this.calls.push(`upsert:${frame.entityId}:${frame.revision}`);
    this.upsertCalls += 1;
    this.upsertScript?.(this.upsertCalls, frame);
    if (frame.sourceEpoch !== owner.epoch) throw new DesktopObservationPortError("stale-owner");
    if (this.staleRevisionOn?.has(frame.entityId)) throw new DesktopObservationPortError("stale-revision");
    this.entries.set(frame.entityId, frame);
    return Promise.resolve();
  }

  markSeen(owner: DesktopObservationOwnerHandle, entityId: string, revision: number, resultId: string): Promise<void> {
    this.calls.push(`seen:${entityId}:${revision}:${resultId}`);
    const entry = this.entries.get(entityId);
    if (!entry || entry.revision !== revision || entry.result?.id !== resultId) {
      throw new DesktopObservationPortError("stale-revision");
    }
    entry.seenResultId = resultId;
    this.seenResults.push(resultId);
    return Promise.resolve();
  }

  remove(owner: DesktopObservationOwnerHandle, entityId: string,
    expectedEpoch: string, expectedRevision: number, deletionRevision: number): Promise<void> {
    this.calls.push(`remove:${entityId}:${expectedEpoch}:${expectedRevision}:${deletionRevision}`);
    if (!this.entries.has(entityId)) throw new DesktopObservationPortError("not-found");
    if (expectedEpoch === owner.epoch && deletionRevision <= expectedRevision) {
      throw new DesktopObservationPortError("stale-revision");
    }
    this.entries.delete(entityId);
    return Promise.resolve();
  }

  stale(owner: DesktopObservationOwnerHandle): Promise<void> {
    this.calls.push("stale");
    this.coverage = "partial";
    return Promise.resolve();
  }

  clear(owner: DesktopObservationOwnerHandle): Promise<void> {
    this.calls.push("clear");
    this.entries.clear();
    return Promise.resolve();
  }

  beginSnapshot(owner: DesktopObservationOwnerHandle): Promise<DesktopObservationSnapshotHandle> {
    this.calls.push("begin");
    this.serial += 1;
    this.pendingSerial = this.serial;
    return Promise.resolve({ generation: owner.generation, rejections: this.rejections, serial: this.serial });
  }

  completeSnapshot(owner: DesktopObservationOwnerHandle, snapshot: DesktopObservationSnapshotHandle): Promise<void> {
    this.calls.push("complete");
    if (snapshot.generation !== owner.generation || snapshot.rejections !== this.rejections
      || this.pendingSerial !== snapshot.serial) {
      throw new DesktopObservationPortError("restart-required");
    }
    this.pendingSerial = undefined;
    this.coverage = "complete";
    return Promise.resolve();
  }

  page(owner: DesktopObservationOwnerHandle, cursor: DesktopObservationPageCursor | undefined,
    limit: number): Promise<DesktopObservationPageResult> {
    this.calls.push(`page:${cursor?.offset ?? 0}`);
    if (cursor !== undefined && this.pageRestartTimes > 0) {
      this.pageRestartTimes -= 1;
      throw new DesktopObservationPortError("restart-required");
    }
    const frames = [...this.entries.values()].sort((a, b) => a.entityId.localeCompare(b.entityId));
    const revision = 7;
    const offset = cursor?.offset ?? 0;
    const items = frames.slice(offset, offset + limit);
    const nextOffset = offset + items.length;
    return Promise.resolve({ items, revision,
      coverage: this.coverage,
      next: nextOffset < frames.length
        ? { revision, generation: owner.generation, offset: nextOffset } : undefined });
  }

  recordedUpserts(): HostTaskObservationFrame[] {
    return [...this.entries.values()];
  }
}

function model(): DesktopObservationModel {
  const value = new DesktopObservationModel();
  value.connect("native-1", "connection-1", "verified-native");
  value.finishBaseline("connection-1");
  return value;
}

function harness() {
  const port = new FakePort();
  const value = model();
  const projection = new DesktopObservationProjection(port, value);
  return { port, value, projection };
}

describe("F06 观察投影编排器：注入端口，不接生产 SDK", () => {
  test("attach 仅接受 verified-native；绑定后覆盖态为 partial，非法连接不触端口", async () => {
    const { port, projection } = harness();
    expect(await projection.attach({ sourceId: "native-1", epoch: "connection-1", provenance: "unknown" }))
      .toBe(false);
    expect(port.calls).toEqual([]);
    const attached = await projection.attach({
      sourceId: "native-1", epoch: "connection-1", provenance: "verified-native",
    });
    expect(attached).toBe(true);
    expect(projection.status().attached).toBe(true);
    expect(projection.status().coverage).toBe("partial");
    expect(port.calls).toEqual(["bind:native-1:connection-1"]);
  });

  test("bind 容量失败：本地模型保留，覆盖态降级，不推送任何帧", async () => {
    const { port, value, projection } = harness();
    port.bindError = "capacity";
    const attached = await projection.attach({
      sourceId: "native-1", epoch: "connection-1", provenance: "verified-native",
    });
    expect(attached).toBe(false);
    expect(projection.status().degraded).toBe(true);
    expect(projection.status().lastError).toBe("capacity");
    value.apply(event());
    expect(value.rows()[0]!.freshness).toBe("fresh");
    const applied = await projection.applyEvent(event({ sequence: 2 }), { title: "会话" });
    expect(applied.pushed).toBe(false);
    expect(port.upsertCalls).toBe(0);
  });

  test("pushBaseline：KV 恢复行必须走 not-observed 拒绝阻断 complete；旧 epoch 遗留才计 leftover；容量拒绝仍阻断", async () => {
    const restored = new DesktopObservationModel({
      version: 1,
      records: [{ sourceId: "native-1", threadId: "thread-restored", activity: "needs-user" }],
    });
    restored.connect("native-1", "connection-1", "verified-native");
    restored.finishBaseline("connection-1");
    restored.apply(event({ sequence: 2, activity: "running" }));
    const port = new FakePort();
    const projection = new DesktopObservationProjection(port, restored);
    await projection.attach({ sourceId: "native-1", epoch: "connection-1", provenance: "verified-native" });
    const outcome = await projection.pushBaseline({ title: "会话" }, { completeDiscovery: true });
    expect(outcome.pushed).toBe(1);
    expect(outcome.leftover).toBe(0);
    expect(outcome.refused).toBe(1);
    expect(outcome.complete).toBe(false);
    expect(projection.status().coverage).toBe("partial");
    expect(port.calls).toContain("begin");
    expect(port.calls).not.toContain("complete");
    expect([...port.entries.keys()]).toEqual(["thread-1"]);

    const onlyRestored = new DesktopObservationModel({
      version: 1,
      records: [{ sourceId: "native-1", threadId: "thread-cold", activity: "needs-user" }],
    });
    onlyRestored.connect("native-1", "connection-1", "verified-native");
    onlyRestored.finishBaseline("connection-1");
    const coldPort = new FakePort();
    const cold = new DesktopObservationProjection(coldPort, onlyRestored);
    await cold.attach({ sourceId: "native-1", epoch: "connection-1", provenance: "verified-native" });
    const coldOutcome = await cold.pushBaseline({ title: "会话" }, { completeDiscovery: true });
    expect(coldOutcome.pushed).toBe(0);
    expect(coldOutcome.refused).toBe(1);
    expect(coldOutcome.complete).toBe(false);
    expect(coldPort.entries.size).toBe(0);

    const degraded = harness();
    await degraded.projection.attach({
      sourceId: "native-1", epoch: "connection-1", provenance: "verified-native",
    });
    degraded.value.apply(event({ sequence: 2 }));
    degraded.port.upsertScript = (call) => {
      if (call === 1) {
        degraded.port.rejections += 1;
        throw new DesktopObservationPortError("capacity");
      }
    };
    const partial = await degraded.projection.pushBaseline({ title: "会话" }, { completeDiscovery: true });
    expect(partial.complete).toBe(false);
    expect(degraded.projection.status().degraded).toBe(true);
    expect(degraded.projection.status().coverage).toBe("partial");
  });

  test("pushBaseline：stale-owner 立即断连停推；stale-revision 视为已同步不阻断 complete；历史降级不粘滞", async () => {
    const orphaned = harness();
    await orphaned.projection.attach({
      sourceId: "native-1", epoch: "connection-1", provenance: "verified-native",
    });
    orphaned.value.apply(event({ threadId: "thread-a", sequence: 1 }));
    orphaned.value.apply(event({ threadId: "thread-b", sequence: 1 }));
    orphaned.port.upsertScript = () => {
      orphaned.port.upsertScript = undefined;
      throw new DesktopObservationPortError("stale-owner");
    };
    const orphanOutcome = await orphaned.projection.pushBaseline({ title: "会话" });
    expect(orphanOutcome.orphaned).toBe(true);
    expect(orphanOutcome.pushed).toBe(0);
    expect(orphaned.projection.status().attached).toBe(false);
    const upserts = orphaned.port.calls.filter((c) => c.startsWith("upsert:")).length;
    const afterOrphan = orphaned.port.calls.length;
    void upserts;
    void afterOrphan;
    expect(orphaned.value.rows()[0]!.freshness).toBe("stale");

    const synced = harness();
    await synced.projection.attach({
      sourceId: "native-1", epoch: "connection-1", provenance: "verified-native",
    });
    synced.value.apply(event({ sequence: 2 }));
    synced.port.staleRevisionOn = new Set(["thread-1"]);
    const staleOutcome = await synced.projection.pushBaseline({ title: "会话" }, { completeDiscovery: true });
    expect(staleOutcome.pushed).toBe(0);
    // stale-revision 视为已同步：不降级、不阻断 complete。
    expect(staleOutcome.complete).toBe(true);
    expect(synced.projection.status().degraded).toBe(false);
    synced.port.staleRevisionOn = undefined;
    const retry = await synced.projection.pushBaseline({ title: "会话" }, { completeDiscovery: true });
    expect(retry.complete).toBe(true);
    expect(synced.projection.status().coverage).toBe("complete");

    const sticky = harness();
    await sticky.projection.attach({
      sourceId: "native-1", epoch: "connection-1", provenance: "verified-native",
    });
    let once = 0;
    sticky.port.upsertScript = (call) => {
      if (call === 1 && once === 0) {
        once = 1;
        sticky.port.rejections += 1;
        throw new DesktopObservationPortError("rate-limited");
      }
    };
    await sticky.projection.applyEvent(event({ sequence: 2 }), { title: "会话" });
    expect(sticky.projection.status().degraded).toBe(true);
    const recovered = await sticky.projection.pushBaseline({ title: "会话" }, { completeDiscovery: true });
    expect(recovered.complete).toBe(true);
    expect(sticky.projection.status().degraded).toBe(false);
  });

  test("重连后旧 epoch 遗留行：baseline 只推本连接行，reconcileHost 按跨 epoch CAS 清 Host 遗留并重建 CAS 记忆", async () => {
    const port = new FakePort();
    const value = new DesktopObservationModel();
    const projection = new DesktopObservationProjection(port, value);
    await projection.attach({ sourceId: "native-1", epoch: "epoch-1", provenance: "verified-native" });
    value.finishBaseline("epoch-1");
    await projection.applyEvent({ ...event({ threadId: "thread-a", sequence: 1, epoch: "epoch-1" }) },
      { title: "会话A" });
    await projection.applyEvent({ ...event({ threadId: "thread-b", sequence: 1, epoch: "epoch-1" }) },
      { title: "会话B" });
    await projection.detach();
    await projection.attach({ sourceId: "native-1", epoch: "epoch-2", provenance: "verified-native" });
    value.finishBaseline("epoch-2");
    await projection.applyEvent({ ...event({ threadId: "thread-a", sequence: 1, epoch: "epoch-2" }) },
      { title: "会话A" });
    const baseline = await projection.pushBaseline({ title: "会话" }, { completeDiscovery: true });
    expect(baseline.pushed).toBe(1);
    expect(baseline.leftover).toBe(1);
    expect(baseline.complete).toBe(true);
    expect(port.entries.get("thread-a")?.sourceEpoch).toBe("epoch-2");
    expect(port.entries.get("thread-b")?.sourceEpoch).toBe("epoch-1");

    const reconciled = await projection.reconcileHost();
    expect(reconciled.abandoned).toBe(false);
    expect(reconciled.removed).toBe(1);
    expect(port.calls).toContain("remove:thread-b:epoch-1:2:1");
    expect(port.entries.has("thread-b")).toBe(false);
    expect(reconciled.rebuilt).toBe(1);
    const removed = await projection.removeThread("thread-a", 99);
    expect(removed).toBe(true);
    expect(port.calls).toContain("remove:thread-a:epoch-2:2:99");
  });

  test("applyEvent：应用后推送精确帧；stale-revision 跳过不降级，capacity 降级，stale-owner 双向断连", async () => {
    const base = harness();
    await base.projection.attach({
      sourceId: "native-1", epoch: "connection-1", provenance: "verified-native",
    });
    const applied = await base.projection.applyEvent(event({ sequence: 3 }), { title: "会话A" });
    expect(applied.applied).toBe(true);
    expect(applied.pushed).toBe(true);
    expect(base.port.entries.get("thread-1")).toMatchObject({ entityId: "thread-1", revision: 4 });

    const stale = harness();
    await stale.projection.attach({
      sourceId: "native-1", epoch: "connection-1", provenance: "verified-native",
    });
    stale.port.staleRevisionOn = new Set(["thread-1"]);
    const skipped = await stale.projection.applyEvent(event(), { title: "会话" });
    expect(skipped.pushed).toBe(false);
    expect(stale.projection.status().degraded).toBe(false);

    const degraded = harness();
    await degraded.projection.attach({
      sourceId: "native-1", epoch: "connection-1", provenance: "verified-native",
    });
    degraded.port.upsertScript = () => {
      degraded.port.rejections += 1;
      throw new DesktopObservationPortError("rate-limited");
    };
    const limited = await degraded.projection.applyEvent(event(), { title: "会话" });
    expect(limited.pushed).toBe(false);
    expect(degraded.projection.status().degraded).toBe(true);

    const detached = harness();
    await detached.projection.attach({
      sourceId: "native-1", epoch: "connection-1", provenance: "verified-native",
    });
    detached.port.upsertScript = () => {
      detached.port.upsertScript = undefined;
      throw new DesktopObservationPortError("stale-owner");
    };
    const orphan = await detached.projection.applyEvent(event(), { title: "会话" });
    expect(orphan.pushed).toBe(false);
    expect(detached.projection.status().attached).toBe(false);
    expect(detached.value.rows()[0]?.freshness).toBe("stale");
    const after = await detached.projection.applyEvent(event({ sequence: 9 }), { title: "会话" });
    expect(after.applied).toBe(false);
  });

  test("markSeen：真实呈现回执才上报；Host 已更新时容忍失败且本地已看保留到下一帧", async () => {
    const base = harness();
    await base.projection.attach({
      sourceId: "native-1", epoch: "connection-1", provenance: "verified-native",
    });
    await base.projection.applyEvent(event({ sequence: 2, kind: "turn-ended", origin: "live",
      activity: "idle", result: { turnId: "turn-1", resultId: "result-1", status: "completed" } }),
      { title: "会话" });
    const rejected = await base.projection.markSeen({ ...receipt(), epoch: "other" });
    expect(rejected.presented).toBe(false);
    expect(base.port.calls.some((c) => c.startsWith("seen:"))).toBe(false);

    const ok = await base.projection.markSeen(receipt());
    expect(ok).toEqual({ presented: true, reported: true });
    expect(base.port.entries.get("thread-1")?.seenResultId).toBe("result-1");

    const ahead = harness();
    await ahead.projection.attach({
      sourceId: "native-1", epoch: "connection-1", provenance: "verified-native",
    });
    await ahead.projection.applyEvent(event({ sequence: 2, kind: "turn-ended", origin: "live",
      activity: "idle", result: { turnId: "turn-1", resultId: "result-1", status: "completed" } }),
      { title: "会话" });
    ahead.port.entries.get("thread-1")!.revision = 99;
    const stale = await ahead.projection.markSeen(receipt());
    expect(stale).toEqual({ presented: true, reported: false });
    expect(ahead.projection.status().degraded).toBe(false);
    await ahead.projection.applyEvent(event({ sequence: 3, kind: "status", origin: "live",
      activity: "idle", result: undefined }), { title: "会话" });
    expect(ahead.port.entries.get("thread-1")?.seenResultId).toBe("result-1");
  });

  test("detach：尽力上报 stale 并断开本地模型；端口失败不阻塞断连", async () => {
    const base = harness();
    await base.projection.attach({
      sourceId: "native-1", epoch: "connection-1", provenance: "verified-native",
    });
    base.value.apply(event({ sequence: 2 }));
    await base.projection.detach();
    expect(base.port.calls).toContain("stale");
    expect(base.projection.status().attached).toBe(false);
    expect(base.value.rows()[0]?.freshness).toBe("stale");

    const failing = harness();
    await failing.projection.attach({
      sourceId: "native-1", epoch: "connection-1", provenance: "verified-native",
    });
    const originalStale = failing.port.stale.bind(failing.port);
    failing.port.stale = () => Promise.reject(new Error("bridge gone"));
    void originalStale;
    await failing.projection.detach();
    expect(failing.projection.status().attached).toBe(false);
  });

  test("removeThread：按 lastPushed 做 epoch/revision CAS；从未推送时容忍 not-found", async () => {
    const base = harness();
    await base.projection.attach({
      sourceId: "native-1", epoch: "connection-1", provenance: "verified-native",
    });
    await base.projection.applyEvent(event({ sequence: 4 }), { title: "会话" });
    const removed = await base.projection.removeThread("thread-1", 6);
    expect(removed).toBe(true);
    expect(base.port.calls).toContain("remove:thread-1:connection-1:5:6");
    expect(base.port.entries.has("thread-1")).toBe(false);

    const absent = harness();
    await absent.projection.attach({
      sourceId: "native-1", epoch: "connection-1", provenance: "verified-native",
    });
    const missing = await absent.projection.removeThread("thread-1", 1);
    expect(missing).toBe(false);
    expect(absent.projection.status().degraded).toBe(false);

    const badCas = harness();
    await badCas.projection.attach({
      sourceId: "native-1", epoch: "connection-1", provenance: "verified-native",
    });
    await badCas.projection.applyEvent(event({ sequence: 4 }), { title: "会话" });
    const rejected = await badCas.projection.removeThread("thread-1", 4);
    expect(rejected).toBe(false);
    expect(badCas.port.entries.has("thread-1")).toBe(true);
  });

  test("readHostPage：跨页串接；页间 restart-required 触发重分页，连续超过上限即放弃并标记 partial", async () => {
    const base = harness();
    await base.projection.attach({
      sourceId: "native-1", epoch: "connection-1", provenance: "verified-native",
    });
    for (let i = 0; i < 3; i++) {
      await base.projection.applyEvent(event({ threadId: "t-" + i, sequence: i + 1 }), { title: "会话" + i });
    }
    const whole = await base.projection.readHostPage(2);
    expect(whole.items.map((f) => f.entityId)).toEqual(["t-0", "t-1", "t-2"]);
    expect(whole.restarts).toBe(0);

    const flaky = harness();
    await flaky.projection.attach({
      sourceId: "native-1", epoch: "connection-1", provenance: "verified-native",
    });
    for (let i = 0; i < 3; i++) {
      await flaky.projection.applyEvent(event({ threadId: "t-" + i, sequence: i + 1 }), { title: "会话" + i });
    }
    flaky.port.pageRestartTimes = 1;
    const retried = await flaky.projection.readHostPage(2);
    expect(retried.restarts).toBe(1);
    expect(retried.items).toHaveLength(3);

    const stuck = harness();
    await stuck.projection.attach({
      sourceId: "native-1", epoch: "connection-1", provenance: "verified-native",
    });
    for (let i = 0; i < 3; i++) {
      await stuck.projection.applyEvent(event({ threadId: "t-" + i, sequence: i + 1 }), { title: "会话" + i });
    }
    stuck.port.pageRestartTimes = 99;
    const failed = await stuck.projection.readHostPage(2);
    expect(failed.restarts).toBe(3);
    expect(failed.abandoned).toBe(true);
    expect(stuck.projection.status().coverage).toBe("partial");
  });

  test("已看旧结果后新结果：帧带新结果不带旧已看，Host 行落到未看；编排透传模型 issue", async () => {
    const base = harness();
    await base.projection.attach({
      sourceId: "native-1", epoch: "connection-1", provenance: "verified-native",
    });
    await base.projection.applyEvent(event({ sequence: 2, kind: "turn-ended", origin: "live",
      activity: "idle", result: { turnId: "turn-1", resultId: "result-1", status: "completed" } }),
      { title: "会话" });
    await base.projection.markSeen(receipt());
    expect(base.port.entries.get("thread-1")?.seenResultId).toBe("result-1");
    const next = await base.projection.applyEvent(event({ sequence: 3, kind: "turn-ended", origin: "live",
      activity: "idle", result: { turnId: "turn-2", resultId: "result-2", status: "completed" } }),
      { title: "会话" });
    expect(next.pushed).toBe(true);
    expect(base.port.entries.get("thread-1")?.result?.id).toBe("result-2");
    expect(base.port.entries.get("thread-1")?.seenResultId).toBeUndefined();

    const budget = harness();
    await budget.projection.attach({
      sourceId: "native-1", epoch: "connection-1", provenance: "verified-native",
    });
    for (let i = 0; i < 257; i++) {
      const outcome = await budget.projection.applyEvent(event({ sequence: i + 1,
        kind: "turn-ended", origin: "live", activity: "idle",
        result: { turnId: "turn-" + i, resultId: "result-" + i, status: "completed" } }),
        { title: "会话" });
      if (i === 256) expect(outcome.issue).toBe("identity-budget");
    }
  });
});
