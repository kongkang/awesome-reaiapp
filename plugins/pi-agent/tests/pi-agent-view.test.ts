import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

import type {
  PiManagementModel,
  PiManagementSessionDetail,
  PiManagementSettings,
  PiManagementSnapshot,
} from "@reai/app-sdk/v1";
import { mountPiAgentView } from "../src/pi-agent-view";

import { setLocale, t } from "../src/i18n";
afterEach(() => setLocale("zh"));

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

const models = {
  models: [],
  settings: { defaultModel: "text-default", appOverrides: {} },
  loggedIn: true,
};

const session = (id: string) => ({
  sessionId: id,
  appId: "com.reai.voice",
  appName: "Voice",
  title: id,
  status: "idle" as const,
  temporary: false,
  createdMs: 1,
  updatedMs: 1,
  model: "text-default",
  workspace: "App 私有工作区",
  directory: `pi-agent/sessions/voice/${id}`,
  memory: "session" as const,
});

const snapshot = (): PiManagementSnapshot => ({
  runtime: { state: "ready", scope: "app-bundled" },
  turns: [],
  sessions: [session("s1"), session("s2")],
  settings: models.settings,
});

const mountedWith = (
  snapshotValue: PiManagementSnapshot,
  modelPayload: {
    models: PiManagementModel[];
    settings: PiManagementSettings;
    loggedIn: boolean;
  } = models,
): { root: HTMLDivElement; view: ReturnType<typeof mountPiAgentView>; saved: PiManagementSnapshot["settings"][] } => {
  const root = document.createElement("div");
  document.body.append(root);
  const saved: PiManagementSnapshot["settings"][] = [];
  const view = mountPiAgentView(root, snapshotValue, modelPayload, {
    onRefresh: async () => undefined,
    onSelect: async () => ({ sessionId: "s1", systemPrompt: "PROMPT", skills: [], tools: [], mcp: [] }),
    onSaveSettings: async (value) => {
      saved.push(value);
    },
    onNavigate: () => undefined,
  });
  return { root, view, saved };
};

test("详情请求在轮询刷新后返回仍合并到当前快照", async () => {
  const root = document.createElement("div");
  document.body.append(root);
  let resolveDetail!: (value: PiManagementSessionDetail) => void;
  const deferred = new Promise<PiManagementSessionDetail>((resolve) => { resolveDetail = resolve; });
  const view = mountPiAgentView(root, snapshot(), models, {
    onRefresh: async () => undefined,
    onSelect: async () => await deferred,
    onSaveSettings: async () => undefined,
    onNavigate: () => undefined,
  });

  root.querySelector<HTMLButtonElement>('[data-session="s2"]')?.click();
  view.update(snapshot(), models);
  resolveDetail({ sessionId: "s2", systemPrompt: "DETAIL_OK", skills: [], tools: [], mcp: [] });
  await new Promise((resolve) => setTimeout(resolve, 0));
  root.querySelector<HTMLButtonElement>('[data-tab="config"]')?.click();
  expect(root.textContent).toContain("DETAIL_OK");
  view.destroy();
  root.remove();
});

test("记录页与列表都优先展示 active 回合", () => {
  const value = snapshot();
  value.sessions = [{ ...session("s1"), status: "active", title: "正在做的事" }];
  value.turns = [
    { key: "a", appId: "com.reai.voice", logicalSessionId: "s1", turnId: "queued", state: "queued", summary: "下一问", startedMs: 1, temporary: false },
    { key: "z", appId: "com.reai.voice", logicalSessionId: "s1", turnId: "active", state: "active", summary: "正在做的事", startedMs: 2, temporary: false },
  ];
  const root = document.createElement("div");
  document.body.append(root);
  const view = mountPiAgentView(root, value, models, {
    onRefresh: async () => undefined,
    onSelect: async () => ({ sessionId: "s1", systemPrompt: "", skills: [], tools: [], mcp: [] }),
    onSaveSettings: async () => undefined,
    onNavigate: () => undefined,
  });
  root.querySelector<HTMLButtonElement>('[data-tab="activity"]')?.click();
  expect(root.textContent).toContain("处理中 · 正在做的事");
  expect(root.textContent).not.toContain("等待中 · 下一问");
  view.destroy();
  root.remove();
});

const fullModels: {
  models: PiManagementModel[];
  settings: PiManagementSettings;
  loggedIn: boolean;
} = {
  models: [
    { id: "text-default", label: "通用文本", verified: true, selectable: true },
    { id: "text-fast", label: "快速文本", verified: true, selectable: true },
    { id: "text-quality", label: "高质量文本", verified: false, selectable: false },
  ],
  settings: { defaultModel: "text-default", appOverrides: { "com.reai.voice": "text-fast" } },
  loggedIn: true,
};

test("主页骨架与设计稿逐字文案一致", () => {
  const value = snapshot();
  value.sessions = [{ ...session("s1"), status: "active" as const }];
  value.turns = [
    { key: "a", appId: "com.reai.voice", logicalSessionId: "s1", state: "active" as const, summary: "正在做的事", startedMs: 2, temporary: false },
  ];
  const { root, view } = mountedWith(value);
  const aside = root.querySelector<HTMLElement>(".pa-side");
  expect(aside?.getAttribute("aria-label")).toBe("Pi Agent 会话列表");
  expect(root.querySelector(".pa-layout")?.classList.contains("main-body")).toBe(true);
  expect(root.querySelector(".pa-title")?.textContent).toBe("会话");
  expect(root.querySelector(".pa-side-sub")?.textContent).toBe("1 个正在处理 · 0 个等待");
  expect(root.querySelector(".pa-runtime-pill i")?.tagName.toLowerCase()).toBe("i");
  expect(root.querySelector(".pa-runtime-pill")?.textContent).toContain("运行正常");
  expect(root.querySelector(".pa-scope")?.textContent).toContain("范围：App 内 Agent");
  expect(root.querySelector<HTMLInputElement>(".pa-search input")?.placeholder).toBe("搜索会话…");
  expect(root.querySelector(".pa-isolation")?.textContent).toBe("不读取电脑独立安装的 Pi 或 DSH");
  expect(root.querySelector<HTMLElement>(".rs-handle")?.title).toBe("拖动调整宽度 · 双击复位");
  expect(root.querySelector(".pa-main")?.getAttribute("aria-live")).toBe("polite");
  expect(root.querySelector(".pa-tabs")?.getAttribute("aria-label")).toBe("会话详情");
  for (const label of ["概览", "能力", "记录"]) {
    expect(Array.from(root.querySelectorAll<HTMLButtonElement>(".pa-tab"), (item) => item.textContent)).toContain(label);
  }
  // 分组头：图标徽标 + 插件名 + 会话数
  expect(root.querySelector(".pa-group-h")?.textContent).toContain("Voice");
  expect(root.querySelector(".pa-group-h em")?.textContent).toBe("1");
  // 概览 kv 表：来自 / 使用模型 / 运行位置 / 开始于
  const overview = root.querySelector('[data-pa-panel="overview"]');
  expect(overview?.classList.contains("active")).toBe(true);
  const labels = Array.from(overview?.querySelectorAll("dt") ?? [], (item) => item.textContent);
  expect(labels).toEqual(["来自", "使用模型", "运行位置", "开始于"]);
  expect(overview?.querySelector("code")?.textContent).toContain("pi-agent/sessions/voice/s1");
  expect(overview?.querySelector(".pa-next b")?.textContent).toBe("你暂时不用做什么");
  view.destroy();
  root.remove();
});

test("能力面板展示提示词、Skills、Tools 与 MCP，展开全文可切换", () => {
  const value = snapshot();
  value.sessions = [{
    ...session("s1"),
    systemPrompt: "你是摘要 Agent。只总结输入记录。",
    skills: [{ id: "daily-summary", title: "输入摘要", digest: "sha256:990c…a11e" }],
    tools: ["voice_history", "app_environment"],
    mcp: [],
  }];
  const { root, view } = mountedWith(value);
  expect(root.textContent).toContain("它被要求怎么做");
  expect(root.textContent).toContain("System prompt");
  expect(root.textContent).toContain("你是摘要 Agent。只总结输入记录。");
  expect(root.textContent).toContain("输入摘要");
  expect(root.textContent).toContain("sha256:990c…a11e");
  expect(root.textContent).toContain("voice_history");
  expect(root.textContent).toContain("app_environment");
  expect(root.textContent).not.toContain("无已授权工具");
  expect(root.textContent).toContain("未连接");
  expect(root.textContent).toContain("App 内置 Pi · 不读取 ~/.pi");

  // 设计稿交互：tab 只翻面板可见性；「展开全文」变「收起」。
  root.querySelector<HTMLButtonElement>('[data-tab="config"]')?.click();
  expect(root.querySelector('[data-pa-panel="config"]')?.classList.contains("active")).toBe(true);
  expect(root.querySelector('[data-pa-panel="overview"]')?.classList.contains("active")).toBe(false);
  expect(root.querySelector<HTMLButtonElement>('[data-tab="config"]')?.classList.contains("active")).toBe(true);
  const toggle = root.querySelector<HTMLButtonElement>("#paPromptToggle")!;
  toggle.click();
  expect(toggle.textContent).toBe("收起");
  expect(root.querySelector("#paPrompt")?.classList.contains("open")).toBe(true);
  toggle.click();
  expect(toggle.textContent).toBe("展开全文");
  view.destroy();
  root.remove();
});

test("记录页时间线与脚注按设计稿逐字输出", () => {
  const value = snapshot();
  value.turns = [
    { key: "a", appId: "com.reai.voice", logicalSessionId: "s1", state: "queued" as const, summary: "下一问", startedMs: Date.now(), temporary: false },
  ];
  const { root, view } = mountedWith(value);
  root.querySelector<HTMLButtonElement>('[data-tab="activity"]')?.click();
  expect(root.querySelector('[data-pa-panel="activity"] .pa-card-h small')?.textContent).toBe("2 条");
  expect(root.textContent).toContain("会话创建");
  expect(root.textContent).toContain("这里只记录发生了什么，不展示模型思维链。");
  view.destroy();
  root.remove();
});

test("搜索过滤会话并把计数写成 显示数/总数", () => {
  const { root, view } = mountedWith(snapshot());
  const search = root.querySelector<HTMLInputElement>(".pa-search input")!;
  expect(root.querySelector(".pa-count")?.textContent).toBe("2/2");
  search.value = "s2";
  search.dispatchEvent(new Event("input"));
  expect(root.querySelector(".pa-count")?.textContent).toBe("1/2");
  expect(root.querySelector('[data-session="s2"]')).toBeTruthy();
  expect(root.querySelector('[data-session="s1"]')).toBeNull();
  search.value = "不存在";
  search.dispatchEvent(new Event("input"));
  expect(root.textContent).toContain("没有匹配的会话");
  expect(root.textContent).toContain("换个关键词试试");
  view.destroy();
  root.remove();
});

test("设置页版式、外脑 chip、模型目录与保存载荷都符合合同", async () => {
  const { root, view, saved } = mountedWith(snapshot(), fullModels);
  view.showSettings();
  expect(root.querySelector(".voice-settings-intro-title")?.textContent).toBe("Pi Agent 设置");
  expect(root.querySelector(".voice-settings-intro-sub")?.textContent).toBe("决定新会话使用哪个模型");
  expect(root.querySelector(".vs-chip.ok")?.textContent).toBe("已登录外脑 · 3 个模型档位");
  expect(root.textContent).toContain("默认模型");
  expect(root.textContent).toContain("插件例外");
  const quality = root.querySelector<HTMLOptionElement>('option[value="text-quality"]');
  expect(quality?.disabled).toBe(true);
  // 插件例外行：应用名 + appId + 实际生效模型（跟随默认的推导显示）。
  const routes = Array.from(root.querySelectorAll(".pas-route-name"), (item) => item.textContent);
  expect(routes).toEqual(["设备诊断", "Voice"]);
  expect(root.querySelector(".pas-route-sub")?.textContent).toContain("com.reai.device-doctor");
  expect(root.querySelector(".pas-route-sub")?.textContent).toContain("实际：通用文本");

  root.querySelector<HTMLSelectElement>("[data-default]")!.value = "text-fast";
  root.querySelector<HTMLSelectElement>("[data-default]")!.dispatchEvent(new Event("change"));
  root.querySelector<HTMLSelectElement>('[data-app="com.reai.voice"]')!.value = "inherit";
  root.querySelector<HTMLSelectElement>('[data-app="com.reai.voice"]')!.dispatchEvent(new Event("change"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(saved.length).toBeGreaterThanOrEqual(2);
  expect(saved.at(-1)).toEqual({ defaultModel: "text-fast", appOverrides: {} });
  view.destroy();
  root.remove();
});

test("未登录外脑时设置页转警告 chip 并禁用全部选择器", () => {
  const { root, view } = mountedWith(snapshot(), { ...fullModels, loggedIn: false });
  view.showSettings();
  expect(root.querySelector(".vs-chip.warn")?.textContent).toBe("未登录外脑");
  for (const select of Array.from(root.querySelectorAll<HTMLSelectElement>("select.pas-select"))) {
    expect(select.disabled).toBe(true);
  }
  expect(root.textContent).toContain("登录后可修改。当前仍显示已经保存的模型设置。");
  setLocale("en"); view.refreshLocale();
  expect(root.textContent).toContain("Sign in to change models. Saved settings are still shown.");
  for (const select of Array.from(root.querySelectorAll<HTMLSelectElement>("select.pas-select"))) {
    expect(select.disabled).toBe(true);
  }
  view.destroy();
  root.remove();
});

test("locale changes keep search input, focus, scroll and business data", () => {
  setLocale("en");
  const data = snapshot();
  data.sessions[0]!.title = "用户写的会话标题";
  data.sessions[0]!.temporary = true;
  const { root, view, saved } = mountedWith(data);
  expect(root.querySelector(".pa-scope")?.textContent).toContain("Scope: Agents inside this app");
  expect(root.querySelector(".pa-isolation")?.textContent).toBe("Does not read separately installed Pi or DSH");
  expect(root.querySelector('[data-session="s1"] .pa-session-meta')?.textContent).toContain("Temporary session");
  expect(root.textContent).toContain(t("ui.m036"));
  expect(root.textContent).toContain("用户写的会话标题");
  const search = root.querySelector<HTMLInputElement>("#paSearch")!;
  const list = root.querySelector<HTMLElement>(".pa-list")!;
  search.value = "用户";
  search.dispatchEvent(new Event("input", { bubbles: true }));
  search.focus(); search.setSelectionRange(1, 2); list.scrollTop = 37;
  const englishPlaceholder = search.placeholder;
  setLocale("zh"); view.refreshLocale();
  expect(root.querySelector("#paSearch")).toBe(search);
  expect(document.activeElement).toBe(search);
  expect(search.value).toBe("用户");
  expect([search.selectionStart, search.selectionEnd]).toEqual([1, 2]);
  expect(search.placeholder).not.toBe(englishPlaceholder);
  expect(list.scrollTop).toBe(37);
  expect(root.textContent).toContain("用户写的会话标题");
  expect(root.textContent).toContain(t("ui.m036"));
  expect(root.querySelector(".pa-scope")?.textContent).toContain("范围：App 内 Agent");
  expect(root.querySelector(".pa-isolation")?.textContent).toBe("不读取电脑独立安装的 Pi 或 DSH");
  expect(root.querySelector('[data-session="s1"] .pa-session-meta')?.textContent).toContain("临时会话");
  expect(saved).toEqual([]);
  setLocale("en"); view.refreshLocale();
  expect(search.placeholder).toBe(englishPlaceholder);
  view.destroy(); root.remove();
});

test("locale changes retain pending model choice and do not save it", () => {
  const { root, view, saved } = mountedWith(snapshot(), {
    ...models,
    models: [
      { id: "text-default", label: "用户模型名", selectable: true, verified: true },
      { id: "text-quality", label: "Quality", selectable: true, verified: true },
    ] as PiManagementModel[],
  });
  view.showSettings();
  const select = root.querySelector<HTMLSelectElement>("[data-default]")!;
  select.value = "text-quality"; select.focus();
  setLocale("en"); view.refreshLocale();
  expect(root.querySelector("[data-default]")).toBe(select);
  expect(select.value).toBe("text-quality");
  expect(document.activeElement).toBe(select);
  expect(root.textContent).toContain("用户模型名");
  expect(root.textContent).toContain("Changes apply only to new sessions.");
  expect(root.querySelector(".vs-chip.ok")?.textContent).toBe("Signed in to Wainao · Model tiers: 2");
  expect(saved).toEqual([]);
  view.destroy(); root.remove();
});
