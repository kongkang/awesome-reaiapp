import { afterEach, describe, expect, test } from "bun:test";
import { defineApp, runApp, type AppContext, type HostBridge, type HostMessage } from "../src/v1/index";

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const running: Array<ReturnType<typeof runApp>> = [];
afterEach(async () => { await Promise.all(running.splice(0).map((app) => app.dispose())); });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  // The pre-feature baseline may never request this promise.
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}

function harness(read: () => Promise<unknown> = async () => ({ runtimeSessionId: "s1", locale: "en", revision: 1 })) {
  const handlers = new Set<(message: HostMessage) => void>();
  const requests: string[] = [];
  const notices: Array<{ method: string; params: any }> = [];
  const bridge: HostBridge = {
    // Deliberately ignore AbortSignal, just like the production WebView bridge.
    request(method) {
      requests.push(method);
      return read() as never;
    },
    notify(method, params) { notices.push({ method, params }); },
    subscribe(handler) { handlers.add(handler); return () => handlers.delete(handler); },
  };
  return { bridge, requests, notices, send(message: unknown) {
    for (const handler of [...handlers]) handler(message as HostMessage);
  } };
}

const initial = (runtimeSessionId = "s1", locale = "en", revision = 1) => ({
  type: "activate", runtimeSessionId, locale: { locale, revision },
});
const changed = (locale: string, revision: number, runtimeSessionId = "s1") => ({
  type: "locale.changed", runtimeSessionId, locale: { locale, revision },
});
const mount = () => ({ type: "surface.mount", surfaceMountId: "m1", surfaceId: "main", root: {} });

describe("UI locale environment", () => {
  test("a local reply delayed beyond one second can still activate within the Host ready budget", async () => {
    const read = deferred<unknown>();
    const h = harness(() => read.promise);
    let activated = false;
    running.push(runApp(defineApp({ activate() { activated = true; } }), h.bridge));
    h.send(initial()); h.send(mount());
    await new Promise(resolve => setTimeout(resolve, 1_100));
    expect(h.notices.some(notice => notice.method === "app.activate-failed")).toBe(false);
    read.resolve({ runtimeSessionId: "s1", locale: "en", revision: 1 });
    await tick();
    expect(activated).toBe(true);
  });
  test("commands wait for locale activation and queued cancellation prevents business execution", async () => {
    const read = deferred<unknown>();
    const h = harness(() => read.promise);
    const invoked: unknown[] = [];
    running.push(runApp(defineApp({ activate(ctx) {
      ctx.commands.register("run", ({ input }) => { invoked.push(input); return "done"; });
    } }), h.bridge));
    h.send(initial());
    h.send({ type: "command.invoke", correlationId: "keep", commandId: "run", input: 1 });
    h.send({ type: "command.invoke", correlationId: "cancel", commandId: "run", input: 2 });
    h.send({ type: "command.cancel", correlationId: "cancel" });
    expect(invoked).toEqual([]);
    read.resolve({ runtimeSessionId: "s1", locale: "en", revision: 1 });
    await tick();
    expect(invoked).toEqual([1]);
    expect(h.notices.filter(n => n.method === "command.settled" && n.params.correlationId === "keep").map(n => n.params)).toEqual([
      { correlationId: "keep", ok: true, output: "done" },
    ]);
    expect(h.notices.filter(n => n.method === "command.settled" && n.params.correlationId === "cancel")).toHaveLength(1);
  });

  test("early intents retain only the latest value for the queued mount and do not survive unmount", async () => {
    const read = deferred<unknown>();
    const h = harness(() => read.promise);
    const seen: unknown[] = [];
    running.push(runApp(defineApp({ activate(ctx) {
      ctx.surfaces.register("main", surface => { surface.onIntent(intent => seen.push(intent)); surface.ready(); });
    } }), h.bridge));
    h.send(initial()); h.send(mount());
    h.send({ type: "surface.intent", surfaceMountId: "m1", intent: "old" });
    h.send({ type: "surface.intent", surfaceMountId: "m1", intent: "latest" });
    h.send({ ...mount(), surfaceMountId: "removed" });
    h.send({ type: "surface.intent", surfaceMountId: "removed", intent: "cancelled" });
    h.send({ type: "surface.unmount", surfaceMountId: "removed" });
    read.resolve({ runtimeSessionId: "s1", locale: "en", revision: 1 });
    await tick();
    expect(seen).toEqual(["latest"]);
  });

  test("locale read failure settles queued commands and services once with the original error", async () => {
    const read = deferred<unknown>();
    const h = harness(() => read.promise);
    let invoked = 0;
    running.push(runApp(defineApp({ activate(ctx) {
      ctx.commands.register("run", () => { invoked++; });
      ctx.services.provide("example@1", "run", () => { invoked++; });
    } }), h.bridge));
    h.send(initial());
    h.send({ type: "command.invoke", correlationId: "command", commandId: "run", input: {} });
    h.send({ type: "service.invoke", correlationId: "service", serviceId: "example@1", method: "run", input: {} });
    read.reject({ code: "LOCALE_BACKEND_FAILED", userMessage: "Language unavailable", retryable: true });
    await tick();
    expect(invoked).toBe(0);
    for (const method of ["command.settled", "service.settled"]) {
      const settled = h.notices.filter(n => n.method === method);
      expect(settled).toHaveLength(1);
      expect(settled[0]!.params.error.code).toBe("LOCALE_BACKEND_FAILED");
    }
  });

  test("unmount cancels a mount waiting for the locale snapshot", async () => {
    const read = deferred<unknown>();
    const h = harness(() => read.promise);
    let mounted = 0;
    running.push(runApp(defineApp({ activate(ctx) {
      ctx.surfaces.register("main", (surface) => { mounted++; surface.ready(); });
    } }), h.bridge));
    h.send(initial()); h.send(mount());
    h.send({ type: "surface.unmount", surfaceMountId: "m1" });
    read.resolve({ runtimeSessionId: "s1", locale: "en", revision: 1 });
    await tick();
    expect(mounted).toBe(0);
    expect(h.notices.some((n) => n.method === "surface.ready")).toBe(false);
  });

  test("service cancellation covers the activation queue without invoking the service", async () => {
    const read = deferred<unknown>();
    const h = harness(() => read.promise);
    let invoked = 0;
    running.push(runApp(defineApp({ activate(ctx) {
      ctx.services.provide("example@1", "run", () => { invoked++; });
    } }), h.bridge));
    h.send(initial());
    h.send({ type: "service.invoke", correlationId: "c1", serviceId: "example@1", method: "run", input: {} });
    h.send({ type: "service.cancel", correlationId: "c1" });
    read.resolve({ runtimeSessionId: "s1", locale: "en", revision: 1 });
    await tick();
    expect(invoked).toBe(0);
    expect(h.notices.filter((n) => n.method === "service.settled")).toEqual([
      { method: "service.settled", params: { correlationId: "c1", ok: false,
        error: { code: "SERVICE_CANCELLED", userMessage: "Service call cancelled", retryable: false } } },
    ]);
  });

  test("one RunningApp keeps one immutable session; foreign activate cannot replace its pending initialization", async () => {
    const read = deferred<unknown>();
    const h = harness(() => read.promise);
    const sessions: string[] = [];
    running.push(runApp(defineApp({ activate(ctx) { sessions.push(ctx.runtimeSessionId); } }), h.bridge));
    h.send(initial());
    h.send(initial("s2", "zh", 0));
    read.resolve({ runtimeSessionId: "s1", locale: "en", revision: 1 });
    await tick();
    expect(h.requests).toEqual(["locale.get"]);
    expect(sessions).toEqual(["s1"]);
    expect(h.notices.filter((n) => n.method === "app.activate-failed")).toHaveLength(0);
  });

  test("legacy activate performs no new RPC and keeps registration/mount working", async () => {
    const h = harness(async () => { throw new Error("unknown method"); });
    let ctx: AppContext | undefined;
    let mounted = 0;
    running.push(runApp(defineApp({ activate(value) {
      ctx = value;
      value.surfaces.register("main", () => { mounted++; });
    } }), h.bridge));
    h.send({ type: "activate", runtimeSessionId: "old" });
    h.send(mount());
    await tick();
    expect(h.requests).toEqual([]);
    expect(mounted).toBe(1);
    expect(h.notices.filter((n) => n.method === "app.registered")).toHaveLength(1);
    expect(ctx?.locale.getSnapshot()).toEqual({ locale: "zh", revision: 0 });
  });

  test("new activate reads once before business activation; late read cannot roll back an event", async () => {
    const read = deferred<unknown>();
    const h = harness(() => read.promise);
    let ctx: AppContext | undefined;
    const seen: unknown[] = [];
    running.push(runApp(defineApp({ activate(value) {
      ctx = value;
      value.locale.onChange((snapshot) => seen.push(snapshot));
    } }), h.bridge));
    h.send(initial());
    await tick();
    expect(ctx).toBeUndefined();
    h.send(changed("zh", 3));
    read.resolve({ runtimeSessionId: "s1", locale: "en", revision: 2 });
    await tick();
    expect(h.requests).toEqual(["locale.get"]);
    expect(ctx?.locale.getSnapshot()).toEqual({ locale: "zh", revision: 3 });
    expect(seen).toEqual([{ locale: "zh", revision: 3 }]);
  });

  test("pre-activate state is session scoped; stale, duplicate and invalid snapshots are ignored", async () => {
    const h = harness();
    const seen: unknown[] = [];
    let ctx: AppContext | undefined;
    running.push(runApp(defineApp({ activate(value) {
      ctx = value;
      value.locale.onChange((snapshot) => seen.push(snapshot));
    } }), h.bridge));
    h.send(changed("zh", 3));
    h.send(changed("en", 999, "wrong-session"));
    h.send(initial());
    await tick();
    h.send(changed("en", 2));
    h.send(changed("en", 3));
    h.send(changed("fr", 4));
    h.send(changed("en", -1));
    h.send(changed("en", 999, "wrong-session"));
    expect(ctx?.locale.getSnapshot()).toEqual({ locale: "zh", revision: 3 });
    h.send(changed("en", 4));
    expect(seen).toEqual([{ locale: "zh", revision: 3 }, { locale: "en", revision: 4 }]);
  });

  test("subscriptions replay, isolate listener failures, unsubscribe and work without visibility callbacks", async () => {
    const h = harness();
    let ctx!: AppContext;
    running.push(runApp(defineApp({ activate(value) { ctx = value; } }), h.bridge));
    h.send(initial());
    await tick();
    const seen: unknown[] = [];
    const stopBad = ctx.locale.onChange(() => { throw new Error("consumer failure"); });
    const stop = ctx.locale.onChange((snapshot) => seen.push(snapshot));
    h.send(changed("zh", 2));
    stop();
    stopBad();
    h.send(changed("en", 3));
    expect(seen).toEqual([{ locale: "en", revision: 1 }, { locale: "zh", revision: 2 }]);
  });

  test("read failure settles queued mount with the original error and never invokes business callbacks", async () => {
    const read = deferred<unknown>();
    const h = harness(() => read.promise);
    let activations = 0;
    running.push(runApp(defineApp({ activate() { activations++; } }), h.bridge));
    h.send(initial());
    h.send(mount());
    h.send({ type: "service.invoke", correlationId: "c1", serviceId: "x", method: "x", input: {} });
    read.reject({ code: "LOCALE_UNAVAILABLE", message: "locale read failed" });
    await tick();
    expect(activations).toBe(0);
    expect(h.notices.filter((n) => n.method === "app.activate-failed")).toHaveLength(1);
    const failures = h.notices.filter((n) => n.method === "surface.failed");
    expect(failures).toHaveLength(1);
    expect(failures[0]?.params.error.code).toBe("LOCALE_UNAVAILABLE");
    expect(h.notices.some((n) => ["app.registered", "surface.ready"].includes(n.method))).toBe(false);
    expect(h.notices.filter((n) => n.method === "service.settled").map(n => n.params.error.code)).toEqual(["LOCALE_UNAVAILABLE"]);
  });

  test("a bridge ignoring cancellation still times out; its late reply cannot reactivate", async () => {
    const read = deferred<unknown>();
    const h = harness(() => read.promise);
    let activations = 0;
    running.push(runApp(defineApp({ activate() { activations++; } }), h.bridge));
    h.send(initial());
    h.send(mount());
    await new Promise((resolve) => setTimeout(resolve, 3_100));
    expect(activations).toBe(0);
    expect(h.notices.filter((n) => n.method === "surface.failed")).toHaveLength(1);
    expect(h.notices.find((n) => n.method === "surface.failed")?.params.error.code).toBe("LOCALE_INIT_TIMEOUT");
    read.resolve({ runtimeSessionId: "s1", locale: "zh", revision: 9 });
    await tick();
    expect(activations).toBe(0);
    expect(h.notices.filter((n) => n.method === "surface.failed")).toHaveLength(1);
  });

  test("a disposed runtime ignores a pending locale reply and repeated cleanup", async () => {
    const read = deferred<unknown>();
    const h = harness(() => read.promise);
    let activations = 0;
    let cleanups = 0;
    const app = runApp(defineApp({ activate() { activations++; }, deactivate() { cleanups++; } }), h.bridge);
    running.push(app);
    h.send(initial());
    h.send(mount());
    h.send({ type: "deactivate" });
    await app.dispose();
    read.resolve({ runtimeSessionId: "s1", locale: "en", revision: 1 });
    await tick();
    expect(activations).toBe(0);
    expect(cleanups).toBe(1);
    expect(h.notices).toEqual([]);
  });

  test("synchronous queued deactivate is safe during bridge subscription", async () => {
    let cleanups = 0;
    let unsubscribed = 0;
    const h = harness();
    h.bridge.subscribe = (handler) => {
      handler({ type: "deactivate" });
      return () => { unsubscribed++; };
    };
    const app = runApp(defineApp({ activate() {}, deactivate() { cleanups++; } }), h.bridge);
    running.push(app);
    await app.dispose();
    expect(cleanups).toBe(1);
    expect(unsubscribed).toBe(1);
  });
});
