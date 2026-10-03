import { MockHost } from "@reai/app-test/v1";
import manifest from "../app.manifest.json";
import { renderChatMessage } from "@reai/chat-ui";
import { presentAgentToolError } from "../src/agent-error-presentation";
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { bindAttribute, bindText, onVoiceLocaleChange, releaseLocaleBindings, setVoiceLocale, t } from "../src/voice-i18n";
import { createDefaultVoiceViewState, DEFAULT_SETTINGS, type VoiceViewState } from "../src/data";
import { mountVoiceView, type VoiceViewActions } from "../src/voice-view";
import { describePolishFailure } from "../src/voice-polish";
import { describeDigestFailure } from "../src/voice-digest";
import zh from "../assets/locales/zh.json";
import en from "../assets/locales/en.json";
beforeAll(() => { if (typeof document === "undefined") GlobalRegistrator.register(); });
afterEach(() => { releaseLocaleBindings(document.body); document.body.replaceChildren(); setVoiceLocale("zh"); });
function flatten(value: Record<string, unknown>, prefix = ""): Record<string, string> {
  return Object.fromEntries(Object.entries(value).flatMap(([key, item]) => typeof item === "string"
    ? [[prefix + key, item]] : Object.entries(flatten(item as Record<string, unknown>, prefix + key + "."))));
}
test("resources have matching non-empty text and interpolation variables", () => {
  const z = flatten(zh), e = flatten(en);
  expect(Object.keys(z).sort()).toEqual(Object.keys(e).sort());
  for (const key of Object.keys(z)) {
    expect(z[key].trim().length).toBeGreaterThan(0);
    expect(e[key].trim().length).toBeGreaterThan(0);
    const variables = (v: string) => [...new Set(v.match(/\{[A-Za-z][A-Za-z0-9_]*\}/g) ?? [])].sort();
    expect(variables(z[key])).toEqual(variables(e[key]));
  }
});
test("unknown languages fall back to English and parameters stay literal", () => {
  setVoiceLocale("ja");
  expect(t("view.inputMetadata", { count: "<b>{language}</b>", language: "English" }))
    .toBe("Characters: <b>{language}</b>; Language: English");
});
test("text updates preserve appended controls and the element's attribute binding", () => {
  const node = document.createElement("button");
  bindAttribute(node, "aria-label", () => t("view.backToVoice"));
  bindText(node, () => t("view.back"));
  const icon = document.createElement("span"); icon.textContent = "icon"; node.append(icon);
  document.body.append(node);
  setVoiceLocale("en");
  expect(node.getAttribute("aria-label")).toBe("Back to Voice");
  expect(node.contains(icon)).toBe(true);
  expect(node.textContent).toBe("‹ Backicon");
});
test("repeated attribute binding replaces its previous source and bad bindings are isolated", () => {
  const node = document.createElement("div"); let oldCalls = 0;
  bindAttribute(node, "title", () => { oldCalls++; return "old"; });
  bindAttribute(node, "title", () => t("view.backToVoice"));
  const bad = document.createElement("span"); let fail = false;
  bindText(bad, () => { if (fail) throw Error("test binding"); return "ok"; });
  const good = document.createElement("span"); bindText(good, () => t("view.back"));
  document.body.append(node, bad, good); fail = true;
  setVoiceLocale("en");
  expect(oldCalls).toBe(1); expect(node.title).toBe("Back to Voice"); expect(good.textContent).toBe("‹ Back");
  releaseLocaleBindings(document.body); fail = false; setVoiceLocale("zh");
  expect(node.title).toBe("Back to Voice");
});
test("绑定 / 语言监听抛错时日志只打结构化投影，不带异常原文（Host 会把 console 转进 App 日志）", () => {
  const secret = "帮我给13800138000打电话 Bearer sk-live-abcdef123456";
  const warned: unknown[][] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => { warned.push(args); };
  const bad = document.createElement("span"); let fail = false;
  bindText(bad, () => { if (fail) throw new Error(secret); return "ok"; });
  document.body.append(bad);
  const stop = onVoiceLocaleChange(() => { throw Object.assign(new Error(secret), { userMessage: secret, code: "AI_TIMEOUT" }); });
  try {
    fail = true;
    setVoiceLocale("en");
  } finally {
    console.warn = original;
    stop();
  }
  const logged = warned.filter((args) => String(args[0]).startsWith("[voice:i18n]"));
  expect(logged.map((args) => args[0])).toEqual(["[voice:i18n] Text binding failed", "[voice:i18n] Locale listener failed"]);
  const text = JSON.stringify(logged);
  for (const piece of ["13800138000", "sk-live", "帮我给", "Bearer"]) expect(text).not.toContain(piece);
  // 结构化字段仍在：登记过的码与原文字数，排障够用。
  expect(logged[1]![1]).toMatchObject({ code: "AI_TIMEOUT" });
  expect((logged[0]![1] as { rawLength?: number }).rawLength).toBeGreaterThan(0);
});
function mount(overrides: Partial<VoiceViewState> = {}, extra: Partial<VoiceViewActions> = {}) {
  const root = document.createElement("div"); document.body.append(root);
  let calls = 0;
  const actions = new Proxy({ onNavigated: () => undefined, ...extra }, { get: (target, key) => key in target
    ? target[key as keyof typeof target] : async () => { calls++; } }) as unknown as VoiceViewActions;
  const state = createDefaultVoiceViewState({ statusLoad: "loaded", models: [], history: [], ...overrides });
  const view = mountVoiceView(root, state, actions, { legacyBack: true });
  return { root, view, calls: () => calls };
}
test("history and settings update in place without rerendering or executing actions", () => {
  const { root, view, calls } = mount();
  const title = root.querySelector(".voice-title");
  setVoiceLocale("en");
  expect(root.textContent).toContain("Voice history");
  if (title) expect(root.querySelector(".voice-title")).toBe(title);
  view.openSettings();
  const body = root.querySelector<HTMLElement>(".main-body")!;
  body.scrollTop = 171;
  const control = root.querySelector<HTMLButtonElement>('[role="radio"]')!;
  control?.focus();
  const callsBeforeSwitch = calls();
  setVoiceLocale("zh");
  expect(root.querySelector(".main-body")).toBe(body);
  expect(body.scrollTop).toBe(171);
  if (control) expect(document.activeElement).toBe(control);
  expect(root.textContent).toContain("录音与识别");
  setVoiceLocale("en");
  expect(root.textContent).toContain("Recording & recognition");
  expect(root.textContent).toContain("Local engine");
  expect(root.querySelector(".voice-legacy-back")?.getAttribute("aria-label")).toBe("Back to Voice");
  expect(calls()).toBe(callsBeforeSwitch);
  view.dispose();
});
test("English cold start covers settings without visible hardcoded Chinese", () => {
  setVoiceLocale("en"); const { root, view } = mount(); view.openSettings();
  const visible = root.textContent ?? "";
  expect(visible.match(/[\u3400-\u9fff]+/g)).toBeNull();
  for (const node of Array.from(root.querySelectorAll("[aria-label],[title],[placeholder]"))) {
    for (const attr of ["aria-label", "title", "placeholder"]) expect(node.getAttribute(attr)?.match(/[\u3400-\u9fff]+/g) ?? null).toBeNull();
  }
  view.dispose();
});

 test("system input option labels change while the selection and device names stay intact", () => {
  const { root, view } = mount({ settings: { ...DEFAULT_SETTINGS, source: "system", systemEndpointId: "mic1" }, systemInputs: [{ id: "mic1", name: "用户的麦克风", isDefault: true }] });
  view.openSettings();
  const select = root.querySelector<HTMLSelectElement>('select[aria-label="系统输入设备"]')!;
  expect(select.value).toBe("mic1");
  setVoiceLocale("en");
  expect(select.options[0].textContent).toBe("System default device");
  expect(select.options[1].textContent).toBe("用户的麦克风 (default)");
  expect(select.value).toBe("mic1");
  setVoiceLocale("zh");
  expect(select.options[0].textContent).toBe("系统默认设备");
  view.dispose();
  const empty = mount({ settings: { ...DEFAULT_SETTINGS, source: "system" }, systemInputs: [] });
  empty.view.openSettings();
  setVoiceLocale("en");
  expect(empty.root.textContent).toContain("No system input devices available");
  empty.view.dispose();
});

test("already-created owned failures follow locale without translating provider details", () => {
  const polish = describePolishFailure({ code: "AI_PERMISSION_REQUIRED" });
  const digest = describeDigestFailure({ code: "AI_NOT_LOGGED_IN" });
  const originalPolish = polish.message;
  const originalDigest = digest.message;
  setVoiceLocale("en");
  expect(polish.message).not.toBe(originalPolish);
  expect(digest.message).not.toBe(originalDigest);
  expect(polish.message.match(/[\u3400-\u9fff]/)).toBeNull();
  const provider = "服务原文 {name} <b>private</b>";
  const unknown = describePolishFailure({ code: "PROVIDER_DETAIL", message: provider });
  // §6.0：认不出的失败主句用固定文案（上游原文可能回显用户说的话）；原文只留内存供界面展开。
  expect(unknown.message).not.toContain(provider);
  expect(unknown.fields?.raw).toContain("服务原文");
  setVoiceLocale("zh");
  expect(unknown.message).toBe("润色暂时不可用，已保留本地识别原文");
});
test("absent optional help and subtitle do not create empty layout or help controls", () => {
  const { root, view } = mount(); view.openSettings();
  for (const node of Array.from(root.querySelectorAll(".settings-row-sub"))) {
    expect(node.textContent?.trim().length).toBeGreaterThan(0);
  }
  const models = [{ id: "test", name: "Test", description: "Test model", sizeBytes: 1, state: "active" as const, active: true, updateAvailable: false }];
  view.update(createDefaultVoiceViewState({ models }));
  view.openSettings("model");
  const row = Array.from(root.querySelectorAll(".settings-row")).find((node) => node.textContent?.includes("语音活动检测"));
  expect(row).toBeDefined();
  expect(row!.querySelector(".settings-hint-trigger")).toBeNull();
  view.dispose();
});
test("keymap navigation failure switches language in place", async () => {
  const { root, view } = mount({}, { onOpenKeymap: async () => { throw { code: "SYSTEM_TASK_BUSY" }; } });
  view.openSettings();
  root.querySelector<HTMLButtonElement>(".voice-events-entry")!.click();
  const target = Array.from(root.querySelectorAll<HTMLButtonElement>("button")).find((node) => node.textContent?.includes("这些命令绑到哪颗键"))!;
  expect(target.querySelector(".settings-row-title")?.textContent).toBe("这些命令绑到哪颗键");
  expect(target.querySelector(".settings-row-sub")?.textContent).toBe("拨杆档位 + 按键的组合也在那里配");
  expect(target.querySelector(".settings-row-value")?.textContent).toBe("设备 › 键位映射");
  target.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const error = root.querySelector(".settings-card-foot-error")!;
  expect(error.textContent).toContain("系统任务正在进行");
  const visibleTarget = root.querySelector<HTMLButtonElement>("[data-keymap-jump]")!;
  setVoiceLocale("en");
  expect(error.textContent).toContain("a system task is running");
  expect(visibleTarget.querySelector(".settings-row-title")?.textContent).toBe("Which keys trigger these commands");
  expect(visibleTarget.querySelector(".settings-row-sub")?.textContent).toBe("Lever position and key combinations are configured there too");
  expect(visibleTarget.querySelector(".settings-row-value")?.textContent).toBe("Devices › Key mapping");
  expect(root.querySelector("[data-keymap-jump]")).toBe(visibleTarget);
  expect(root.querySelector(".settings-card-foot-error")).toBe(error);
  view.dispose();
});

test("active tool and authentication cards follow locale without replacing their nodes", () => {
  const tool = renderChatMessage({ from: "ai", text: "", at: "2026-09-07T00:00:00Z", card: {
    kind: "tool", tool: "web_search", status: "running",
    get label() { return t("app.searchingTheWebWithTheBrowserExtension"); },
  } });
  const error = presentAgentToolError("web_access_not_logged_in", { code: "unknown", message: "raw" });
  const auth = renderChatMessage({ from: "ai", text: "", at: "2026-09-07T00:00:00Z", card: error.card });
  document.body.append(tool, auth);
  const label = tool.querySelector(".chat-status-label")!;
  const title = auth.querySelector(".chat-status-title")!;
  const detail = auth.querySelector(".chat-status-detail")!;
  expect(label.textContent).toBe("正在使用浏览器插件进行联网搜索");
  expect(title.textContent).toBe("需要重新登录");
  setVoiceLocale("en");
  expect(label.textContent).toBe(en.app.searchingTheWebWithTheBrowserExtension);
  expect(title.textContent).toBe(en.agentErrors.message6);
  expect(detail.textContent).toBe(en.agentErrors.message7);
  expect(tool.querySelector(".chat-status-label")).toBe(label);
  expect(auth.querySelector(".chat-status-title")).toBe(title);
});

test.each(["poll", "surface-refresh"])("passive recording stop follows Host locale through %s", async (route) => {
  const host = new MockHost({
    manifest: structuredClone(manifest) as never,
    loadApp: () => import("../src/app"),
    createRoot: () => { const root = document.createElement("div"); document.body.append(root); return root; },
  });
  // Exercise the configured Voice surface, after first-run recognition choice.
  (host as unknown as { storage: Map<string, unknown> }).storage.set(
    "com.reai.voice/voice-state/recognition-engine-choice-v1", "local");
  await host.installAndEnable();
  let surface = await host.openSurface("main");
  try {
    const started = await host.invokeCommand("com.reai.voice.toggle-input");
    if (!started.ok) throw new Error("MockHost did not start recording");
    const sessionId = (started.output as { sessionId: string }).sessionId;
    expect(sessionId).toBeTruthy();
    host.setVoiceInputStatus({ phase: "idle", source: "board", sourceReady: true,
      modelId: "sensevoice-small-int8", sessionId, stopReason: "capture_limit" });
    if (route === "surface-refresh") {
      await host.unmountSurface(surface.surfaceMountId);
      surface = await host.openSurface("main");
    }
    const root = surface.root!;
    const deadline = Date.now() + 2500;
    while (!root.textContent?.includes(zh.data.message1) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(root.textContent).toContain(zh.data.message1);
    const toggles = host.voiceInputRequests.filter(request => request.method === "voice.toggle").length;
    host.setLocale("en");
    expect(root.textContent).toContain(en.data.message1);
    expect(root.textContent).not.toContain(zh.data.message1);
    expect(host.voiceInputRequests.filter(request => request.method === "voice.toggle")).toHaveLength(toggles);
  } finally {
    await host.unmountSurface(surface.surfaceMountId);
    await host.disable();
  }
});

test("Host breadcrumb labels refresh on locale change without navigating or duplicate reports", async () => {
  const host = new MockHost({
    manifest: structuredClone(manifest) as never,
    loadApp: () => import("../src/app"),
    createRoot: () => { const root = document.createElement("div"); document.body.append(root); return root; },
  });
  // Exercise the configured Voice surface, after first-run recognition choice.
  (host as unknown as { storage: Map<string, unknown> }).storage.set(
    "com.reai.voice/voice-state/recognition-engine-choice-v1", "local");
  await host.installAndEnable();
  const surface = await host.openSurface("main");
  try {
    await host.invokeCommand("com.reai.voice.open-settings");
    expect(surface.navReports.at(-1)).toEqual({ key: "settings", label: "设置" });
    const settings = surface.root!.querySelector(".voice-settings-view");
    host.setLocale("en");
    expect(surface.navReports.at(-1)).toEqual({ key: "settings", label: "Settings" });
    expect(surface.root!.querySelector(".voice-settings-view")).toBe(settings);
    const reports = surface.navReports.length;
    host.setLocale("en");
    expect(surface.navReports).toHaveLength(reports);
    surface.root!.querySelector<HTMLButtonElement>(".voice-events-entry")!.click();
    expect(surface.navReports.at(-1)).toEqual({ key: "settings/events", label: en.app.manageTriggerEvents });
    host.setLocale("zh");
    expect(surface.navReports.at(-1)).toEqual({ key: "settings/events", label: "触发事件管理" });
  } finally {
    await host.unmountSurface(surface.surfaceMountId);
    await host.disable();
  }
});
