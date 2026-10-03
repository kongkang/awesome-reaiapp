import { describe, expect, test } from "bun:test";
import { defineApp, NotifyMethod, runApp, type AppContext, type HostBridge, type HostMessage } from "../src/v1/index";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function harness(activate: (ctx: AppContext) => void | Promise<void>) {
  const listeners = new Set<(message: HostMessage) => void>();
  const settlements: Array<Record<string, unknown>> = [];
  const bridge: HostBridge = {
    async request() { return undefined as never; },
    notify(method, params) {
      if (method === NotifyMethod.ServiceSettled) settlements.push(params as Record<string, unknown>);
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
  const app = runApp(defineApp({ activate }), bridge);
  const send = (message: HostMessage) => { for (const listener of [...listeners]) listener(message); };
  send({ type: "activate", runtimeSessionId: "provider-runtime" });
  return { send, settlements, app };
}

const invoke = (correlationId: string, extra: Record<string, unknown> = {}): HostMessage => ({
  type: "service.invoke", correlationId, serviceId: "test/dictate@1", method: "request-text", input: {}, ...extra,
} as HostMessage);

describe("Service caller 与取消隔离", () => {
  test("caller 来自 Host 信封，不能被 input 的 caller 覆盖", async () => {
    let observed: unknown;
    const h = harness((ctx) => ctx.services.provide("test/dictate@1", "request-text", (invocation) => {
      observed = (invocation as { caller?: unknown }).caller;
      return "text";
    }));
    await tick();
    const caller = { appId: "consumer", surfaceMountId: "mount-a", runtimeSessionId: "runtime-a" };
    h.send(invoke("one", { caller, input: { caller: { appId: "forged" } } }));
    await tick();
    expect(observed).toEqual(caller);
    expect(h.settlements).toEqual([{ correlationId: "one", ok: true, output: "text" }]);
    await h.app.dispose();
  });

  test("cancel 先于 invoke，以及同 correlation 晚到 invoke，都不开 provider", async () => {
    let calls = 0;
    const h = harness((ctx) => ctx.services.provide("test/dictate@1", "request-text", () => { calls++; }));
    await tick();
    h.send({ type: "service.cancel", correlationId: "cancelled" });
    h.send({ type: "service.cancel", correlationId: "cancelled" });
    h.send(invoke("cancelled"));
    await tick();
    h.send(invoke("cancelled"));
    await tick();
    expect(calls).toBe(0);
    await h.app.dispose();
  });

  test("active cancel 结算一次，忽略 handler 迟到的成功", async () => {
    const result = deferred<string>();
    let signal: AbortSignal | undefined;
    const h = harness((ctx) => ctx.services.provide("test/dictate@1", "request-text", (invocation) => {
      signal = invocation.signal;
      return result.promise;
    }));
    await tick();
    h.send(invoke("active"));
    await tick();
    expect(h.settlements).toHaveLength(0);
    h.send({ type: "service.cancel", correlationId: "active" });
    h.send({ type: "service.cancel", correlationId: "active" });
    expect(signal?.aborted).toBe(true);
    result.resolve("late private text");
    await tick();
    expect(h.settlements).toHaveLength(1);
    expect(h.settlements[0]).toMatchObject({ correlationId: "active", ok: false, error: { code: "SERVICE_CANCELLED" } });
    expect(JSON.stringify(h.settlements)).not.toContain("late private text");
    await h.app.dispose();
  });

  test("保留 F10 activation queue 取消，并拒绝取消后的再次投递", async () => {
    const ready = deferred<void>();
    let calls = 0;
    const h = harness(async (ctx) => {
      await ready.promise;
      ctx.services.provide("test/dictate@1", "request-text", () => { calls++; });
    });
    h.send(invoke("queued"));
    h.send({ type: "service.cancel", correlationId: "queued" });
    h.send(invoke("queued"));
    ready.resolve();
    await tick();
    expect(calls).toBe(0);
    expect(h.settlements.filter((s) => s.correlationId === "queued")).toHaveLength(1);
    await h.app.dispose();
  });

  test("可信现代请求已登记超过60s，activation仍可开始，旧取消仍准确终止", async () => {
    const originalNow = Date.now;
    let now = originalNow();
    Date.now = () => now;
    const ready = deferred<void>();
    const result = deferred<string>();
    let calls = 0;
    let signal: AbortSignal | undefined;
    const h = harness(async (ctx) => {
      await ready.promise;
      ctx.services.provide("test/dictate@1", "request-text", (invocation) => {
        calls++;
        signal = invocation.signal;
        return result.promise;
      });
    });
    const metadata = {
      caller: { appId: "consumer", surfaceMountId: "mount", runtimeSessionId: "runtime", accountGeneration: "epoch-a" },
      requestId: `service-v1:${now}:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee`,
      deadlineUnixMs: now + 300_000,
    };
    try {
      h.send(invoke("long-activation", metadata));
      now += 61_000;
      ready.resolve();
      await tick();
      expect(calls).toBe(1);
      h.send({ type: "service.cancel", correlationId: "long-activation", ...metadata,
        caller: { ...metadata.caller, runtimeSessionId: "other-runtime" },
      });
      expect(signal?.aborted).toBe(false);
      h.send({ type: "service.cancel", correlationId: "long-activation", ...metadata,
        caller: { ...metadata.caller, accountGeneration: "epoch-b" },
      });
      expect(signal?.aborted).toBe(false);
      h.send({ type: "service.cancel", correlationId: "long-activation" });
      expect(signal?.aborted).toBe(true);
      result.resolve("late text");
      await tick();
      expect(h.settlements).toEqual([expect.objectContaining({ error: expect.objectContaining({ code: "SERVICE_CANCELLED" }) })]);
    } finally {
      result.resolve("cleanup");
      await h.app.dispose();
      Date.now = originalNow;
    }
  });

  test("Host deadline 已过期的 invoke 不启动 handler", async () => {
    let calls = 0;
    const h = harness((ctx) => ctx.services.provide("test/dictate@1", "request-text", () => { calls++; }));
    await tick();
    h.send(invoke("expired", { deadlineUnixMs: Date.now() - 1 }));
    await tick();
    expect(calls).toBe(0);
    expect(h.settlements[0]).toMatchObject({ ok: false, error: { code: "SERVICE_TIMEOUT" } });
    await h.app.dispose();
  });

  test("旧 Host 无 deadline 的取消记录达到上限时拒绝新增，不逐出旧取消", async () => {
    let calls = 0;
    const h = harness((ctx) => ctx.services.provide("test/dictate@1", "request-text", () => { calls++; }));
    await tick();
    for (let n = 0; n < 257; n++) h.send({ type: "service.cancel", correlationId: `old-${n}` });
    h.send(invoke("old-0"));
    h.send(invoke("new"));
    await tick();
    expect(calls).toBe(0);
    expect(h.settlements.find((s) => s.correlationId === "new")).toMatchObject({ ok: false, error: { code: "SERVICE_BUSY" } });
    await h.app.dispose();
  });

  test("无 deadline 的取消使用原 invoke deadline；过期与回拨都不能复活", async () => {
    const originalNow = Date.now;
    let now = originalNow();
    Date.now = () => now;
    let calls = 0;
    const result = deferred<void>();
    const h = harness((ctx) => ctx.services.provide("test/dictate@1", "request-text", () => {
      calls++;
      return result.promise;
    }));
    try {
      await tick();
      const deadlineUnixMs = now + 100;
      for (let n = 0; n < 256; n++) {
        h.send(invoke(`finite-${n}`, { deadlineUnixMs }));
        h.send({ type: "service.cancel", correlationId: `finite-${n}` });
      }
      await tick();
      expect(calls).toBe(0);
      now += 101;
      h.send(invoke("after-expiry", { deadlineUnixMs: now + 100 }));
      await tick();
      expect(calls).toBe(1);
      now -= 101;
      h.send(invoke("finite-0", { deadlineUnixMs }));
      await tick();
      expect(calls).toBe(1);
      expect(h.settlements.at(-1)).toMatchObject({ correlationId: "finite-0", error: { code: "SERVICE_TIMEOUT" } });
    } finally {
      result.resolve();
      await h.app.dispose();
      Date.now = originalNow;
    }
  });

  test("activation 尚未完成就越过总 deadline，不启动 provider", async () => {
    const ready = deferred<void>();
    let calls = 0;
    const h = harness(async (ctx) => {
      await ready.promise;
      ctx.services.provide("test/dictate@1", "request-text", () => { calls++; });
    });
    h.send(invoke("activation-timeout", { deadlineUnixMs: Date.now() + 10 }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    ready.resolve();
    await tick();
    expect(calls).toBe(0);
    expect(h.settlements).toEqual([expect.objectContaining({ correlationId: "activation-timeout", error: expect.objectContaining({ code: "SERVICE_TIMEOUT" }) })]);
    await h.app.dispose();
  });
});
