/** 中央胶囊阶段上报的兼容边界：旧 Host 没有 reportStage / 拒绝确认都不能打断业务流程。 */
import { expect, test } from "bun:test";
import { createVoiceOverlayStages, type VoiceOverlayStageClient } from "../src/voice-overlay-stage";

function client(overrides: Partial<VoiceOverlayStageClient> = {}) {
  const calls: Array<[string, string, string?]> = [];
  const base: VoiceOverlayStageClient = {
    reportStage: async (sessionId, stage) => { calls.push(["report", sessionId, stage]); return { accepted: true }; },
    acknowledgeResult: async sessionId => { calls.push(["ack", sessionId]); return { acknowledged: true }; },
    ...overrides,
  };
  return { calls, client: base };
}

test("有 sessionId 才上报与确认；缺省时什么都不发", async () => {
  const { calls, client: c } = client();
  const stages = createVoiceOverlayStages(c);
  await stages.report(undefined, "polishing");
  stages.release(undefined);
  await stages.report("s1", "polishing");
  stages.release("s1");
  await new Promise(resolve => setTimeout(resolve, 5));
  expect(calls).toEqual([["report", "s1", "polishing"], ["ack", "s1"]]);
});

test("报过 insert_failed：仅可见窗口确认后显式release，阶段本身不确认", async () => {
  const { calls, client: c } = client();
  const stages = createVoiceOverlayStages(c);
  await stages.report("s1", "insert_failed");
  await new Promise(resolve => setTimeout(resolve, 5));
  expect(calls.filter(call => call[0] === "ack")).toHaveLength(0);
  stages.release("s1");
  // 别的 session 照常确认。
  stages.release("s2");
  await new Promise(resolve => setTimeout(resolve, 5));
  expect(calls[0]).toEqual(["report", "s1", "insert_failed"]);
  expect(calls.filter(call => call[0] === "ack" && call[1] === "s1")).toHaveLength(1);
  expect(calls.filter(call => call[0] === "ack" && call[1] === "s2")).toHaveLength(1);
  expect(calls).toHaveLength(3);
  expect(stages.queuedSessionCount()).toBe(0);
});

test("insert_failed 永不回包：不补确认、release 也不发，队列照样排空", async () => {
  const sent: string[] = [];
  const stages = createVoiceOverlayStages({
    reportStage: async () => { sent.push("report"); await new Promise(() => {}); },
    acknowledgeResult: async () => { sent.push("ack"); },
  }, 10);
  await stages.report("s1", "insert_failed");
  stages.release("s1");
  await new Promise(resolve => setTimeout(resolve, 40));
  expect(sent).toEqual(["report"]);
  expect(stages.queuedSessionCount()).toBe(0);
});

test("insert_failed 上报同步抛错（旧运行时）：照样补一次确认，胶囊不会没人收", async () => {
  const sent: string[] = [];
  const stages = createVoiceOverlayStages({
    reportStage: () => { sent.push("report"); throw new Error("unknown method"); },
    acknowledgeResult: async () => { sent.push("ack"); },
  }, 10);
  await stages.report("s1", "insert_failed");
  stages.release("s1");
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(sent).toEqual(["report", "ack"]);
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}

test("同一 session 的上报与确认按调用顺序送达，先发的慢请求不会被后发的越过", async () => {
  const sent: string[] = [];
  const gates = new Map<string, ReturnType<typeof deferred>>();
  const stages = createVoiceOverlayStages({
    reportStage: async (_sessionId, stage) => {
      sent.push(`start:${stage}`);
      const gate = deferred();
      gates.set(stage, gate);
      await gate.promise;
      sent.push(`done:${stage}`);
    },
    acknowledgeResult: async () => { sent.push("ack"); },
  }, 10_000);
  void stages.report("s1", "transcribed");
  void stages.report("s1", "polishing");
  stages.release("s1");
  await new Promise(resolve => setTimeout(resolve, 5));
  // 第二个上报与确认都在第一个完成前按兵不动。
  expect(sent).toEqual(["start:transcribed"]);
  gates.get("transcribed")!.resolve();
  await new Promise(resolve => setTimeout(resolve, 5));
  expect(sent).toEqual(["start:transcribed", "done:transcribed", "start:polishing"]);
  gates.get("polishing")!.resolve();
  await new Promise(resolve => setTimeout(resolve, 5));
  expect(sent).toEqual(["start:transcribed", "done:transcribed", "start:polishing", "done:polishing", "ack"]);
});

test("上报最多等一小段：超时后放行调用方，确认随后发出、不被不回包的请求堵住", async () => {
  const sent: string[] = [];
  const gate = deferred();
  const stages = createVoiceOverlayStages({
    reportStage: async () => { sent.push("report"); await gate.promise; sent.push("report-done"); },
    acknowledgeResult: async () => { sent.push("ack"); },
  }, 20);
  const started = Date.now();
  await stages.report("s1", "polishing");
  expect(Date.now() - started).toBeLessThan(1000);
  stages.release("s1");
  await new Promise(resolve => setTimeout(resolve, 60));
  // 失败那一句仍先于确认发出；确认不等它回包。
  expect(sent).toEqual(["report", "ack"]);
  expect(stages.queuedSessionCount()).toBe(0);
  // 超时后迟到的回包：不补发、不报错。
  gate.resolve();
  await new Promise(resolve => setTimeout(resolve, 5));
  expect(sent).toEqual(["report", "ack", "report-done"]);
  expect(stages.queuedSessionCount()).toBe(0);
});

test("永不回包的阶段请求：每节最多占用上限，确认照发，连续新会话不留队列", async () => {
  const sent: string[] = [];
  const stages = createVoiceOverlayStages({
    reportStage: async sessionId => { sent.push(`report:${sessionId}`); await new Promise(() => {}); },
    acknowledgeResult: async sessionId => { sent.push(`ack:${sessionId}`); },
  }, 10);
  for (let index = 0; index < 40; index += 1) {
    const sessionId = `s${index}`;
    void stages.report(sessionId, "transcribed");
    void stages.report(sessionId, "polishing");
    stages.release(sessionId);
  }
  await new Promise(resolve => setTimeout(resolve, 120));
  expect(sent.filter(item => item.startsWith("ack:"))).toHaveLength(40);
  for (let index = 0; index < 40; index += 1) {
    const mine = sent.filter(item => item.endsWith(`:s${index}`));
    expect(mine).toEqual([`report:s${index}`, `report:s${index}`, `ack:s${index}`]);
  }
  expect(stages.queuedSessionCount()).toBe(0);
});

test("重复确认各自发出（Host 侧幂等），队列照样排空", async () => {
  const { calls, client: c } = client();
  const stages = createVoiceOverlayStages(c, 10);
  stages.release("s1");
  stages.release("s1");
  await new Promise(resolve => setTimeout(resolve, 5));
  expect(calls).toEqual([["ack", "s1"], ["ack", "s1"]]);
  expect(stages.queuedSessionCount()).toBe(0);
});

/**
 * 按生产 Host 口径的最小胶囊模型：阶段只进不退；写入失败后结算胶囊待确认，不再受理阶段。
 * `terminal`：会话另有保留的回执（录满自动完成 / retainResultUntilAck），只能由确认回收，回收它不收胶囊。
 */
function forwardOnlyHost(receiptDelayMs: (stage: string) => number, options: { terminal?: boolean } = {}) {
  const rank: Record<string, number> = { transcribing: 0, transcribed: 1, polishing: 2, translating: 2, insert_failed: 3 };
  let pending = true;
  let best = 0;
  const shown: string[] = [];
  const state = { terminal: options.terminal === true };
  const client: VoiceOverlayStageClient = {
    reportStage: async (_sessionId, stage) => {
      await new Promise(resolve => setTimeout(resolve, receiptDelayMs(stage)));
      const accepted = pending && rank[stage]! >= best;
      if (accepted) { best = rank[stage]!; shown.push(stage); }
      if (accepted && stage === "insert_failed") pending = false;
      return { accepted };
    },
    acknowledgeResult: async () => {
      const acknowledged = pending || state.terminal;
      if (pending) { pending = false; shown.push("hidden"); }
      state.terminal = false;
      return { acknowledged };
    },
  };
  return { client, shown, state };
}

test("受理前延迟：先发的旧阶段晚到 Host 也不会把新阶段改回去", async () => {
  const { client: c, shown } = forwardOnlyHost(stage => (stage === "transcribed" ? 60 : 0));
  const stages = createVoiceOverlayStages(c, 10);
  void stages.report("s1", "transcribed");
  void stages.report("s1", "polishing");
  await new Promise(resolve => setTimeout(resolve, 100));
  expect(shown).toEqual(["polishing"]);
});

test("受理前延迟：insert_failed 晚到 Host 时，收尾确认不会先把胶囊收掉，保留的回执仍被回收", async () => {
  const { client: c, shown, state } = forwardOnlyHost(stage => (stage === "insert_failed" ? 60 : 0), { terminal: true });
  const stages = createVoiceOverlayStages(c, 10);
  await stages.report("s1", "insert_failed");
  // 翻译 / 转文本收尾与识别后收尾的异常路径都会再 release（可能不止一次）。
  stages.release("s1");
  stages.release("s1");
  await new Promise(resolve => setTimeout(resolve, 120));
  expect(shown).toEqual(["insert_failed"]);
  expect(state.terminal).toBeFalse();
});

test("不同 session 互不排队", async () => {
  const sent: string[] = [];
  const gate = deferred();
  const stages = createVoiceOverlayStages({
    reportStage: async sessionId => { sent.push(sessionId); if (sessionId === "slow") await gate.promise; },
    acknowledgeResult: async sessionId => { sent.push(`ack:${sessionId}`); },
  }, 10_000);
  void stages.report("slow", "polishing");
  await stages.report("fast", "polishing");
  stages.release("fast");
  await new Promise(resolve => setTimeout(resolve, 5));
  expect(sent).toEqual(["slow", "fast", "ack:fast"]);
  gate.resolve();
});

test("旧 Host 注入的运行时没有 reportStage：静默跳过", async () => {
  const { calls, client: c } = client({ reportStage: undefined });
  await createVoiceOverlayStages(c).report("s1", "translating");
  expect(calls).toEqual([]);
});

test("上报被拒、确认同步抛错或异步失败都被吞掉", async () => {
  const stages = createVoiceOverlayStages({
    reportStage: async () => { throw new Error("unknown method"); },
    acknowledgeResult: () => { throw new Error("sync"); },
  });
  await expect(stages.report("s1", "transcribed")).resolves.toBeUndefined();
  expect(() => stages.release("s1")).not.toThrow();
  const asyncReject = createVoiceOverlayStages({ acknowledgeResult: async () => { throw new Error("async"); } });
  expect(() => asyncReject.release("s1")).not.toThrow();
  await new Promise(resolve => setTimeout(resolve, 5));
});
