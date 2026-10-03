import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { MockHost, flush } from "@reai/app-test/v1";
import manifest from "../app.manifest.json";
import { setLocale } from "../src/i18n";

let ownsDom = false;
beforeAll(() => { if (typeof document === "undefined") { GlobalRegistrator.register(); ownsDom = true; } });
afterEach(() => setLocale("zh"));
afterAll(() => { if (ownsDom) GlobalRegistrator.unregister(); });

test("operation failure reaches Host as an English AppError with its original diagnostic", async () => {
  const host = new MockHost({ manifest, locale: "en", loadApp: () => import("../src/main"), createRoot: () => document.createElement("div") });
  const original = host.bridge.request;
  host.bridge.request = async (method, params, options) => {
    if (method === "codex.tasks.account.read") throw new Error("fixture-account-unavailable");
    return original(method, params, options);
  };
  try {
    await host.installAndEnable();
    const surface = await host.openSurface("main"); await flush();
    const error = surface.errors.find(item => item.diagnostic?.includes("fixture-account-unavailable"));
    expect(error?.code).toBe("com.reai.codex-app/OPERATION_FAILED");
    expect(error?.userMessage).toBe("Codex App operation failed");
    expect(error?.diagnostic).toContain("fixture-account-unavailable");
  } finally { await host.disable(); }
});

test("mount failure reaches Host in the current language without losing its cause", async () => {
  const host = new MockHost({ manifest, locale: "en", loadApp: () => import("../src/main"), createRoot: () => {
    const root = document.createElement("div");
    root.append = () => { throw new Error("fixture-render-unavailable"); };
    return root;
  } });
  try {
    await host.installAndEnable(); const surface = await host.openSurface("main");
    expect(surface.failCount).toBe(1);
    expect(surface.failure?.code).toBe("com.reai.codex-app/SURFACE_MOUNT_FAILED");
    expect(surface.failure?.userMessage).toBe("Could not open the Codex App interface");
    expect(surface.failure?.diagnostic).toContain("fixture-render-unavailable");
  } finally { await host.disable(); }
});
