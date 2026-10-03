import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { readFileSync } from "node:fs";
import type {
  DshObserverHistoryPage,
  DshObserverSessionDetail,
  DshObserverSettings,
  DshObserverSnapshot,
} from "@reai/app-sdk/v1";
import { mountDshObserverView } from "../src/dsh-observer-view";

import { setLocale, t } from "../src/i18n";
afterEach(() => setLocale("zh"));

let ownsDom = false;
beforeAll(() => {
  if (typeof document === "undefined") {
    GlobalRegistrator.register();
    ownsDom = true;
  }
});
afterAll(() => { if (ownsDom) GlobalRegistrator.unregister(); });

const snapshot = (): DshObserverSnapshot => ({
  schemaVersion: 1,
  revision: 2,
  runtime: {
    state: "available",
    code: "ready",
    detail: "App 内置 DSH 正常运行",
    target: "aarch64-apple-darwin",
    dshVersion: "1.0.0",
    profileVersion: "p1",
    workspace: "/App Support/reai-vibe-board/dsh/workspace",
    components: [
      { id: "@deepseek-ai/dsh-base", version: "1.0.0", digest: "sha256:base" },
      { id: "@reai/dsh-host-bridge", version: "1.0.0", digest: "sha256:bridge" },
    ],
  },
  sessions: [{
    sessionId: "s1",
    agentSessionId: "a1",
    source: { appId: "com.reai.voice", name: "Voice", iconDataUrl: null, installed: true, openable: true, unavailableReason: null },
    title: "整理今天的语音记录",
    status: "stale",
    currentTask: "提取今天的要点",
    outcome: { kind: "completed", status: "completed", summary: "回合已完成", error: null },
    nextAction: { kind: "return_to_source", label: "回到来源 App", enabled: true, reason: null },
    updatedMs: 1_700_000_000_000,
    createdMs: 1_699_999_999_000,
    startedMs: 1_699_999_999_500,
    durationMs: 500,
    stale: true,
    orphan: false,
    turnCount: 1,
    workspace: "/App Support/reai-vibe-board/dsh/workspace",
    modelAlias: "text-default",
    currentTurnId: null,
    configurationKnown: true,
  }],
});

const detail: DshObserverSessionDetail = {
  schemaVersion: 1,
  revision: 2,
  sessionRevision: 2,
  sessionId: "s1",
  agentSessionId: "a1",
  source: snapshot().sessions[0]!.source,
  modelAlias: "text-default",
  configurationKnown: true,
  systemPromptConfigured: true,
  systemPromptDigest: "sha256:redacted",
  systemPromptChars: 42,
  skills: [{ id: "daily-summary", title: "当日总结", digest: "sha256:skill" }],
  tools: [{ id: "read_context", source: "host", permission: "read_only", available: true, reason: null }],
  currentTask: null,
  historyTruncated: false,
  diagnostics: { sessionId: "s1", agentSessionId: "a1", currentTurnId: null, workspace: "/App Support/reai-vibe-board/dsh/workspace", profileVersion: "p1", dshVersion: "1.0.0" },
};

const history: DshObserverHistoryPage = {
  schemaVersion: 1,
  revision: 2,
  sessionRevision: 2,
  sessionId: "s1",
  items: [
    { kind: "user_message", text: "请整理今天的语音记录", source: "user", seq: 1, time_ms: 1 },
    { kind: "user_message", text: "来源 App 注入的只读上下文", source: "host", seq: 2, time_ms: 2 },
    { kind: "tool_call", call_id: "c1", name: "read_context", arguments: "{\"day\":\"today\"}", status: "completed", turn: 1, step: 1, seq: 3, time_ms: 3 },
    { kind: "tool_result", call_id: "c1", content: "[REDACTED]", status: "completed", error: null, turn: 1, step: 1, seq: 4, time_ms: 4 },
    { kind: "assistant_message", text: "已整理完成", seq: 5, time_ms: 5 },
  ],
  cursor: null,
  nextCursor: null,
  historyTruncated: false,
};

const observerSettings: DshObserverSettings = {
  selectedModel: "text-default",
  options: [
    { id: "text-default", label: "通用文本", availability: "available", reason: null },
    { id: "text-quality", label: "高质量文本", availability: "available", reason: null },
  ],
};

const settingsActions = {
  settings: async () => observerSettings,
  updateSettings: async (modelAlias: string) => ({ ...observerSettings, selectedModel: modelAlias }),
  onNavigate: () => undefined,
};

test("透明度主页使用紧凑头部且正文不重复标题栏刷新", () => {
  const root = document.createElement("div");
  document.body.append(root);
  const view = mountDshObserverView(root, snapshot(), {
    ...settingsActions,
    refresh: async () => undefined,
    sessionDetail: async () => detail,
    historyPage: async () => history,
  });
  expect(root.querySelector(".dsho-sidebar > header h2")?.textContent).toBe("真实会话");
  expect([...root.querySelectorAll("h2")].map((node) => node.textContent)).not.toContain("DSH");
  expect(root.textContent).not.toContain("只读透明度界面");
  expect(root.textContent).toContain("DSH 是 Host 受管基础服务");
  expect(root.textContent).toContain("整理今天的语音记录");
  expect(root.textContent).toContain("配置已过期");
  expect(root.querySelector('[data-session="s1"] .stale')?.textContent).toBe("配置已过期");
  expect(root.querySelector(".dsho-primary p")?.textContent).toBe("状态：配置已过期");
  for (const label of ["进度", "来源", "工作目录", "概览", "对话", "能力"]) {
    expect(root.textContent).toContain(label);
  }
  expect(root.querySelector("[data-default-model]")).toBeNull();
  expect(root.querySelector("[data-refresh]")).toBeNull();
  view.destroy();
  expect(root.innerHTML).toBe("");
  root.remove();
});

test("顶部边框只声明在 DSH 插件自己的 main-body", () => {
  const css = readFileSync(new URL("../src/dsh-observer.css", import.meta.url), "utf8");
  expect(css).toContain(".dsho-layout.main-body");
  expect(css).toContain("border-top: 1px solid var(--divider, rgba(92, 92, 224, .08))");
  expect(css).not.toMatch(/(^|\n)\.main-body\s*\{/);
  expect(css).not.toMatch(/(^|\n)\.plugin-main-frame\s*\{[^}]*border-top/s);
});

test("根框架只消费一次 Host 标题栏安全线", () => {
  const css = readFileSync(new URL("../src/dsh-observer.css", import.meta.url), "utf8");
  expect(css).toMatch(
    /\.plugin-main-frame\s*\{[^}]*padding-top:\s*var\(--reai-plugin-titlebar-safe-top,\s*44px\)/,
  );
  const occurrences = css.match(/--reai-plugin-titlebar-safe-top/g) ?? [];
  expect(occurrences.length).toBe(1);
});

test("设置页只修改新会话默认模型并只读展示 runtime 组件", async () => {
  const root = document.createElement("div");
  document.body.append(root);
  const saved: string[] = [];
  const pages: string[] = [];
  const view = mountDshObserverView(root, snapshot(), {
    ...settingsActions,
    refresh: async () => undefined,
    sessionDetail: async () => detail,
    historyPage: async () => history,
    updateSettings: async (modelAlias) => {
      saved.push(modelAlias);
      return { ...observerSettings, selectedModel: modelAlias };
    },
    onNavigate: (page) => { pages.push(page); },
  });

  await view.showSettings();
  expect(root.textContent).toContain("DSH 设置");
  expect(root.textContent).toContain("仅影响之后创建的新会话");
  expect(root.textContent).toContain("@deepseek-ai/dsh-base");
  expect(root.textContent).toContain("@reai/dsh-host-bridge");
  for (const forbidden of ["安装组件", "停用组件", "卸载组件", "升级组件"]) {
    expect(root.textContent).not.toContain(forbidden);
  }
  const select = root.querySelector<HTMLSelectElement>("[data-default-model]")!;
  select.value = "text-quality";
  select.dispatchEvent(new Event("change", { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(saved).toEqual(["text-quality"]);
  expect(root.textContent).toContain("新设置会从下一个会话开始生效");
  view.navigateRoot();
  expect(root.textContent).toContain("真实会话");
  expect(pages).toEqual(["settings", "main"]);
  view.destroy();
  root.remove();
});

test("对话与能力只读取脱敏分页数据，不提供设置或危险操作", async () => {
  const root = document.createElement("div");
  document.body.append(root);
  const calls: string[] = [];
  const view = mountDshObserverView(root, snapshot(), {
    ...settingsActions,
    refresh: async () => { calls.push("refresh"); },
    sessionDetail: async () => { calls.push("detail"); return detail; },
    historyPage: async () => { calls.push("history"); return history; },
  });
  root.querySelector<HTMLButtonElement>('[data-tab="conversation"]')?.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(root.textContent).toContain("read_context");
  expect(root.textContent).toContain("[REDACTED]");
  expect(root.textContent).toContain("用户");
  expect(root.textContent).toContain("系统上下文 · host");
  root.querySelector<HTMLButtonElement>('[data-tab="capabilities"]')?.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(root.textContent).toContain("完整内容不下发 WebView");
  expect(root.textContent).toContain("当日总结");
  expect(root.textContent).not.toContain("清空全部会话");
  expect(root.textContent).not.toContain("默认模型");
  expect(calls).toEqual(["history", "detail"]);
  view.destroy();
  root.remove();
});

test("相同 revision 的轮询不会重建 DOM 或打断滚动和焦点", () => {
  const root = document.createElement("div");
  document.body.append(root);
  const view = mountDshObserverView(root, snapshot(), {
    ...settingsActions,
    refresh: async () => undefined,
    sessionDetail: async () => detail,
    historyPage: async () => history,
  });
  const mainBefore = root.querySelector<HTMLElement>(".dsho-main")!;
  const selectedBefore = root.querySelector<HTMLButtonElement>('[data-session="s1"]')!;
  mainBefore.scrollTop = 137;
  selectedBefore.focus();

  view.update(snapshot());

  expect(root.querySelector(".dsho-main")).toBe(mainBefore);
  expect(mainBefore.scrollTop).toBe(137);
  expect(document.activeElement).toBe(selectedBefore);
  view.destroy();
  root.remove();
});

test("revision 变化时刷新内容但保留滚动位置和可对应的焦点", () => {
  const root = document.createElement("div");
  document.body.append(root);
  const view = mountDshObserverView(root, snapshot(), {
    ...settingsActions,
    refresh: async () => undefined,
    sessionDetail: async () => detail,
    historyPage: async () => history,
  });
  const mainBefore = root.querySelector<HTMLElement>(".dsho-main")!;
  const selectedBefore = root.querySelector<HTMLButtonElement>('[data-session="s1"]')!;
  mainBefore.scrollTop = 91;
  selectedBefore.focus();
  const changed = snapshot();
  changed.revision = 3;
  changed.sessions[0]!.title = "新的真实任务标题";

  view.update(changed);

  const mainAfter = root.querySelector<HTMLElement>(".dsho-main")!;
  const selectedAfter = root.querySelector<HTMLButtonElement>('[data-session="s1"]')!;
  expect(mainAfter).not.toBe(mainBefore);
  expect(mainAfter.scrollTop).toBe(91);
  expect(document.activeElement).toBe(selectedAfter);
  expect(root.textContent).toContain("新的真实任务标题");
  view.destroy();
  root.remove();
});

test("revision 相同但来源 App 状态变化时仍刷新跨域事实", () => {
  const root = document.createElement("div");
  document.body.append(root);
  const view = mountDshObserverView(root, snapshot(), {
    ...settingsActions,
    refresh: async () => undefined,
    sessionDetail: async () => detail,
    historyPage: async () => history,
  });
  const changed = snapshot();
  changed.sessions[0]!.source.installed = false;
  changed.sessions[0]!.source.openable = false;
  changed.sessions[0]!.source.unavailableReason = "来源 App 已卸载";
  changed.sessions[0]!.source.name = "com.reai.voice";

  view.update(changed);

  expect(root.textContent).toContain("com.reai.voice");
  expect(root.textContent).not.toContain("Voice · 1 回合");
  view.destroy();
  root.remove();
});

test("系统上下文来源标签按不可信文本转义", async () => {
  const root = document.createElement("div");
  document.body.append(root);
  const unsafeHistory: DshObserverHistoryPage = {
    ...history,
    items: [{
      kind: "user_message",
      text: "安全正文",
      source: '<img src=x onerror="globalThis.pwned=true">',
      seq: 1,
      time_ms: 1,
    }],
  };
  const view = mountDshObserverView(root, snapshot(), {
    ...settingsActions,
    refresh: async () => undefined,
    sessionDetail: async () => detail,
    historyPage: async () => unsafeHistory,
  });
  root.querySelector<HTMLButtonElement>('[data-tab="conversation"]')?.click();
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(root.querySelector("img")).toBeNull();
  expect(root.textContent).toContain('系统上下文 · <img src=x onerror="globalThis.pwned=true">');
  view.destroy();
  root.remove();
});

test("locale changes preserve conversation, focus, scroll and event listeners", async () => {
  const root = document.createElement("div"); document.body.append(root);
  const calls: string[] = [];
  const view = mountDshObserverView(root, snapshot(), {
    ...settingsActions,
    refresh: async () => { calls.push("refresh"); },
    sessionDetail: async () => { calls.push("detail"); return detail; },
    historyPage: async () => { calls.push("history"); return history; },
  });
  root.querySelector<HTMLButtonElement>('[data-tab="conversation"]')!.click();
  await new Promise(resolve => setTimeout(resolve, 0));
  const button = root.querySelector<HTMLButtonElement>('[data-tab="conversation"]')!;
  const main = root.querySelector<HTMLElement>(".dsho-main")!;
  button.focus(); main.scrollTop = 41;
  const before = [...calls];
  setLocale("en"); view.refreshLocale();
  expect(root.querySelector('[data-tab="conversation"]')).toBe(button);
  expect(document.activeElement).toBe(button);
  expect(main.scrollTop).toBe(41);
  expect(root.textContent).toContain("请整理今天的语音记录");
  expect(root.textContent).toContain("来源 App 注入的只读上下文");
  expect(root.textContent).toContain("[REDACTED]");
  expect(root.textContent).toContain(t("ui.m014"));
  expect(root.textContent).not.toContain("配置已过期");
  expect(root.querySelector('[data-session="s1"] .stale')?.textContent).toBe("Configuration expired");
  expect(calls).toEqual(before);
  root.querySelector<HTMLButtonElement>('[data-tab="overview"]')!.click();
  expect(root.querySelector('[data-tab="overview"]')!.classList.contains("active")).toBe(true);
  expect(root.querySelector(".dsho-primary p")?.textContent).toBe("Status: Configuration expired");
  view.destroy(); root.remove();
});

test("locale changes preserve model choice without updateSettings", async () => {
  const root = document.createElement("div"); document.body.append(root);
  const saved: string[] = [];
  const view = mountDshObserverView(root, snapshot(), {
    ...settingsActions, refresh: async () => undefined,
    sessionDetail: async () => detail, historyPage: async () => history,
    updateSettings: async value => { saved.push(value); return observerSettings; },
  });
  await view.showSettings();
  const select = root.querySelector<HTMLSelectElement>("[data-default-model]")!;
  select.value = "text-quality"; select.focus();
  setLocale("en"); view.refreshLocale();
  expect(root.querySelector("[data-default-model]")).toBe(select);
  expect(document.activeElement).toBe(select);
  expect(select.value).toBe("text-quality");
  expect(root.textContent).toContain("通用文本");
  expect(saved).toEqual([]);
  view.destroy(); root.remove();
});
