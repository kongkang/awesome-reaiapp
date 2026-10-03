import { describe, expect, test } from "bun:test";
import {
  DesktopTargetOperations, type DesktopDraftTarget, type DesktopOperationContext, type DesktopTextPort,
} from "../src/codex-repository";

const target: DesktopDraftTarget = { sourceId: "native", epoch: "epoch-1", mode: "continue", threadId: "thread-1" };
function pendingText() {
  let resolve!: (value: { requestId: string; text: string }) => void;
  let captured: DesktopOperationContext | undefined;
  const port: DesktopTextPort = { requestText: async (context) => {
    captured = context;
    return new Promise((done) => { resolve = done; });
  } };
  return { port, resolve: (id: string, text = "精确文本") => resolve({ requestId: id, text }),
    captured: () => captured };
}

describe("F06 目标事务和内部Voice文本消费端口", () => {
  test.each(["new", "continue"] as const)("文本准确进入捕获的%s草稿目标，一请求只消费一次", async (mode) => {
    const operations = new DesktopTargetOperations();
    operations.select({ ...target, mode, threadId: mode === "continue" ? target.threadId : undefined });
    const consumed: Array<{ text: string; threadId?: string; mode: string }> = [];
    const port = { requestText: async (context: DesktopOperationContext) => ({ requestId: context.requestId, text: " 原样\n文本 " }) };
    const consume = (text: string, context: DesktopOperationContext) => {
      consumed.push({ text, threadId: context.target.threadId, mode: context.target.mode }); return true;
    };
    expect((await operations.requestText("r1", port, consume)).status).toBe("applied");
    expect((await operations.requestText("r1", port, consume)).status).toBe("duplicate");
    expect(consumed).toEqual([{ text: " 原样\n文本 ", threadId: mode === "continue" ? "thread-1" : undefined, mode }]);
  });

  test.each(["change-thread", "change-epoch", "cancel", "dispose", "disconnect"])("%s后晚到文本不写入新目标", async (action) => {
    const operations = new DesktopTargetOperations(); operations.select(target);
    const pending = pendingText();
    let writes = 0;
    const task = operations.requestText("old", pending.port, () => { writes++; return true; });
    await Promise.resolve();
    if (action === "change-thread") operations.select({ ...target, threadId: "thread-2" });
    if (action === "change-epoch") operations.select({ ...target, epoch: "epoch-2" });
    if (action === "cancel") operations.cancel();
    if (action === "dispose") operations.dispose();
    if (action === "disconnect") operations.select();
    expect((await task).status).toBe("cancelled");
    expect(pending.captured()?.signal.aborted).toBeTrue();
    pending.resolve("old");
    await Promise.resolve();
    expect(writes).toBe(0);
  });

  test("相同目标重复选择不打断录音，新请求会使旧请求失效", async () => {
    const operations = new DesktopTargetOperations(); operations.select(target);
    const pending = pendingText();
    let writes = 0;
    const first = operations.requestText("old", pending.port, () => { writes++; return true; });
    await Promise.resolve();
    operations.select({ ...target });
    expect(pending.captured()?.signal.aborted).toBeFalse();
    const next = operations.requestText("new", { requestText: async () => ({ requestId: "new", text: "new" }) }, () => { writes++; return true; });
    expect((await first).status).toBe("cancelled");
    expect((await next).status).toBe("applied");
    pending.resolve("old");
    expect(writes).toBe(1);
  });

  test("服务缺失、拒绝、超时可恢复；无服务时不调用消费", async () => {
    const operations = new DesktopTargetOperations(); operations.select(target);
    let writes = 0;
    const consume = () => { writes++; return true; };
    expect((await operations.requestText("absent", undefined, consume)).status).toBe("unavailable");
    expect((await operations.requestText("denied", { requestText: async () => { throw new Error("denied"); } }, consume)).status).toBe("failed");
    const pending = pendingText();
    expect((await operations.requestText("slow", pending.port, consume, { timeoutMs: 2 })).status).toBe("timeout");
    pending.resolve("slow");
    expect(writes).toBe(0);
    expect((await operations.requestText("ok", { requestText: async () => ({ requestId: "ok", text: "ok" }) }, consume)).status).toBe("applied");
    expect(writes).toBe(1);
  });

  test("错误requestId/无效文本拒绝，发送和审批没有默认实现", async () => {
    const operations = new DesktopTargetOperations(); operations.select(target);
    let writes = 0;
    for (const [id, response] of [
      ["wrong", { requestId: "other", text: "text" }],
      ["empty", { requestId: "empty", text: "" }],
      ["large", { requestId: "large", text: "a".repeat(64_001) }],
    ] as const) {
      expect((await operations.requestText(id, { requestText: async () => response }, () => { writes++; return true; })).status).toBe("rejected");
    }
    expect(writes).toBe(0);
  });

  test("已取消signal和无目标时均不调用provider", async () => {
    const operations = new DesktopTargetOperations();
    let calls = 0;
    const port = { requestText: async () => { calls++; return { requestId: "r", text: "x" }; } };
    expect((await operations.requestText("none", port, () => true)).status).toBe("unavailable");
    operations.select(target);
    const controller = new AbortController(); controller.abort();
    expect((await operations.requestText("r", port, () => true, { signal: controller.signal })).status).toBe("cancelled");
    expect(calls).toBe(0);
  });

  test("目标事务也阻止取消后的导航回执进入已看处理", async () => {
    const operations = new DesktopTargetOperations(); operations.select(target);
    let resolve!: (value: string) => void;
    let seenWrites = 0;
    const task = operations.run("open", () => new Promise<string>((done) => { resolve = done; }), () => { seenWrites++; return true; });
    await Promise.resolve();
    operations.select({ ...target, threadId: "thread-2" });
    resolve("presented-thread-1");
    expect((await task).status).toBe("cancelled");
    expect(seenWrites).toBe(0);
  });
});

describe("F06 目标事务审查回归", () => {
  test("非法目标返回false并保留有效目标，主动清空才取消", async () => {
    const operations = new DesktopTargetOperations(); operations.select(target);
    expect(operations.select({ ...target, mode: "new" })).toBeFalse();
    let actual: DesktopDraftTarget | undefined;
    expect((await operations.run("valid", async (context) => context.target, (value) => { actual = value; return true; })).status).toBe("applied");
    expect(actual).toEqual(target);
    expect(operations.select()).toBeTrue();
    expect((await operations.run("empty", async () => true, () => true)).status).toBe("unavailable");
  });

  test("失败/取消/超时请求ID仍不重复消费，consume异常准确失败", async () => {
    const operations = new DesktopTargetOperations(); operations.select(target);
    expect((await operations.run("failed", async () => { throw new Error("denied"); }, () => true)).status).toBe("failed");
    const cancelled = new AbortController(); cancelled.abort();
    expect((await operations.run("cancelled", async () => true, () => true, { signal: cancelled.signal })).status).toBe("cancelled");
    expect((await operations.run("timeout", () => new Promise(() => {}), () => true, { timeoutMs: 1 })).status).toBe("timeout");
    for (const id of ["failed", "cancelled", "timeout"]) {
      expect((await operations.run(id, async () => true, () => { throw new Error("must not consume"); })).status).toBe("duplicate");
    }
    expect((await operations.run("consume-throws", async () => true, () => { throw new Error("write failed"); })).status).toBe("failed");
  });

  test("生命周期预算耗尽明确停用，不用FIFO重新允许旧请求", async () => {
    const operations = new DesktopTargetOperations(); operations.select(target);
    let writes = 0;
    for (let i = 0; i < 4_096; i++) await operations.run("r-" + i, async () => true, () => { writes++; return true; });
    expect(await operations.run("overflow", async () => true, () => { writes++; return true; }))
      .toEqual({ status: "unavailable", issue: "request-budget" });
    expect((await operations.run("r-0", async () => true, () => { writes++; return true; })).status).toBe("duplicate");
    expect(writes).toBe(4_096);
    operations.dispose();
    expect((await operations.run("disposed", async () => true, () => true)).status).toBe("unavailable");
  });
});
