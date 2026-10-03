/**
 * 浏览器主页视图：快捷方式 + 当前标签一览 + 打开抽屉。
 *
 * 纯 DOM（与 todo-view 同款形态）；样式在 browser.css，用宿主注入的主题 token。
 * `browser.state` 只在挂载与手动刷新时拉取——标签变化的高频同步是 Host 抽屉
 * 的事，插件主页不做实时镜像。
 *
 * 语言切换走 `applyBrowserHomeLocale`：只更新现有节点的文字与属性，不重建
 * DOM，焦点/滚动原样保留；真实网页标题、URL 与品牌名始终原样显示。
 */

import { t } from "./browser-i18n";

export interface BrowserHomeHandlers {
  onOpenDrawer: () => void;
  onNewTab: (url?: string) => void;
  onRefresh: () => void;
  onSelectTab: (tabId: number) => void;
  onCloseTab: (tabId: number) => void;
}

export interface BrowserTabSummary {
  tabId: number;
  url: string;
  title: string;
  loading: boolean;
  openedByAgent: boolean;
}

export interface BrowserStateSummary {
  tabs: BrowserTabSummary[];
  activeTabId: number | null;
  agentTabId: number | null;
}

// 品牌名不翻译；快捷入口的 URL 是原始数据。
const QUICK_LINKS: Array<{ label: string; url: string }> = [
  { label: "Bing", url: "https://www.bing.com" },
  { label: "GitHub", url: "https://github.com" },
  { label: "知乎", url: "https://www.zhihu.com" },
  { label: "MDN", url: "https://developer.mozilla.org" },
];

export interface BrowserHome {
  root: HTMLElement;
  listEl: HTMLElement;
  statusEl: HTMLElement;
  handlers: BrowserHomeHandlers;
  introEl: HTMLElement;
  openBtn: HTMLButtonElement;
  newTabBtn: HTMLButtonElement;
  linksTitleEl: HTMLElement;
  tabsTitleEl: HTMLElement;
  refreshBtn: HTMLButtonElement;
  /** 最近一次引擎事实；语言切换时据此原位重画文字，不重新请求。 */
  state: BrowserStateSummary | null;
  errorDetail: string | undefined;
}

/** 标签行标题：真实标题/URL 优先，两者皆空才用带 tabId 的占位译文。 */
function tabLabelText(label: HTMLElement): string {
  const title = label.dataset.rbTitle ?? "";
  const url = label.dataset.rbUrl ?? "";
  const tabId = Number(label.dataset.rbTabId);
  return title || url || t("tabs.titleFallback", { tabId });
}

function applyRowTexts(row: HTMLElement): void {
  const label = row.querySelector<HTMLElement>(".rb-tab-title");
  if (label) {
    const value = tabLabelText(label);
    if (label.textContent !== value) label.textContent = value;
  }
  const work = row.querySelector<HTMLElement>(".rb-tab-badge.work");
  if (work) {
    const value = t("tabs.workBadge");
    if (work.textContent !== value) work.textContent = value;
  }
  const close = row.querySelector<HTMLElement>(".rb-tab-close");
  if (close) {
    const value = t("tabs.close");
    if (close.getAttribute("title") !== value) {
      close.setAttribute("title", value);
      close.setAttribute("aria-label", value);
    }
  }
}

function applyStatusText(home: BrowserHome): void {
  let value: string;
  if (home.errorDetail !== undefined) {
    value = t("status.loadFailed", { detail: home.errorDetail });
    home.statusEl.classList.add("error");
  } else if (!home.state || home.state.tabs.length === 0) {
    value = t("tabs.empty");
    home.statusEl.classList.remove("error");
  } else {
    value = "";
    home.statusEl.classList.remove("error");
  }
  if (home.statusEl.textContent !== value) home.statusEl.textContent = value;
}

export function mountBrowserHome(
  parent: HTMLElement,
  handlers: BrowserHomeHandlers,
): BrowserHome {
  const frame = document.createElement("div");
  frame.className = "plugin-main-frame";
  const root = document.createElement("div");
  root.className = "main-body rb-home";
  frame.appendChild(root);

  const sub = document.createElement("div");
  sub.className = "rb-sub";
  sub.textContent = t("home.intro");

  const actions = document.createElement("div");
  actions.className = "rb-actions";
  const openBtn = document.createElement("button");
  openBtn.className = "rb-btn primary";
  openBtn.type = "button";
  openBtn.textContent = t("home.openBrowser");
  openBtn.addEventListener("click", handlers.onOpenDrawer);
  const newTabBtn = document.createElement("button");
  newTabBtn.className = "rb-btn";
  newTabBtn.type = "button";
  newTabBtn.textContent = t("home.newTab");
  newTabBtn.addEventListener("click", () => handlers.onNewTab());
  actions.append(openBtn, newTabBtn);

  const linksTitle = document.createElement("div");
  linksTitle.className = "rb-sec-t";
  linksTitle.textContent = t("home.quickLinks");
  const links = document.createElement("div");
  links.className = "rb-links";
  for (const link of QUICK_LINKS) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "rb-link";
    chip.textContent = link.label;
    chip.addEventListener("click", () => handlers.onNewTab(link.url));
    links.append(chip);
  }

  const tabsTitle = document.createElement("div");
  tabsTitle.className = "rb-sec-t";
  tabsTitle.textContent = t("home.currentTabs");
  const listEl = document.createElement("div");
  listEl.className = "rb-tabs";
  const statusEl = document.createElement("div");
  statusEl.className = "rb-status";

  const refresh = document.createElement("button");
  refresh.type = "button";
  refresh.className = "rb-refresh";
  refresh.textContent = t("home.refresh");
  refresh.addEventListener("click", handlers.onRefresh);
  tabsTitle.append(refresh);

  root.append(sub, actions, linksTitle, links, tabsTitle, listEl, statusEl);
  parent.append(frame);
  return {
    root,
    listEl,
    statusEl,
    handlers,
    introEl: sub,
    openBtn,
    newTabBtn,
    linksTitleEl: linksTitle,
    tabsTitleEl: tabsTitle,
    refreshBtn: refresh,
    state: null,
    errorDetail: undefined,
  };
}

/** 语言切换：只更新文字与属性，保留节点、焦点、滚动与全部业务状态。 */
export function applyBrowserHomeLocale(home: BrowserHome): void {
  const intro = t("home.intro");
  if (home.introEl.textContent !== intro) home.introEl.textContent = intro;
  const open = t("home.openBrowser");
  if (home.openBtn.textContent !== open) home.openBtn.textContent = open;
  const newTab = t("home.newTab");
  if (home.newTabBtn.textContent !== newTab) home.newTabBtn.textContent = newTab;
  const quickLinks = t("home.quickLinks");
  if (home.linksTitleEl.textContent !== quickLinks) {
    home.linksTitleEl.textContent = quickLinks;
  }
  const currentTabs = t("home.currentTabs");
  if (home.tabsTitleEl.firstChild?.textContent !== currentTabs) {
    // 标题容器里还挂着「刷新」按钮，只改标题自己的文字节点，不动按钮。
    if (home.tabsTitleEl.firstChild) home.tabsTitleEl.firstChild.textContent = currentTabs;
  }
  const refresh = t("home.refresh");
  if (home.refreshBtn.textContent !== refresh) {
    home.refreshBtn.textContent = refresh;
  }
  applyStatusText(home);
  for (const row of Array.from(home.listEl.children)) {
    if (row instanceof HTMLElement) applyRowTexts(row);
  }
}

export function refreshBrowserHome(
  home: BrowserHome,
  state: BrowserStateSummary | null,
  errorDetail?: string,
): void {
  home.state = state;
  home.errorDetail = errorDetail;
  home.listEl.replaceChildren();
  applyStatusText(home);
  if (errorDetail !== undefined || !state || state.tabs.length === 0) return;
  for (const tab of state.tabs) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "rb-tab" + (tab.tabId === state.activeTabId ? " active" : "");
    row.addEventListener("click", () => home.handlers.onSelectTab(tab.tabId));
    const label = document.createElement("span");
    label.className = "rb-tab-title";
    // 语言切换要能原位重算占位标题，原始 title/url/tabId 记在节点上。
    label.dataset.rbTitle = tab.title;
    label.dataset.rbUrl = tab.url;
    label.dataset.rbTabId = String(tab.tabId);
    label.textContent = tab.title || tab.url || t("tabs.titleFallback", { tabId: tab.tabId });
    row.append(label);
    if (tab.openedByAgent) {
      const badge = document.createElement("span");
      badge.className = "rb-tab-badge";
      badge.textContent = "Agent";
      row.append(badge);
    }
    if (tab.tabId === state.agentTabId) {
      const badge = document.createElement("span");
      badge.className = "rb-tab-badge work";
      badge.textContent = t("tabs.workBadge");
      row.append(badge);
    }
    const close = document.createElement("span");
    close.className = "rb-tab-close";
    close.setAttribute("title", t("tabs.close"));
    close.setAttribute("aria-label", t("tabs.close"));
    close.textContent = "✕";
    close.addEventListener("click", (event) => {
      event.stopPropagation();
      home.handlers.onCloseTab(tab.tabId);
    });
    row.append(close);
    home.listEl.append(row);
  }
}
