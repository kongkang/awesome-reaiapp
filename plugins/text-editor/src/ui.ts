/**
 * 视图构建层：把设计稿 #app/texteditor 的 DOM 骨架落成函数。
 *
 * 这一层的职责只有「长得对」：结构、类名、逐字文案与 aria 全部对齐
 * design/VoiceType_UI_Designs.html 的 pageTextEditor 段；数据从入参进来，
 * 事件用回调抛出去。不 import 任何引擎（ProseKit/CodeMirror），单测可以直接建。
 */
import { icon } from "./icons";
import type { TeMode } from "./mode";

export type { TeMode };
export type SaveState = "saved" | "unsaved" | "conflict";

function node<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = "",
  text?: string,
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

/* ---------------------------------------------------------------- 文件栏 */

export interface FileRow {
  key: string;
  name: string;
  meta?: string;
  kind: "workspace" | "directory" | "file" | "up";
  active?: boolean;
  changedDot?: boolean;
}

export interface FileSection {
  heading?: string;
  rows: FileRow[];
}

/** 一行文件的图标：目录树里只分「文本文档 / 其他源码文件」两态，沿用设计稿口径。 */
const rowIconName = (row: FileRow): string => {
  if (row.kind === "up") return "corner-left-up";
  if (row.kind === "directory") return "folder";
  if (row.kind === "workspace") return "folder";
  return /\.(md|mdx|markdown|txt)$/i.test(row.key) ? "file-text" : "code";
};

function rowIcon(row: FileRow): HTMLElement {
  const tile = node("span", "te-file-ic");
  tile.append(icon(rowIconName(row), 12));
  return tile;
}

export function buildFileSections(
  sections: FileSection[],
  emptyText: string,
): DocumentFragment {
  const fragment = document.createDocumentFragment();
  const flattened = sections.flatMap((section) => section.rows);
  // 设计稿：搜索没有任何命中时，列表区给一句「没有找到文件」。
  if (flattened.length === 0) {
    fragment.append(node("div", "te-empty", emptyText));
    return fragment;
  }
  for (const section of sections) {
    if (section.heading && section.rows.length > 0) {
      fragment.append(node("div", "te-file-group", section.heading));
    }
    for (const row of section.rows) {
      const button = node("button", `te-file${row.active ? " active" : ""}`);
      button.type = "button";
      button.dataset.teFile = row.key;
      button.dataset.kind = row.kind;
      button.title = row.name;
      button.append(rowIcon(row));
      const body = node("span", "te-file-b");
      body.append(node("span", "te-file-n", row.name));
      if (row.meta) body.append(node("span", "te-file-m", row.meta));
      button.append(body);
      if (row.changedDot) button.append(node("span", "te-file-dot"));
      fragment.append(button);
    }
  }
  return fragment;
}

/* ---------------------------------------------------------------- 整体壳 */

export interface ShellRefs {
  page: HTMLElement;
  openButton: HTMLButtonElement;
  searchInput: HTMLInputElement;
  fileListHost: HTMLElement;
  titleEl: HTMLElement;
  pathEl: HTMLElement;
  pathTextEl: HTMLElement;
  saveChipEl: HTMLElement;
  saveChipTextEl: HTMLElement;
  modesHost: HTMLElement;
  toolbarHost: HTMLElement;
  stageDocument: HTMLElement;
  paperWrap: HTMLElement;
  stageSource: HTMLElement;
  sourceHost: HTMLElement;
  stageDiff: HTMLElement;
  /** .te-diff 容器：变更模式时由 main 填入卡片头与 MergeView。 */
  diffWrap: HTMLElement;
  statusEl: HTMLElement;
  toastEl: HTMLElement;
}

/**
 * pageTextEditor 的静态骨架。一次 mount 建一次；
 * 引擎挂进 refs 的对应宿主，其余节点按数据原地刷新。
 */
export function buildShell(handlers: {
  onOpen: () => void;
  onSearchInput: (query: string) => void;
}): ShellRefs {
  const page = node("section", "te-page");

  const files = node("aside", "te-files");
  const filesHead = node("div", "te-files-head");
  const filesTitle = node("div", "te-files-title");
  filesTitle.append(icon("file-text", 15), node("span", "", "文件"));
  const openButton = node("button", "te-open") as HTMLButtonElement;
  openButton.type = "button";
  openButton.title = "打开文件";
  openButton.setAttribute("aria-label", "打开文件");
  openButton.append(icon("plus", 14));
  openButton.addEventListener("click", handlers.onOpen);
  filesTitle.append(openButton);
  const searchLabel = node("label", "te-search");
  searchLabel.htmlFor = "te-search";
  searchLabel.append(icon("search", 12));
  const searchInput = document.createElement("input");
  searchInput.id = "te-search";
  searchInput.placeholder = "搜索文件…";
  searchInput.autocomplete = "off";
  searchInput.addEventListener("input", () => handlers.onSearchInput(searchInput.value));
  searchLabel.append(searchInput);
  filesHead.append(filesTitle, searchLabel);
  const fileListHost = node("div", "te-file-scroll");
  files.append(filesHead, fileListHost);

  const main = node("main", "te-main");
  const head = node("header", "te-head");
  const headCopy = node("div", "te-head-copy");
  const titleEl = node("div", "te-file-title");
  const pathEl = node("div", "te-file-path");
  const pathTextEl = node("span", "te-file-path-value");
  const saveChipEl = node("span", "te-save-state");
  const saveChipTextEl = node("span", "te-save-state-label");
  saveChipEl.append(node("i"), saveChipTextEl);
  pathEl.append(pathTextEl, saveChipEl);
  headCopy.append(titleEl, pathEl);
  const modesHost = node("div", "te-modes");
  modesHost.id = "te-modes";
  modesHost.setAttribute("role", "tablist");
  modesHost.setAttribute("aria-label", "文件视图");
  head.append(headCopy, modesHost);

  const toolbarHost = node("div", "te-toolbar");

  const stage = node("div", "te-stage");
  const stageDocument = node("section", "te-view");
  stageDocument.id = "te-document-view";
  const paperWrap = node("div", "te-doc-wrap");
  stageDocument.append(paperWrap);
  const stageSource = node("section", "te-view hidden");
  stageSource.id = "te-source-view";
  const sourceHost = node("div", "te-source");
  stageSource.append(sourceHost);
  const stageDiff = node("section", "te-view hidden");
  stageDiff.id = "te-diff-view";
  const diffWrap = node("div", "te-diff");
  stageDiff.append(diffWrap);
  stage.append(stageDocument, stageSource, stageDiff);

  const statusEl = node("footer", "te-status");
  main.append(head, toolbarHost, stage, statusEl);

  const toastEl = node("div", "te-toast");
  page.append(files, main, toastEl);
  return {
    page,
    openButton,
    searchInput,
    fileListHost,
    titleEl,
    pathEl,
    pathTextEl,
    saveChipEl,
    saveChipTextEl,
    modesHost,
    toolbarHost,
    stageDocument,
    paperWrap,
    stageSource,
    sourceHost,
    stageDiff,
    diffWrap,
    statusEl,
    toastEl,
  };
}

/* ------------------------------------------------------------ 头部与模式 tab */

export function setDocumentHeading(
  refs: ShellRefs,
  doc: { name: string; path: string } | undefined,
): void {
  refs.titleEl.textContent = doc?.name ?? "";
  refs.pathTextEl.textContent = doc?.path ?? "";
  if (!doc) refs.saveChipTextEl.textContent = "";
  refs.saveChipEl.classList.toggle("hidden", !doc);
  refs.saveChipEl.hidden = !doc;
}

/** 保存状态徽标：路径行尾的小圆点 + 已保存 / 尚未保存（设计稿逐字）。 */
export function setSaveChip(refs: ShellRefs, state: SaveState): void {
  refs.saveChipEl.classList.toggle("unsaved", state !== "saved");
  refs.saveChipEl.classList.toggle("conflict", state === "conflict");
  refs.saveChipTextEl.textContent =
    state === "conflict" ? "外部已修改" : state === "saved" ? "已保存" : "尚未保存";
}

export interface ModeTabSpec {
  mode: TeMode;
  label: string;
  disabled: boolean;
  /** 「变更」tab 的计数徽标；null 表示不显示徽标。 */
  badge: number | null;
}

/**
 * te-modes 分段 tab：文档 / 源码 / 变更 N。
 * 回调收到的是 mode 名，选择与否由这里的 active/aria-selected 落实。
 */
export function buildModeTabs(
  specs: ModeTabSpec[],
  current: TeMode,
  onSelect: (mode: TeMode) => void,
): HTMLDivElement {
  const host = node("div", "te-modes");
  host.setAttribute("role", "tablist");
  host.setAttribute("aria-label", "文件视图");
  for (const spec of specs) {
    const button = node("button", `te-mode${spec.mode === current ? " active" : ""}`) as HTMLButtonElement;
    button.type = "button";
    button.dataset.teMode = spec.mode;
    button.setAttribute("role", "tab");
    button.textContent = spec.label;
    if (spec.badge !== null) {
      const badge = node("b", "", String(spec.badge));
      button.append(badge);
    }
    button.disabled = spec.disabled;
    button.setAttribute("aria-selected", String(spec.mode === current));
    button.addEventListener("click", () => onSelect(spec.mode));
    host.append(button);
  }
  return host;
}

/* ---------------------------------------------------------------- 工具条 */

export type ToolName =
  | "撤销"
  | "重做"
  | "标题"
  | "粗体"
  | "斜体"
  | "列表"
  | "引用"
  | "代码"
  | "自动换行"
  | "查找"
  | "上一处"
  | "下一处";

export interface ToolbarSpec {
  mode: TeMode;
  /** source 模式左端的语言标签（Markdown/JSON/…）；diff/document 忽略。 */
  languageLabel: string;
  /** document 左端固定「正文」。 */
  wrapActive: boolean;
  saveLabel: string;
  saveDisabled: boolean;
  /** diff 右端「N 处变更」；null 时显示「无变更」。 */
  changedCount: number | null;
}

export interface BuiltToolbar {
  root: HTMLDivElement;
  saveButton: HTMLButtonElement;
  wrapButton: HTMLButtonElement | undefined;
}

/**
 * buildShell 已经提供唯一的 `.te-toolbar`；这里只移动 buildToolbar 的条目，不能把
 * 另一个同名根节点塞进去，否则 padding/min-height/border 会计算两次。
 */
export function mountToolbar(host: HTMLElement, toolbar: BuiltToolbar): void {
  host.replaceChildren(...Array.from(toolbar.root.childNodes));
}

const toolIconButton = (name: ToolName, iconName: string): HTMLButtonElement => {
  const button = node("button", "te-tool") as HTMLButtonElement;
  button.type = "button";
  button.dataset.teTool = name;
  button.title = name;
  button.append(icon(iconName, 13));
  return button;
};

const toolTextButton = (
  name: ToolName,
  label: string,
  className = "",
): HTMLButtonElement => {
  const button = node("button", `te-tool${className ? ` ${className}` : ""}`) as HTMLButtonElement;
  button.type = "button";
  button.dataset.teTool = name;
  button.textContent = label;
  return button;
};

/**
 * te-toolbar 随模式变化的三种形态，条目与设计稿 renderTeToolbarHTML 一致：
 * - 文档：正文 + 撤销/重做/标题/B/I/列表/引用/代码 + 保存
 * - 源码：语言 + 自动换行(active)/查找 + 保存
 * - 变更：上次保存 → 当前内容 + ↑ 上一处/↓ 下一处 + N 处变更
 */
export function buildToolbar(
  spec: ToolbarSpec,
  handlers: { onTool: (name: ToolName) => void; onSave: () => void },
): BuiltToolbar {
  const root = node("div", "te-toolbar") as HTMLDivElement;
  let wrapButton: HTMLButtonElement | undefined;

  if (spec.mode === "document") {
    root.append(node("span", "te-tool-label", "正文"));
    root.append(toolIconButton("撤销", "rotate-ccw"), toolIconButton("重做", "rotate-cw"));
    root.append(node("span", "te-tool-sep"));
    root.append(toolTextButton("标题", "标题"));
    root.append(toolTextButton("粗体", "B", "strong"));
    root.append(toolTextButton("斜体", "I", "italic"));
    root.append(toolIconButton("列表", "list-todo"));
    root.append(toolTextButton("引用", "“ ”"));
    root.append(toolTextButton("代码", "</>"));
  } else if (spec.mode === "source") {
    root.append(node("span", "te-tool-label", spec.languageLabel));
    wrapButton = toolTextButton("自动换行", "自动换行", spec.wrapActive ? "active" : "");
    root.append(wrapButton);
    const findButton = node("button", "te-tool") as HTMLButtonElement;
    findButton.type = "button";
    findButton.dataset.teTool = "查找";
    findButton.append(icon("search", 12), document.createTextNode(" 查找"));
    root.append(findButton);
  } else {
    root.append(node("span", "te-tool-label", "上次保存 → 当前内容"));
    root.append(toolTextButton("上一处", "↑ 上一处"), toolTextButton("下一处", "↓ 下一处"));
  }

  root.append(node("span", "te-tool-spacer"));

  if (spec.mode === "diff") {
    root.append(
      node("span", "te-tool-label", spec.changedCount === null ? "大量改动" : `${spec.changedCount} 处变更`),
    );
  }

  const saveButton = node("button", "te-save") as HTMLButtonElement;
  saveButton.type = "button";
  saveButton.textContent = spec.saveLabel;
  saveButton.disabled = spec.saveDisabled;
  saveButton.addEventListener("click", handlers.onSave);
  root.append(saveButton);

  root.querySelectorAll<HTMLButtonElement>("[data-te-tool]").forEach((button) => {
    button.addEventListener("click", () => handlers.onTool(button.dataset.teTool as ToolName));
  });
  return { root, saveButton, wrapButton };
}

/* ---------------------------------------------------------------- 状态栏 */

const MODE_STATUS_TEXT: Record<TeMode, string> = {
  document: "文档编辑",
  source: "精确文本",
  diff: "只读比较",
};

/** 设计稿 renderTeStatus：<strong>Markdown</strong><span>18 行</span><span>UTF-8</span><span>LF</span><spacer/><span>文档编辑</span> */
export function fillStatus(
  statusEl: HTMLElement,
  info:
    | { kind: "document"; language: string; lineCount: number; mode: TeMode }
    | { kind: "idle" },
): void {
  statusEl.replaceChildren();
  if (info.kind === "idle") {
    statusEl.append(node("span", "", "文本编辑器"), spacer(), node("span", "", "本地文件工具"));
    return;
  }
  statusEl.append(
    node("strong", "", info.language),
    node("span", "", `${info.lineCount} 行`),
    node("span", "", "UTF-8"),
    node("span", "", "LF"),
    spacer(),
    node("span", "", MODE_STATUS_TEXT[info.mode]),
  );
}

function spacer(): HTMLElement {
  const el = node("span", "te-status-spacer");
  return el;
}

/* ---------------------------------------------------------------- 三视图 */

/** 显隐三视图：非当前视图挂 .hidden（display:none，设计稿同名规则）。 */
export function setModeVisibility(refs: ShellRefs, mode: TeMode): void {
  refs.stageDocument.classList.toggle("hidden", mode !== "document");
  refs.stageSource.classList.toggle("hidden", mode !== "source");
  refs.stageDiff.classList.toggle("hidden", mode !== "diff");
}

/** 变更视图卡片：头部「文件名 · 逐行比较」+ 双栏网格容器（MergeView 的父级）。 */
export function buildDiffCardParts(
  documentName: string,
): { head: HTMLElement; card: HTMLElement } {
  const head = node("div", "te-diff-head");
  head.append(icon("file-text", 12), node("b", "", documentName), node("span", "", "逐行比较"));
  const card = node("div", "te-diff-card");
  return { head, card };
}

/* ---------------------------------------------------------------- 空态与 toast */

/** 未打开任何文件时的主区引导（产品文案沿用既有实现）。 */
export function buildStageEmpty(onOpenRequest: () => void): HTMLElement {
  const empty = node("div", "te-stage-empty");
  const iconTile = node("div", "te-stage-empty-icon");
  iconTile.append(icon("file-text", 22));
  const openHint = node("button", "te-stage-empty-action") as HTMLButtonElement;
  openHint.type = "button";
  openHint.textContent = "打开工作文件夹";
  openHint.addEventListener("click", onOpenRequest);
  empty.append(
    iconTile,
    node("h2", "", "打开一份本地文档"),
    node("p", "", "选择工作文件夹，或从 Codex App 的文件变更中打开。"),
    openHint,
  );
  return empty;
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;

/** 底部胶囊 toast，2.1s 自动收起（离开页面时由 hideToast 立即撤下）。 */
export function showToast(toastEl: HTMLElement, message: string): void {
  toastEl.textContent = message;
  toastEl.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("show"), 2100);
}

export function hideToast(toastEl: HTMLElement): void {
  clearTimeout(toastTimer);
  toastEl.classList.remove("show");
}
