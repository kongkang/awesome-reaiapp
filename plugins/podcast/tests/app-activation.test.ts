/**
 * 插件接口 mock 验证：activate 的语言时序、surface 成功挂载、intent 打开抽屉、
 * 卸载清理、挂载失败走 surface.fail、deactivate/重复 activate 释放监听。
 * 全部走 mock ctx，不触真实 Host，也不执行真实音频播放。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

import app from "../src/app";
import { podcastLocale, releaseLocaleBindings, setPodcastLocale } from "../src/podcast-i18n";

beforeEach(() => {
  if (typeof document === "undefined") GlobalRegistrator.register();
});
afterEach(() => {
  releaseLocaleBindings(document.body);
  document.body.replaceChildren();
  setPodcastLocale("zh");
});

type SurfaceMount = (surface: SurfaceHarness) => Promise<() => void>;

interface SurfaceHarness {
  root: HTMLElement;
  initialIntent?: unknown;
  onIntent(handler: (intent: unknown) => void): () => void;
  ready(): void;
  fail(error: Error): void;
}

function makeCtx(options: {
  snapshotLocale?: string;
  onChange?: (handler: (snapshot: { locale: string; revision: number }) => void) => () => void;
}) {
  let registered: SurfaceMount | undefined;
  const localeHandlers = new Set<(snapshot: { locale: string; revision: number }) => void>();
  const ctx = {
    locale:
      options.snapshotLocale === undefined && !options.onChange
        ? undefined
        : {
            getSnapshot: () => ({ locale: options.snapshotLocale ?? "zh", revision: 7 }),
            onChange: options.onChange
              ?? ((handler: (snapshot: { locale: string; revision: number }) => void) => {
                localeHandlers.add(handler);
                return () => localeHandlers.delete(handler);
              }),
          },
    surfaces: {
      register: (surfaceId: string, mount: SurfaceMount) => {
        if (surfaceId !== "main") throw new Error(`未知 surface：${surfaceId}`);
        registered = mount;
      },
    },
  };
  return {
    ctx: ctx as unknown as Parameters<typeof app.activate>[0],
    pushLocale(locale: string) {
      for (const handler of [...localeHandlers]) handler({ locale, revision: 99 });
    },
    async mountSurface(surface: Partial<SurfaceHarness> = {}) {
      if (!registered) throw new Error("surfaces.register 未被调用");
      let intentHandler: ((intent: unknown) => void) | undefined;
      let stopIntentCalls = 0;
      let readyCalls = 0;
      const failures: Error[] = [];
      const full: SurfaceHarness = {
        root: document.createElement("div"),
        onIntent(handler) {
          intentHandler = handler;
          return () => {
            stopIntentCalls++;
          };
        },
        ready: () => readyCalls++,
        fail: (error) => failures.push(error),
        ...surface,
      };
      const cleanup = await registered(full);
      return {
        surface: full,
        readyCalls: () => readyCalls,
        failures,
        stopIntentCalls: () => stopIntentCalls,
        dispatchIntent: (intent: unknown) => intentHandler?.(intent),
        cleanup: () => cleanup?.(),
      };
    },
  };
}

describe("Podcast 插件接口（mock）", () => {
  afterEach(async () => {
    // 统一释放 activate 注册的 runtime 级 locale 监听，避免跨用例残留。
    await app.deactivate?.();
  });

  test("英文快照先于首屏：挂载即英文，ready 恰好一次", async () => {
    const { ctx, mountSurface } = makeCtx({ snapshotLocale: "en" });
    await app.activate(ctx);
    const { surface, readyCalls, failures, stopIntentCalls, cleanup } = await mountSurface();
    expect(podcastLocale()).toBe("en");
    expect(surface.root.querySelector(".pod-notes-kicker")?.textContent).toBe("Show notes");
    expect(readyCalls()).toBe(1);
    expect(failures).toHaveLength(0);
    expect(stopIntentCalls()).toBe(0);
    cleanup();
    expect(surface.root.textContent).toBe("");
  });

  test("activate 后 Host 语言变化：新挂载的 Surface 直接用最新语言", async () => {
    const { ctx, mountSurface, pushLocale } = makeCtx({
      snapshotLocale: "zh",
      onChange: undefined,
    });
    await app.activate(ctx);
    expect(podcastLocale()).toBe("zh");
    pushLocale("en");
    expect(podcastLocale()).toBe("en");
    const { surface, cleanup } = await mountSurface();
    expect(surface.root.querySelector(".pod-notes-kicker")?.textContent).toBe("Show notes");
    cleanup();
  });

  test("老 Host 没有 ctx.locale：按历史默认中文挂载", async () => {
    const { ctx, mountSurface } = makeCtx({});
    await app.activate(ctx);
    const { surface, readyCalls, cleanup } = await mountSurface();
    expect(podcastLocale()).toBe("zh");
    expect(surface.root.querySelector(".pod-notes-kicker")?.textContent).toBe("本期提要");
    expect(readyCalls()).toBe(1);
    cleanup();
  });

  test("标题栏 intent 打开往期抽屉，无关 intent 无副作用；卸载清理释放视图", async () => {
    const { ctx, mountSurface } = makeCtx({ snapshotLocale: "zh" });
    await app.activate(ctx);
    const { surface, dispatchIntent, cleanup, stopIntentCalls } = await mountSurface();
    expect(surface.root.querySelector(".pod-drawer")?.classList.contains("open")).toBe(false);
    dispatchIntent({
      source: "host.titlebarAction",
      actionId: "history",
      payload: { type: "toggle-history" },
    });
    expect(surface.root.querySelector(".pod-drawer")?.classList.contains("open")).toBe(true);
    dispatchIntent({ source: "host.titlebarAction", actionId: "other", payload: {} });
    expect(surface.root.querySelector(".pod-drawer")?.classList.contains("open")).toBe(true);
    expect(stopIntentCalls()).toBe(0);

    cleanup();
    expect(stopIntentCalls()).toBe(1);
    expect(surface.root.textContent).toBe("");
  });

  test("首挂载即带 initialIntent：抽屉同样打开（initialIntent 回放路径）", async () => {
    const { ctx, mountSurface } = makeCtx({ snapshotLocale: "en" });
    await app.activate(ctx);
    const { surface, cleanup } = await mountSurface({
      initialIntent: {
        source: "host.titlebarAction",
        actionId: "history",
        payload: { type: "toggle-history" },
      },
    });
    expect(surface.root.querySelector(".pod-drawer")?.classList.contains("open")).toBe(true);
    expect(surface.root.querySelector(".pod-drawer-title")?.textContent?.startsWith("Episodes")).toBe(true);
    cleanup();
    expect(surface.root.textContent).toBe("");
  });

  test("挂载失败：stopIntent 先释放，surface.fail 收到当前语言的受控错误", async () => {
    const failingRoot = () => {
      const root = document.createElement("div");
      Object.defineProperty(root, "replaceChildren", {
        value: () => {
          throw new Error("boom");
        },
      });
      return root;
    };
    const en = makeCtx({ snapshotLocale: "en" });
    await app.activate(en.ctx);
    const enMounted = await en.mountSurface({ root: failingRoot() });
    expect(enMounted.failures).toHaveLength(1);
    expect(enMounted.failures[0]!.message).toBe("AI Podcast UI failed to start");
    expect(enMounted.readyCalls()).toBe(0);
    expect(enMounted.stopIntentCalls()).toBe(1);

    const zh = makeCtx({ snapshotLocale: "zh" });
    await app.activate(zh.ctx);
    const zhMounted = await zh.mountSurface({ root: failingRoot() });
    expect(zhMounted.failures).toHaveLength(1);
    expect(zhMounted.failures[0]!.message).toBe("AI Podcast 界面起不来");

    // 失败不影响后续：切语言、再次挂载都正常。
    setPodcastLocale("en");
    const retried = await zh.mountSurface();
    expect(retried.surface.root.querySelector(".pod-notes-kicker")?.textContent).toBe("Show notes");
    expect(retried.readyCalls()).toBe(1);
    retried.cleanup();
  });

  test("重复 activate 幂等：旧 locale 监听被释放，不叠加", async () => {
    let handlers = 0;
    let stops = 0;
    const { ctx, mountSurface } = makeCtx({
      snapshotLocale: "zh",
      onChange: () => {
        handlers++;
        return () => stops++;
      },
    });
    await app.activate(ctx);
    await app.activate(ctx);
    expect(handlers).toBe(2);
    expect(stops).toBe(1);
    const { readyCalls } = await mountSurface();
    expect(readyCalls()).toBe(1);
    await app.deactivate?.();
    expect(stops).toBe(2);
  });
});
