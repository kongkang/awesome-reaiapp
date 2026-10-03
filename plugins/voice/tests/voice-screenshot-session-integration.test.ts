import { afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { MockHost } from "@reai/app-test/v1";
import manifest from "../app.manifest.json";
import { releaseLocaleBindings, setVoiceLocale } from "../src/voice-i18n";

beforeAll(() => { if (typeof document === "undefined") GlobalRegistrator.register(); });
afterEach(() => { releaseLocaleBindings(document.body); document.body.replaceChildren(); setVoiceLocale("zh"); });
const key = (name: string) => `com.reai.voice/voice-state/${name}`;
const storage = (host: MockHost) => (host as unknown as { storage: Map<string, unknown> }).storage;
async function until(check: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!check() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  expect(check()).toBeTrue();
}

test.each(["activation", "surface-reopen"] as const)("%s expires screenshot consent without starting recording and keeps ordinary preferences", async boundary => {
  const host = new MockHost({ manifest: structuredClone(manifest) as never, locale: "en",
    loadApp: () => import("../src/app"),
    createRoot: () => { const root = document.createElement("div"); document.body.append(root); return root; },
  });
  storage(host).set(key("recognition-engine-choice-v1"), "cloud");
  storage(host).set(key("settings"), { engine: "cloud", polish: "light", source: "board" });
  storage(host).set(key("voice-feature-settings-v1"), { translationTarget: "ja-JP" });
  storage(host).set(key("screenshot-consent"), { enabled: true, consentEpoch: "login-a", version: 1 });
  host.setVoiceContextCapture({ sessionEpoch: boundary === "activation" ? "login-b" : "login-a" });
  await host.installAndEnable();
  let surface = await host.openSurface("main");
  try {
    await host.invokeCommand("com.reai.voice.open-settings");
    const screenshot = () => surface.root!.querySelector<HTMLButtonElement>('[aria-label="Current window screenshot assist"]');
    await until(() => screenshot() !== null);
    if (boundary === "surface-reopen") {
      await until(() => screenshot()!.getAttribute("aria-checked") === "true");
      await host.unmountSurface(surface.surfaceMountId);
      // Both same-account logout/relogin and switching accounts change this Host-owned epoch.
      host.setVoiceContextCapture({ sessionEpoch: "login-b" });
      surface = await host.openSurface("main");
      await host.invokeCommand("com.reai.voice.open-settings");
    }
    await until(() => screenshot() !== null && screenshot()!.getAttribute("aria-checked") === "false");
    expect(storage(host).get(key("screenshot-consent"))).toEqual({ enabled: false, version: 1 });
    expect(storage(host).get(key("settings"))).toMatchObject({ engine: "cloud", polish: "light" });
    expect(surface.root!.querySelector<HTMLSelectElement>("[data-translation-target]")?.value).toBe("ja-JP");
    expect(host.voiceInputRequests.filter(r => r.method === "voice.toggle")).toHaveLength(0);
    expect(host.voiceInputRequests.filter(r => r.method === "voice.context.capture").every(r =>
      !(r.params as Record<string, unknown>).includeWindowScreenshot)).toBe(true);
  } finally {
    await host.unmountSurface(surface.surfaceMountId);
    await host.disable();
  }
});
