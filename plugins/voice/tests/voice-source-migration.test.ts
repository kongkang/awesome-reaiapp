import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { MockHost } from "@reai/app-test/v1";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_SETTINGS,
  SOURCE_MIGRATION_KEY,
  SOURCE_MIGRATION_NOTICE,
  SOURCE_MIGRATION_NOTICE_KEY,
  SOURCE_SELECTION_KEY,
} from "../src/data";

const root = join(import.meta.dir, "..");
const manifest = JSON.parse(
  readFileSync(join(root, "app.manifest.json"), "utf8"),
) as Record<string, unknown>;

let ownsDomRegistration = false;
beforeAll(() => {
  if (typeof document === "undefined") {
    GlobalRegistrator.register();
    ownsDomRegistration = true;
  }
});
afterAll(() => {
  if (ownsDomRegistration) GlobalRegistrator.unregister();
});
beforeEach(() => document.body.replaceChildren());

type UnsafeMockHost = { storage: Map<string, unknown> };
const storageKey = (key: string) => `com.reai.voice/voice-state/${key}`;
const seed = (host: MockHost, key: string, value: unknown) => {
  (host as unknown as UnsafeMockHost).storage.set(storageKey(key), structuredClone(value));
};
const stored = (host: MockHost, key: string) =>
  (host as unknown as UnsafeMockHost).storage.get(storageKey(key));

function createHost(): MockHost {
  return new MockHost({
    loadApp: () => import("../src/app"),
    manifest: structuredClone(manifest) as never,
    voiceInputStatus: {
      phase: "idle",
      source: "board",
      modelId: DEFAULT_SETTINGS.modelId,
      sourceReady: true,
    },
    createRoot: () => {
      const element = document.createElement("div");
      document.body.append(element);
      return element;
    },
  });
}

describe("Voice 旧系统音源的一次性 v2 迁移", () => {
  test("键盘来源打开 Voice surface 不枚举系统输入", async () => {
    const host = createHost();
    seed(host, "settings", DEFAULT_SETTINGS);

    await host.installAndEnable();
    const surface = await host.openSurface("main");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(
      host.voiceInputRequests.filter(
        (request) => request.method === "voice.system-inputs.list",
      ),
    ).toHaveLength(0);

    await host.unmountSurface(surface.surfaceMountId);
    await host.disable();
  });

  test("Board 慢刷新不能清空切到系统来源后刚加载的输入列表", async () => {
    const host = createHost();
    seed(host, "settings", DEFAULT_SETTINGS);
    const anyHost = host as unknown as {
      handleRequest(method: string, params: unknown): Promise<unknown>;
    };
    const original = anyHost.handleRequest.bind(host);
    let intercepted = false;
    let releaseRefresh: () => void = () => undefined;
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    anyHost.handleRequest = async (method, params) => {
      if (method === "voice.status" && !intercepted) {
        intercepted = true;
        await refreshGate;
      }
      return original(method, params);
    };

    await host.installAndEnable();
    const surface = await host.openSurface("main");
    expect(intercepted).toBeTrue();
    await host.sendIntent(surface.surfaceMountId, {
      source: "host.titlebarAction",
      actionId: "settings",
      deliveryId: "stale-board-refresh-test",
      payload: { type: "open-settings" },
    });
    surface.root?.querySelector<HTMLButtonElement>(
      '[data-settings-target="source"]',
    )?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const endpointBeforeOldRefresh = surface.root?.querySelector<HTMLSelectElement>(
      'select[aria-label="系统输入设备"]',
    );
    expect(endpointBeforeOldRefresh?.disabled).toBeFalse();
    expect(endpointBeforeOldRefresh?.textContent).toContain("Mock microphone");

    releaseRefresh();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const endpointAfterOldRefresh = surface.root?.querySelector<HTMLSelectElement>(
      'select[aria-label="系统输入设备"]',
    );
    expect(endpointAfterOldRefresh?.disabled).toBeFalse();
    expect(endpointAfterOldRefresh?.textContent).toContain("Mock microphone");

    await host.unmountSurface(surface.surfaceMountId);
    await host.disable();
  });

  test("非来源设置变化不能丢弃慢刷新返回的整页数据", async () => {
    const host = createHost();
    seed(host, "settings", DEFAULT_SETTINGS);
    const anyHost = host as unknown as {
      handleRequest(method: string, params: unknown): Promise<unknown>;
    };
    const original = anyHost.handleRequest.bind(host);
    let intercepted = false;
    let releaseRefresh: () => void = () => undefined;
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    anyHost.handleRequest = async (method, params) => {
      if (method === "voice.models.list") {
        intercepted = true;
        await refreshGate;
        return {
          models: [{
            id: "slow-refresh-model",
            name: "慢刷新模型",
            description: "只由被阻塞的整页刷新返回",
            sizeBytes: 1,
            state: "active",
            active: true,
          }],
        };
      }
      return original(method, params);
    };

    await host.installAndEnable();
    const surface = await host.openSurface("main");
    expect(intercepted).toBeTrue();
    await host.sendIntent(surface.surfaceMountId, {
      source: "host.titlebarAction",
      actionId: "settings",
      deliveryId: "unrelated-settings-refresh-test",
      payload: { type: "open-settings" },
    });
    expect(surface.root?.textContent).not.toContain("慢刷新模型");
    surface.root?.querySelector<HTMLButtonElement>("[data-language-row]")?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    releaseRefresh();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(surface.root?.textContent).toContain("慢刷新模型");

    await host.unmountSurface(surface.surfaceMountId);
    await host.disable();
  });

  test("云端设置不再暴露窗口上下文开关", async () => {
    const host = createHost();
    seed(host, "settings", {
      ...DEFAULT_SETTINGS,
      engine: "cloud",
      polishContext: { ...DEFAULT_SETTINGS.polishContext, window: true },
    });

    await host.installAndEnable();
    const surface = await host.openSurface("main");
    await host.sendIntent(surface.surfaceMountId, {
      source: "host.titlebarAction",
      actionId: "settings",
      deliveryId: "hidden-context-setting-test",
      payload: { type: "open-settings" },
    });
    expect(surface.root?.querySelector('[data-settings-target="polish-context"]')).toBeNull();
    expect(surface.root?.textContent).not.toContain("窗口上下文");

    await host.unmountSurface(surface.surfaceMountId);
    await host.disable();
  });

  test("system 来源 ABA 后旧刷新不能覆盖最新设备列表", async () => {
    const host = createHost();
    seed(host, "settings", {
      ...DEFAULT_SETTINGS,
      source: "system",
      systemEndpointId: "old-mic",
    });
    seed(host, SOURCE_MIGRATION_KEY, 1);
    seed(host, SOURCE_SELECTION_KEY, 2);
    const anyHost = host as unknown as {
      handleRequest(method: string, params: unknown): Promise<unknown>;
    };
    const original = anyHost.handleRequest.bind(host);
    let releaseRefresh: () => void = () => undefined;
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    let systemInputRequestCount = 0;
    anyHost.handleRequest = async (method, params) => {
      if (method === "voice.models.list") await refreshGate;
      if (method === "voice.system-inputs.list") {
        systemInputRequestCount += 1;
        return {
          endpoints: systemInputRequestCount <= 2
            ? [{ id: "old-mic", name: "旧麦克风", isDefault: true }]
            : [{ id: "latest-mic", name: "最新麦克风", isDefault: true }],
        };
      }
      return original(method, params);
    };

    await host.installAndEnable();
    const surface = await host.openSurface("main");
    await host.sendIntent(surface.surfaceMountId, {
      source: "host.titlebarAction",
      actionId: "settings",
      deliveryId: "source-aba-test",
      payload: { type: "open-settings" },
    });
    surface.root?.querySelector<HTMLButtonElement>(
      '[data-settings-target="source"]',
    )?.click();
    await new Promise((resolve) => setTimeout(resolve, 20));
    surface.root?.querySelector<HTMLButtonElement>(
      '[data-settings-target="source"]',
    )?.click();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(surface.root?.textContent).toContain("最新麦克风");

    releaseRefresh();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(surface.root?.textContent).toContain("最新麦克风");
    expect(surface.root?.textContent).not.toContain("旧麦克风");

    await host.unmountSurface(surface.surfaceMountId);
    await host.disable();
  });

  test("system 内切换 endpoint 后旧刷新不能恢复旧设备状态", async () => {
    const host = createHost();
    seed(host, "settings", {
      ...DEFAULT_SETTINGS,
      source: "system",
      systemEndpointId: "old-mic",
    });
    seed(host, SOURCE_MIGRATION_KEY, 1);
    seed(host, SOURCE_SELECTION_KEY, 2);
    const anyHost = host as unknown as {
      handleRequest(method: string, params: unknown): Promise<unknown>;
    };
    const original = anyHost.handleRequest.bind(host);
    let gateEnabled = false;
    let releaseRefresh: () => void = () => undefined;
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    let gatedStatusCount = 0;
    anyHost.handleRequest = async (method, params) => {
      if (method === "voice.system-inputs.list") {
        return {
          endpoints: [
            { id: "old-mic", name: "旧设备", isDefault: true },
            { id: "latest-mic", name: "新设备", isDefault: false },
          ],
        };
      }
      if (gateEnabled && method === "voice.status") {
        gatedStatusCount += 1;
        return {
          phase: "idle",
          source: "system",
          modelId: DEFAULT_SETTINGS.modelId,
          sourceReady: gatedStatusCount > 1,
          ...(gatedStatusCount > 1 ? {} : { sourceIssue: "endpoint_unavailable" }),
        };
      }
      if (gateEnabled && method === "voice.models.list") await refreshGate;
      return original(method, params);
    };

    await host.installAndEnable();
    const surface = await host.openSurface("main");
    await host.sendIntent(surface.surfaceMountId, {
      source: "host.titlebarAction",
      actionId: "settings",
      deliveryId: "endpoint-refresh-setup",
      payload: { type: "open-settings" },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    gateEnabled = true;
    await host.sendIntent(surface.surfaceMountId, {
      type: "system-task.return",
      taskId: "endpoint-refresh",
      target: "permission-settings",
      outcome: "succeeded",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const endpoint = surface.root?.querySelector<HTMLSelectElement>(
      'select[aria-label="系统输入设备"]',
    );
    expect(endpoint).not.toBeNull();
    if (endpoint) {
      endpoint.value = "latest-mic";
      endpoint.dispatchEvent(new Event("change", { bubbles: true }));
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(gatedStatusCount).toBe(2);
    expect(surface.root?.querySelector<HTMLSelectElement>(
      'select[aria-label="系统输入设备"]',
    )?.value).toBe("latest-mic");
    expect(surface.root?.querySelector('[data-action="recognition-test"]')).toBeNull();

    releaseRefresh();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(surface.root?.querySelector<HTMLSelectElement>(
      'select[aria-label="系统输入设备"]',
    )?.value).toBe("latest-mic");
    expect(surface.root?.textContent).not.toContain("麦克风不可用");

    await host.unmountSurface(surface.surfaceMountId);
    await host.disable();
  });

  test("后台激活切回 Board，不携带 legacy 标志，并同时完成 v1/v2 marker", async () => {
    const host = createHost();
    seed(host, "settings", {
      ...DEFAULT_SETTINGS,
      source: "system",
      systemEndpointId: "BlackHole2ch_UID",
    });

    await host.installAndEnable();

    const configure = host.voiceInputRequests.filter((request) => request.method === "voice.configure");
    expect(configure).toHaveLength(1);
    expect(configure[0]?.params).toMatchObject({ source: "board" });
    expect(configure[0]?.params).not.toHaveProperty("systemEndpointId");
    expect(configure[0]?.params).not.toHaveProperty("legacySourceMigration");
    expect(stored(host, "settings")).toMatchObject({ source: "board" });
    expect(stored(host, "settings")).not.toHaveProperty("systemEndpointId");
    expect(stored(host, SOURCE_MIGRATION_KEY)).toBe(1);
    expect(stored(host, SOURCE_SELECTION_KEY)).toBe(2);
    expect(stored(host, SOURCE_MIGRATION_NOTICE_KEY)).toBe(SOURCE_MIGRATION_NOTICE);

    await host.disable();
  });

  test("无 surface 激活不丢提示；第一次打开显示并清除，第二次不再显示", async () => {
    const host = createHost();
    seed(host, "settings", {
      ...DEFAULT_SETTINGS,
      source: "system",
      systemEndpointId: "old-test-device",
    });

    await host.installAndEnable();
    expect(document.querySelector(".voice-source-migration-notice")).toBeNull();
    expect(stored(host, SOURCE_MIGRATION_NOTICE_KEY)).toBe(SOURCE_MIGRATION_NOTICE);

    const first = await host.openSurface("main");
    expect(first.root?.querySelector(".voice-source-migration-notice")?.textContent)
      .toContain("录音来源已恢复为键盘麦克风");
    expect(stored(host, SOURCE_MIGRATION_NOTICE_KEY)).toBeUndefined();
    await host.unmountSurface(first.surfaceMountId);

    const second = await host.openSurface("main");
    expect(second.root?.querySelector(".voice-source-migration-notice")).toBeNull();
    await host.unmountSurface(second.surfaceMountId);
    await host.disable();
  });

  test("任务深链立刻进入对话时不把未显示的提示吃掉，回到列表后才确认", async () => {
    const host = createHost();
    seed(host, "settings", {
      ...DEFAULT_SETTINGS,
      source: "system",
      systemEndpointId: "old-test-device",
    });
    seed(host, "command-history", [{
      id: "task-deep-link",
      transcript: "检查录音来源",
      reply: "已经处理",
      status: "completed",
      createdAt: "2026-08-24T00:00:00.000Z",
    }]);

    await host.installAndEnable();
    const surface = await host.openSurface("main", {
      source: "host.taskConversation",
      payload: { entityId: "task-deep-link" },
    });
    expect(surface.root?.querySelector(".chat-view")).not.toBeNull();
    expect(surface.root?.querySelector(".voice-source-migration-notice")).toBeNull();
    expect(stored(host, SOURCE_MIGRATION_NOTICE_KEY)).toBe(SOURCE_MIGRATION_NOTICE);

    const back = await host.invokeCommand("com.reai.voice.back-to-root", {});
    expect(back.ok).toBeTrue();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(surface.root?.querySelector(".voice-source-migration-notice")?.textContent)
      .toContain("录音来源已恢复为键盘麦克风");
    expect(stored(host, SOURCE_MIGRATION_NOTICE_KEY)).toBeUndefined();

    await host.unmountSurface(surface.surfaceMountId);
    await host.disable();
  });

  test("普通设置不冒充音源确认；用户切到电脑麦克风后才落 marker 和当前默认 endpoint", async () => {
    const host = createHost();
    seed(host, "settings", DEFAULT_SETTINGS);
    seed(host, SOURCE_MIGRATION_KEY, 1);
    await host.installAndEnable();

    const surface = await host.openSurface("main");
    await host.sendIntent(surface.surfaceMountId, {
      source: "host.titlebarAction",
      actionId: "settings",
      deliveryId: "source-selection-test",
      payload: { type: "open-settings" },
    });

    const language = surface.root?.querySelector<HTMLButtonElement>("[data-language-row]");
    expect(language).not.toBeNull();
    language?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(stored(host, SOURCE_SELECTION_KEY)).toBeUndefined();

    const source = surface.root?.querySelector<HTMLButtonElement>(
      '[data-settings-target="source"]',
    );
    expect(source).not.toBeNull();
    const systemInputRequestsBeforeSourceChange = host.voiceInputRequests.filter(
      (request) => request.method === "voice.system-inputs.list",
    ).length;
    source?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      host.voiceInputRequests.filter(
        (request) => request.method === "voice.system-inputs.list",
      ),
    ).toHaveLength(systemInputRequestsBeforeSourceChange + 1);
    expect(stored(host, SOURCE_SELECTION_KEY)).toBe(2);
    expect(stored(host, "settings")).toMatchObject({
      source: "system",
      systemEndpointId: "mock-input-uid",
    });

    await host.unmountSurface(surface.surfaceMountId);
    await host.disable();
  });

  test("迁移清掉旧 BlackHole 后再选电脑麦克风，只使用当前默认 endpoint", async () => {
    const host = createHost();
    seed(host, "settings", {
      ...DEFAULT_SETTINGS,
      source: "system",
      systemEndpointId: "BlackHole2ch_UID",
    });
    await host.installAndEnable();
    expect(stored(host, "settings")).toMatchObject({ source: "board" });
    expect(stored(host, "settings")).not.toHaveProperty("systemEndpointId");

    const surface = await host.openSurface("main");
    await host.sendIntent(surface.surfaceMountId, {
      source: "host.titlebarAction",
      actionId: "settings",
      deliveryId: "blackhole-endpoint-test",
      payload: { type: "open-settings" },
    });
    const source = surface.root?.querySelector<HTMLButtonElement>(
      '[data-settings-target="source"]',
    );
    expect(source).not.toBeNull();
    source?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(stored(host, "settings")).toMatchObject({
      source: "system",
      systemEndpointId: "mock-input-uid",
    });

    await host.unmountSurface(surface.surfaceMountId);
    await host.disable();
  });
});
