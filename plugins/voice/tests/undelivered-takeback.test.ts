/**
 * 缺陷2 端到端（2026-09-18 系统级卡片形态）：写回 focus_changed 时必须向 Host
 * 请求弹出「取回文字」卡片（胶囊正上方），全文与本地化原因随请求送出；写回
 * 成功时不请求。文字本体永远同时保留在历史里。
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { MockHost } from "@reai/app-test/v1";
import type { AppContext } from "@reai/app-sdk/v1";
import manifest from "../app.manifest.json";
import { DEFAULT_SETTINGS, DEFAULT_VOICE_FEATURE_SETTINGS, POLISH_LIGHT_DEFAULT_MIGRATION_KEY } from "../src/data";
import { setVoiceLocale } from "../src/voice-i18n";

let ownsDom = false;

beforeAll(() => {
  if (typeof document === "undefined") { GlobalRegistrator.register(); ownsDom = true; }
  setVoiceLocale("zh");
});
afterAll(() => {
  if (ownsDom) GlobalRegistrator.unregister();
});

async function until(check: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 2500;
  while (!check() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  expect(check(), message).toBeTrue();
}

function takebackRequests(host: MockHost): Array<Record<string, unknown>> {
  return host.cloudRequests.filter(request => request.method === "voice.deliver.present-takeback");
}

function makeHost(hook?: (ctx: AppContext) => Promise<void>): MockHost {
  return new MockHost({
    manifest: structuredClone(manifest) as never,
    loadApp: async () => {
      const { default: app } = await import("../src/app");
      return { default: { ...app, async activate(ctx: AppContext) {
        const store = ctx.storage.private("voice-state");
        await store.set("recognition-engine-choice-v1", "cloud");
        await store.set("settings", { ...DEFAULT_SETTINGS, engine: "cloud", polish: "raw" });
        // 显式选过原样的 profile（润色默认档迁移已完成），写回的是识别原文。
        await store.set(POLISH_LIGHT_DEFAULT_MIGRATION_KEY, 1);
        await store.set("voice-feature-settings-v1", { ...DEFAULT_VOICE_FEATURE_SETTINGS, cloudModelId: "transcribe-free" });
        if (hook) await hook(ctx);
        return app.activate(ctx);
      } } };
    },
    createRoot: () => { const root = document.createElement("div"); document.body.append(root); return root; },
  });
}

async function toggleOnce(host: MockHost): Promise<void> {
  const event = "com.reai.voice.toggle-input";
  expect((await host.invokeCommand(event)).ok).toBeTrue();
  expect((await host.invokeCommand(event)).ok).toBeTrue();
  const commits = () => host.cloudRequests.filter(request => request.method === "voice.deliver.commit");
  await until(() => commits().length === 1, "写回恰好发生一次");
}

test("focus_changed：请求弹出「取回文字」卡片，本地化文案 + 全文随请求送出", async () => {
  document.body.replaceChildren();
  let context: AppContext | undefined;
  const host = makeHost(async (ctx) => { context = ctx; });
  const transport = host as unknown as { handleRequest(method: string, params: Record<string, unknown>): Promise<unknown> };
  const original = transport.handleRequest.bind(host);
  let injected = false;
  transport.handleRequest = async (method, params) => {
    const result = await original(method, params);
    if (method !== "voice.deliver.commit" || injected) return result;
    injected = true;
    return { committed: false, reason: "focus_changed" };
  };
  await host.installAndEnable();
  try {
    const surface = await host.openSurface("main");
    await toggleOnce(host);

    await until(() => takebackRequests(host).length === 1, "写回失败必须请求弹出「取回文字」卡片");
    const params = takebackRequests(host)[0]!.params as { title: string; reason: string; text: string };
    expect(params.title).toBe("文字没有写入成功");
    // §6.0：取回卡原因带上真实失败码（只有码，不带原文）。
    expect(params.reason).toBe("无法写入目标输入位置（focus_changed）");
    expect(params.text).toBe("测试云端转写");
    // 页内不再渲染兜底浮层（那是被替换掉的旧形态）。
    expect(surface.root!.querySelector(".undelivered-text-panel")).toBeNull();

    // 历史仍保留同一条（卡片是兜底，不是替代）。
    const history = await context!.storage.private("voice-state").get<Array<{ transcript?: string; inserted?: boolean }>>("history");
    expect(history![0]!.transcript).toBe("测试云端转写");
    expect(history![0]!.inserted).toBeFalse();
  } finally {
    transport.handleRequest = original;
    await host.disable();
  }
});

test("写回成功：不请求弹出卡片", async () => {
  document.body.replaceChildren();
  const host = makeHost();
  await host.installAndEnable();
  try {
    await host.openSurface("main");
    await toggleOnce(host);
    await until(() => host.cloudRequests.some(request => request.method === "voice.deliver.commit"), "写回已发生");
    expect(takebackRequests(host)).toHaveLength(0);
  } finally {
    await host.disable();
  }
});

test("旧 Host 拒绝 present-takeback：异常被吞，历史仍落盘", async () => {
  document.body.replaceChildren();
  let context: AppContext | undefined;
  const host = makeHost(async (ctx) => { context = ctx; });
  const transport = host as unknown as { handleRequest(method: string, params: Record<string, unknown>): Promise<unknown> };
  const original = transport.handleRequest.bind(host);
  let injected = false;
  transport.handleRequest = async (method, params) => {
    // 模拟不支持该方法的旧 Host：capability 层稳定拒绝。
    if (method === "voice.deliver.present-takeback") {
      throw new Error("HOST_CAPABILITY_NOT_AVAILABLE: 结果写回不支持 voice.deliver.present-takeback");
    }
    const result = await original(method, params);
    // 注入写回失败，才会走到「请求弹卡片」这一步。
    if (method !== "voice.deliver.commit" || injected) return result;
    injected = true;
    return { committed: false, reason: "focus_changed" };
  };
  await host.installAndEnable();
  try {
    await host.openSurface("main");
    const event = "com.reai.voice.toggle-input";
    expect((await host.invokeCommand(event)).ok).toBeTrue();
    expect((await host.invokeCommand(event)).ok).toBeTrue();
    const commits = () => host.cloudRequests.filter(request => request.method === "voice.deliver.commit");
    await until(() => commits().length === 1, "写回恰好发生一次");
    // 卡片请求发出过（Host 端拒了），插件不能因此崩掉或丢历史。
    await until(() => commits().length === 1, "稳态：写回链路已收口");
    const history = await context!.storage.private("voice-state").get<Array<{ transcript?: string; inserted?: boolean }>>("history");
    expect(history![0]!.transcript).toBe("测试云端转写");
    expect(history![0]!.inserted).toBeFalse();
  } finally {
    transport.handleRequest = original;
    await host.disable();
  }
});
