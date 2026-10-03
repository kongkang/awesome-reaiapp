import { t, message, resolveText, setLocale, currentLocale, patchLocalizedContent, type LocalizedText } from "./i18n";
// Codex App 视图层：只认状态与回调，不 import SDK。
// 结构、文案、间距全部对照设计稿 design/VoiceType_UI_Designs.html 的
// pageCodexApp 骨架（三栏 cxa-nav/cxa-center/cxa-inspector、cxaAuth 连接卡
// 与 cxa-toast）与 renderCodexAppSettings 的设置页。
// 视图里不允许自造“可用应用 / Skill / 运行状态”：生产路径必须由 main.ts
// 喂 Host 与官方 codex app-server 的真实快照，测试 fixture 也要显式注明来源。

import "./styles.css";
import { iconSpan } from "./icons";
import type {
  ModelSummary,
  ReasoningEffort,
  UsageSummary,
} from "./capability-state";
import type { CodexTurnMode } from "./turn-mode";
import { TURN_MODES } from "./turn-mode";

/* 文件夹折叠是纯视觉记忆，随视图生命周期即可，不进任何持久层。 */
const collapsedFolders = new Set<string>();

export type TaskStatusClass = "run" | "wait" | "ready" | "done";

export interface TaskRow {
  id: string;
  cwd: string;
  name: LocalizedText;
  updatedAt: number;
  /** 线程原生状态提示（如 idle/active），未知传空串 */
  statusHint: string;
  /** 该线程挂着待处理的审批或补充问题 */
  needsDecision: boolean;
}

export interface FileChange {
  path: string;
  /** 变更摘要，如「新增 · 4 处」；缺省回落「已更新」 */
  label?: string | undefined;
}

export interface MaterialItem {
  icon: "folder" | "globe" | "file-text";
  title: string;
  sub: string;
}

export interface LinkedAppSummary {
  appId: string;
  name: LocalizedText;
  installed: boolean;
  enabled: boolean;
}

export interface SkillSummary {
  name: string;
  displayName: string;
  description: LocalizedText;
  scope: string;
}

export interface RuntimeSummary {
  running: boolean;
  version: string;
  /** 来自 codex.tasks.runtime.status 的便宜快照；缺省视为未知。 */
  installState?: "managed" | "bundled" | "development-override" | "missing" | undefined;
}

/** 对话流卡片：main.ts 把真实 turn 条目映射成这四种。审批/提问卡由视图按待办补齐。 */
export type StreamCard =
  | { kind: "user"; text: string }
  | { kind: "agent"; lead?: string; body: string }
  | { kind: "source"; chips: Array<{ icon: "folder" | "globe" | "file-text"; label: string }> }
  | {
      kind: "artifact";
      icon: "folder" | "globe" | "file-text";
      title: string;
      sub: string;
    };

export interface ViewQuestionOption {
  label: string;
  description?: string | undefined;
}

export interface ViewQuestion {
  id: string;
  header?: string;
  question: string;
  isOther: boolean;
  isSecret: boolean;
  options: ViewQuestionOption[];
}

export interface ViewUserInput {
  requestId: number;
  questions: ViewQuestion[];
}

export interface PendingApproval {
  requestId: number;
  title: LocalizedText;
  sub?: string | undefined;
}

export interface SelectedTaskDetail {
  /** 选中的工作是否正在推进（线程尾部的进行中指示） */
  running?: boolean | undefined;
  fileChanges: FileChange[];
  materials: MaterialItem[];
  /** 目标句；缺省用任务名 */
  goal?: LocalizedText | undefined;
  goalNote?: string | undefined;
  stream: StreamCard[];
}

export interface AccountSummary {
  plan: LocalizedText;
  email?: string;
}

export interface CxaViewState {
  view: "work" | "settings";
  logged: boolean;
  loading: boolean;
  /** Codex 内核缺失/损坏：显示一键修复安装引导，而不是笼统的重试提示。 */
  runtimeMissing?: boolean | undefined;
  error?: LocalizedText | undefined;
  tasks: TaskRow[];
  selectedId: string;
  detail?: SelectedTaskDetail | undefined;
  approvals: PendingApproval[];
  userInputs: ViewUserInput[];
  unsupported: string[];
  newWorkMode: boolean;
  deviceLogin?: { verificationUrl: string; userCode: string } | undefined;
  loginStatus?: LocalizedText | undefined;
  account?: AccountSummary | undefined;
  /** account/read 已成功结算；false 表示未知，不能当作未登录。 */
  accountProbed: boolean;
  runtime?: RuntimeSummary | undefined;
  linkedApps: LinkedAppSummary[];
  skills: SkillSummary[];
  skillsCwd?: string | undefined;
  capabilitiesLoading: boolean;
  capabilitiesError?: LocalizedText | undefined;
  /** 官方 model/list、rateLimits、usage 的真实快照。 */
  models: ModelSummary[];
  selectedModel?: string | undefined;
  selectedEffort?: ReasoningEffort | undefined;
  /** 当前输入模式；缺省 plan。 */
  selectedMode?: CodexTurnMode | undefined;
  usage?: UsageSummary | undefined;
  /** 选择线程后，thread/read 尚未结束时不允许盲发。 */
  detailLoading?: boolean | undefined;
  /**
   * 首 turn 宽限占位（CODEXAPP-01）：权威详情尚未落盘、占位没有 activeTurnId，
   * 停止/追加发送必然失败（m153/m154）并把错误刷进 Host 通道。期间这些入口
   * 禁用、只保留只读展示；权威详情落地或窗口超时后自动恢复。
   */
  firstTurnGrace?: boolean | undefined;
}

export interface CxaViewHandlers {
  onSelectTask(taskId: string): void;
  onNewWork(): void;
  onSend(text: string): Promise<void>;
  onInterrupt(): Promise<void>;
  onSelectModel(model: string): void;
  onSelectEffort(effort: ReasoningEffort): void;
  onSelectMode(mode: CodexTurnMode): void;
  /** 把文件交给独立文本编辑器（apps.intent → com.reai.text-editor/open-document） */
  onOpenExternal(path: string): void;
  onApproval(requestId: number, decision: "approved" | "denied"): void;
  onSubmitAnswers(requestId: number, answers: Record<string, string[]>): void;
  onExitSettings(): void;
  onLoginBrowser(): void;
  onLoginDevice(): void;
  onLogout(): void;
  onCopyText(text: string): void;
  /** 内核缺失时的一键修复：深链到 Host「已安装 › 运行组件」，完成后经 intent 返回。 */
  onRepairRuntime(): void;
}

/* ===== 静态文案：逐字来自设计稿 ===== */

/* ===== 小工具 ===== */

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

export function baseNameOf(cwd: string): string {
  const parts = cwd.split("/").filter(Boolean);
  return parts.at(-1) ?? cwd;
}

export function deriveStatus(row: { statusHint: string; needsDecision: boolean }): {
  cls: TaskStatusClass;
  text: string;
} {
  if (row.needsDecision) return { cls: "wait", text: t("ui.m015") };
  if (/notStarted/i.test(row.statusHint)) return { cls: "ready", text: t("ui.m016") };
  if (/active|running|turn|stream/i.test(row.statusHint)) return { cls: "run", text: t("ui.m017") };
  return { cls: "done", text: t("ui.m018") };
}

export function relativeTime(timestampMs: number, nowMs = Date.now()): string {
  if (!timestampMs) return "";
  const diff = Math.max(0, nowMs - timestampMs);
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return t("ui.m019");
  if (minutes < 60) return t("ui.m155", { p0: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("ui.m156", { p0: hours });
  const days = Math.floor(hours / 24);
  if (days === 1) return t("ui.m020");
  if (days < 7) return t("ui.m157", { p0: days });
  const date = new Date(timestampMs);
  return t("ui.m158", { p0: date.getMonth() + 1, p1: date.getDate() });
}

export function groupTasksByFolder(
  tasks: TaskRow[],
): Array<{ folder: string; rows: TaskRow[] }> {
  const groups = new Map<string, TaskRow[]>();
  for (const row of [...tasks].sort((a, b) => b.updatedAt - a.updatedAt)) {
    groups.set(row.cwd, [...(groups.get(row.cwd) ?? []), row]);
  }
  return [...groups.entries()]
    .map(([folder, rows]) => ({ folder, rows }))
    .sort((a, b) => b.rows[0]!.updatedAt - a.rows[0]!.updatedAt);
}

function multiline(target: HTMLElement, text: string): void {
  target.replaceChildren();
  text.split("\n").forEach((line, index) => {
    if (index > 0) target.append(el("br"));
    target.append(document.createTextNode(line));
  });
}

/* ===== 挂载入口 ===== */

export interface CxaView {
  update(patch: Partial<CxaViewState>): void;
  snapshot(): Readonly<CxaViewState>;
  toast(message: LocalizedText): void;
  refreshLocale(locale: string, patch?: Partial<CxaViewState>): void;
  destroy(): void;
}

export function mountCodexView(
  root: HTMLElement,
  initialState: CxaViewState,
  handlers: CxaViewHandlers,
): CxaView {
  let disposed = false;
  let localizing = false;
  let toastMessage: LocalizedText = "";
  const state: CxaViewState = { ...initialState };
  let inspectorTab: "context" | "files" | "capabilities" = "context";
  let inspectorOff = true;
  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  let composeBusy = false;
  let interruptBusy = false;
  const questionDrafts = new Map<number, Record<string, string[]>>();

  /* ---- 骨架：一次搭好，之后只重绘动态区（保住输入焦点与草稿）---- */

  root.classList.add("cxa-page", "inspector-off");
  root.id = "cxaPage";

  const workspace = el("div", "cxa-workspace");

  /* 左栏 */
  const nav = el("aside", "cxa-nav");
  const navHead = el("div", "cxa-nav-head");
  const brandRow = el("div", "cxa-brand-row");
  const brand = el("div", "cxa-brand");
  brand.textContent = "Codex App";
  const newButton = el("button", "cxa-new") as HTMLButtonElement;
  newButton.type = "button";
  newButton.title = t("ui.m021");
  newButton.append(iconSpan("plus", 14));
  brandRow.append(brand, newButton);
  const searchWrap = el("label", "cxa-search");
  searchWrap.setAttribute("for", "cxaSearch");
  searchWrap.append(iconSpan("search", 12));
  const searchInput = el("input") as HTMLInputElement;
  searchInput.id = "cxaSearch";
  searchInput.placeholder = t("ui.m003");
  searchInput.autocomplete = "off";
  searchWrap.append(searchInput);
  navHead.append(brandRow, searchWrap);
  const taskListBox = el("div", "cxa-scroll");
  taskListBox.id = "cxaTaskList";
  nav.append(navHead, taskListBox);

  /* 中栏 */
  const center = el("main", "cxa-center");
  const head = el("header", "cxa-head");
  const headBlock = el("div", "cxa-head-b");
  const titleBox = el("div", "cxa-title");
  titleBox.id = "cxaTitle";
  const metaBox = el("div", "cxa-meta");
  metaBox.id = "cxaMeta";
  headBlock.append(titleBox, metaBox);
  const inspectToggle = el("button", "cxa-inspect-toggle") as HTMLButtonElement;
  inspectToggle.type = "button";
  inspectToggle.id = "cxaInspectToggle";
  inspectToggle.title = t("ui.m022");
  inspectToggle.setAttribute("aria-controls", "cxaInspector");
  inspectToggle.setAttribute("aria-expanded", "false");
  inspectToggle.append(iconSpan("layers", 15));
  head.append(headBlock, inspectToggle);
  const threadBox = el("div", "cxa-thread");
  threadBox.id = "cxaThread";
  const composeZone = el("div", "cxa-compose");
  const composeCard = el("div", "cxa-compose-card");
  const contextRow = el("div", "cxa-context-row");
  contextRow.id = "cxaContextRow";
  const composeInput = el("textarea", "cxa-input") as HTMLTextAreaElement;
  composeInput.id = "cxaInput";
  composeInput.placeholder = t("ui.m001");
  const composeFoot = el("div", "cxa-compose-ft");
  const composeControls = el("div", "cxa-compose-controls");
  const modelSelect = el("select", "cxa-compose-select") as HTMLSelectElement;
  modelSelect.id = "cxaModel";
  modelSelect.title = t("ui.m023");
  modelSelect.setAttribute("aria-label", t("ui.m023"));
  const effortSelect = el("select", "cxa-compose-select") as HTMLSelectElement;
  effortSelect.id = "cxaEffort";
  effortSelect.title = t("ui.m024");
  effortSelect.setAttribute("aria-label", t("ui.m024"));
  const modeSelect = el("select", "cxa-compose-select") as HTMLSelectElement;
  modeSelect.id = "cxaMode";
  modeSelect.title = t("ui.m182");
  modeSelect.setAttribute("aria-label", t("ui.m182"));
  for (const mode of TURN_MODES) {
    const option = el("option") as HTMLOptionElement;
    option.value = mode;
    option.textContent = t(`mode.${mode}`);
    modeSelect.append(option);
  }
  const usageLabel = el("span", "cxa-usage");
  composeControls.append(modelSelect, effortSelect, modeSelect, usageLabel);
  const spacer = el("span", "cxa-spacer");
  const interruptButton = el("button", "cxa-interrupt") as HTMLButtonElement;
  interruptButton.type = "button";
  interruptButton.id = "cxaInterrupt";
  interruptButton.title = t("ui.m025");
  interruptButton.setAttribute("aria-label", t("ui.m025"));
  interruptButton.append(iconSpan("x", 12));
  const sendButton = el("button", "cxa-send") as HTMLButtonElement;
  sendButton.type = "button";
  sendButton.id = "cxaSend";
  sendButton.title = t("ui.m026");
  sendButton.disabled = true;
  sendButton.append(iconSpan("send", 13));
  composeFoot.append(composeControls, spacer, interruptButton, sendButton);
  composeCard.append(contextRow, composeInput, composeFoot);
  composeZone.append(composeCard);
  center.append(head, threadBox, composeZone);

  /* 右栏 inspector */
  const inspector = el("aside", "cxa-inspector");
  inspector.id = "cxaInspector";
  inspector.setAttribute("aria-hidden", "true");
  inspector.inert = true;
  const inspectorHead = el("div", "cxa-inspector-head");
  const inspectorHeadCopy = el("div", "cxa-inspector-head-copy");
  const inspectorTitle = el("div", "cxa-inspector-title");
  inspectorTitle.textContent = t("ui.m027");
  const inspectorSub = el("div", "cxa-inspector-sub");
  inspectorSub.textContent = t("ui.m004");
  inspectorHeadCopy.append(inspectorTitle, inspectorSub);
  const inspectorClose = el("button", "cxa-inspector-close") as HTMLButtonElement;
  inspectorClose.type = "button";
  inspectorClose.title = t("ui.m028");
  inspectorClose.setAttribute("aria-label", t("ui.m028"));
  inspectorClose.append(iconSpan("x", 14));
  inspectorHead.append(inspectorHeadCopy, inspectorClose);
  const tabBar = el("div", "cxa-tabs");
  tabBar.id = "cxaTabs";
  tabBar.setAttribute("role", "tablist");
  const tabButtons = (
    [
      ["context", t("ui.m029")],
      ["files", t("ui.m030")],
      ["capabilities", t("ui.m031")],
    ] as const
  ).map(([key, label]) => {
    const btn = el(
      "button",
      key === "context" ? "cxa-tab active" : "cxa-tab",
    ) as HTMLButtonElement;
    btn.type = "button";
    btn.dataset.cxaTab = key;
    btn.textContent = label;
    btn.setAttribute("role", "tab");
    btn.setAttribute("aria-selected", String(key === "context"));
    return btn;
  });
  tabBar.append(...tabButtons);
  const inspectorBody = el("div", "cxa-inspector-scroll");
  inspectorBody.id = "cxaInspectorBody";
  inspector.append(inspectorHead, tabBar, inspectorBody);

  workspace.append(nav, center, inspector);

  /* 未登录连接卡 */
  const authOverlay = el("section", "cxa-auth");
  authOverlay.id = "cxaAuth";
  const authCard = el("div", "cxa-auth-card");
  const authLogo = el("div", "cxa-auth-logo");
  authLogo.append(iconSpan("codex", 24));
  const authHeading = el("div", "cxa-auth-h");
  authHeading.textContent = t("ui.m005");
  const authBody = el("div", "cxa-auth-p");
  authBody.textContent = t("ui.m006");
  const authGo = el("button", "cxa-auth-go") as HTMLButtonElement;
  authGo.type = "button";
  authGo.id = "cxaLogin";
  authGo.textContent = t("ui.m009");
  const authAlt = el("div", "cxa-auth-alt");
  ([
  t("ui.m007"),
  t("ui.m008"),
]).forEach((line, index) => {
    if (index > 0) authAlt.append(el("br"));
    authAlt.append(document.createTextNode(line));
  });
  authCard.append(authLogo, authHeading, authBody, authGo, authAlt);
  authOverlay.append(authCard);

  const toastBox = el("div", "cxa-toast");
  toastBox.id = "cxaToast";
  toastBox.setAttribute("role", "status");
  toastBox.setAttribute("aria-live", "polite");

  root.append(workspace, authOverlay, toastBox);

  /* ---- 动态渲染 ---- */

  const selectedTask = (): TaskRow | undefined =>
    state.tasks.find((row) => row.id === state.selectedId);

  function folderNote(text: string): HTMLElement {
    const note = el("div", "cxa-folder-note standalone");
    note.textContent = text;
    return note;
  }

  function renderTaskList(): void {
    const localeTarget = localizing ? taskListBox.cloneNode(false) as HTMLElement : taskListBox;
    try {
      const query = searchInput.value.trim().toLowerCase();
      const visibleIds = localizing
        ? new Set(Array.from(taskListBox.querySelectorAll<HTMLElement>("[data-cxa-task]"), node => node.dataset.cxaTask))
        : undefined;
      localeTarget.replaceChildren();
      if (state.tasks.length === 0) {
        localeTarget.append(folderNote(state.loading ? t("ui.m032") : t("ui.m013")));
        return;
      }
      for (const group of groupTasksByFolder(state.tasks)) {
        const shown = visibleIds
          ? group.rows.filter(row => visibleIds.has(row.id))
          : query
          ? group.rows.filter((row) =>
              `${resolveText(row.name)} ${row.cwd} ${relativeTime(row.updatedAt)}`
                .toLowerCase()
                .includes(query),
            )
          : group.rows;
        const folded = collapsedFolders.has(group.folder) && !(query && shown.length);
        const section = el("section", folded ? "cxa-proj fold" : "cxa-proj");
        section.dataset.folder = group.folder;
        const folderButton = el("button", "cxa-folder") as HTMLButtonElement;
        folderButton.type = "button";
        folderButton.dataset.cxaFolder = group.folder;
        folderButton.title = group.folder;
        const caret = el("span", "cxa-folder-caret");
        caret.append(iconSpan("chevron-right", 11));
        folderButton.append(caret, iconSpan("folder", 12));
        const name = el("span");
        name.textContent = baseNameOf(group.folder);
        const count = el("span", "cxa-folder-count");
        count.textContent = `· ${group.rows.length}`;
        folderButton.append(name, count, el("span", "cxa-folder-spacer"));
        section.append(folderButton);
        if (folded) {
          section.append(folderNote(t("ui.m159", { p0: group.rows.length })));
        } else if (shown.length === 0) {
          section.append(folderNote(query ? t("ui.m012") : t("ui.m013")));
        } else {
          for (const row of shown) {
            const status = deriveStatus(row);
            const taskBtn = el(
              "button",
              row.id === state.selectedId ? "cxa-task active" : "cxa-task",
            ) as HTMLButtonElement;
            taskBtn.type = "button";
            taskBtn.dataset.cxaTask = row.id;
            const topLine = el("span", "cxa-task-r");
            const titleLabel = el("span", "cxa-task-t");
            titleLabel.textContent = resolveText(row.name);
            const statusChip = el("span", `cxa-status ${status.cls}`);
            statusChip.append(el("i"), document.createTextNode(status.text));
            topLine.append(titleLabel, statusChip);
            const metaLine = el("span", "cxa-task-m");
            metaLine.append(
              iconSpan("file-text", 10),
              document.createTextNode(relativeTime(row.updatedAt)),
            );
            taskBtn.append(topLine, metaLine);
            section.append(taskBtn);
          }
        }
        localeTarget.append(section);
      }
    } finally {
      if (localizing) patchLocalizedContent(taskListBox, localeTarget);
    }
  }

  function renderContextChips(): void {
    const localeTarget = localizing ? contextRow.cloneNode(false) as HTMLElement : contextRow;
    try {
      const row = selectedTask();
      localeTarget.replaceChildren();
      if (!row) return;
      const first = el("span", "cxa-context-pill");
      first.title = row.cwd;
      first.append(iconSpan("folder", 10));
      const bold = el("b");
      bold.textContent = baseNameOf(row.cwd);
      first.append(bold);
      localeTarget.append(first);
      for (const material of state.detail?.materials.slice(0, 3) ?? []) {
        const pill = el("span", "cxa-context-pill");
        pill.append(iconSpan(material.icon, 10), document.createTextNode(material.title));
        localeTarget.append(pill);
      }
    } finally {
      if (localizing) patchLocalizedContent(contextRow, localeTarget);
    }
  }

  function renderHeaderMeta(): void {
    const localeTarget = localizing ? metaBox.cloneNode(false) as HTMLElement : metaBox;
    try {
      const row = selectedTask();
      localeTarget.replaceChildren();
      const taskTitle = row ? resolveText(row.name) : "";
      if (titleBox.textContent !== taskTitle) titleBox.textContent = taskTitle;
      if (!row) return;
      localeTarget.append(iconSpan("folder", 10));
      const folderChip = el("span");
      folderChip.title = row.cwd;
      folderChip.textContent = baseNameOf(row.cwd);
      const dot = el("span");
      dot.textContent = "·";
      const outcome = el("span");
      outcome.textContent = state.detail?.running
        ? t("ui.m033")
        : t("ui.m160", { p0: relativeTime(row.updatedAt) });
      localeTarget.append(folderChip, dot, outcome);
    } finally {
      if (localizing) patchLocalizedContent(metaBox, localeTarget);
    }
  }

  function runningLine(text: string): HTMLElement {
    const line = el("div", "cxa-actionline");
    line.append(el("span", "spin"), document.createTextNode(text));
    return line;
  }

  function buildApprovalCard(approval: PendingApproval): HTMLElement {
    const card = el("div", "cxa-approval");
    const main = el("div", "cxa-approval-main");
    const iconHolder = el("span", "cxa-art-ic");
    iconHolder.append(iconSpan("check", 14));
    const block = el("div", "cxa-approval-b");
    const title = el("div", "cxa-approval-t");
    title.textContent = resolveText(approval.title);
    block.append(title);
    if (approval.sub) {
      const sub = el("div", "cxa-approval-s");
      sub.textContent = approval.sub;
      block.append(sub);
    }
    main.append(iconHolder, block);
    const actions = el("div", "cxa-approval-actions");
    const deny = el("button", "cxa-btn secondary") as HTMLButtonElement;
    deny.type = "button";
    deny.textContent = t("ui.m034");
    const allow = el("button", "cxa-btn primary") as HTMLButtonElement;
    allow.type = "button";
    allow.textContent = t("ui.m035");
    const settle = (decision: "approved" | "denied"): void => {
      if (deny.disabled || allow.disabled) return;
      deny.disabled = true;
      allow.disabled = true;
      view.toast(decision === "approved" ? message("ui.m036") : message("ui.m037"));
      handlers.onApproval(approval.requestId, decision);
    };
    deny.onclick = () => settle("denied");
    allow.onclick = () => settle("approved");
    actions.append(deny, allow);
    card.append(main, actions);
    return card;
  }

  function buildQuestionsCard(request: ViewUserInput): HTMLElement {
    const card = el("form", "cxa-user-input");
    card.dataset.requestId = String(request.requestId);
    if (!questionDrafts.has(request.requestId)) questionDrafts.set(request.requestId, {});
    const draft = questionDrafts.get(request.requestId)!;

    const heading = el("strong");
    heading.textContent = t("ui.m038");
    card.append(heading);

    for (const question of request.questions) {
      const fieldset = el("fieldset", "cxa-question");
      const legend = el("legend");
      legend.textContent = question.header ?? question.question;
      fieldset.append(legend);
      if (question.header) {
        const prompt = el("p");
        prompt.textContent = question.question;
        fieldset.append(prompt);
      }
      for (const option of question.options) {
        const optionLabel = el("label");
        const radio = el("input") as HTMLInputElement;
        radio.type = "radio";
        radio.name = `question-${request.requestId}-${question.id}`;
        radio.value = option.label;
        radio.checked = draft[question.id]?.[0] === option.label;
        radio.onchange = () => {
          draft[question.id] = [option.label];
        };
        optionLabel.append(radio);
        const copy = el("span");
        copy.textContent = option.description
          ? `${option.label} — ${option.description}`
          : option.label;
        optionLabel.append(copy);
        fieldset.append(optionLabel);
      }
      if (question.options.length === 0 || question.isOther) {
        const freeText = el("input", "cxa-answer") as HTMLInputElement;
        freeText.type = question.isSecret ? "password" : "text";
        freeText.autocomplete = "off";
        freeText.placeholder = question.options.length > 0 ? t("ui.m039") : t("ui.m040");
        const labels = new Set(question.options.map((option) => option.label));
        const existing = draft[question.id]?.[0];
        freeText.value = existing && !labels.has(existing) ? existing : "";
        freeText.oninput = () => {
          const value = freeText.value.trim();
          if (value) draft[question.id] = [value];
          else delete draft[question.id];
        };
        fieldset.append(freeText);
      }
      card.append(fieldset);
    }

    const validation = el("p", "cxa-validation");
    const submit = el("button", "cxa-btn primary") as HTMLButtonElement;
    submit.type = "submit";
    submit.textContent = t("ui.m041");
    card.onsubmit = (event) => {
      event.preventDefault();
      const complete = request.questions.every((question) => draft[question.id]?.[0]?.trim());
      if (!complete) {
        validation.dataset.messageKey = "ui.m042";
        validation.textContent = t("ui.m042");
        return;
      }
      delete validation.dataset.messageKey;
      validation.textContent = "";
      submit.disabled = true;
      handlers.onSubmitAnswers(request.requestId, draft);
    };
    card.append(validation, submit);
    return card;
  }

  function buildStreamCards(): HTMLElement[] {
    const nodes: HTMLElement[] = [];
    const row = selectedTask();
    if (!row) {
      if (state.error) {
        const alert = el("div", "cxa-alert");
        alert.textContent = resolveText(state.error);
        nodes.push(alert);
      }
      return nodes;
    }
    for (const card of state.detail?.stream ?? []) {
      if (card.kind === "user") {
        const bubble = el("div", "cxa-msg user");
        bubble.textContent = card.text;
        nodes.push(bubble);
      } else if (card.kind === "agent") {
        const msg = el("div", "cxa-msg");
        const avatar = el("div", "cxa-agent-ic");
        avatar.append(iconSpan("codex", 14));
        const bodyBlock = el("div", "cxa-msg-b");
        if (card.lead) {
          const lead = el("b");
          lead.textContent = card.lead;
          bodyBlock.append(lead, el("br"));
        }
        const lines = el("span");
        multiline(lines, card.body);
        bodyBlock.append(lines);
        msg.append(avatar, bodyBlock);
        nodes.push(msg);
      } else if (card.kind === "source") {
        const strip = el("div", "cxa-source-strip");
        for (const chip of card.chips) {
          const chipEl = el("span", "cxa-source-chip");
          chipEl.append(iconSpan(chip.icon, 10), document.createTextNode(` ${chip.label}`));
          strip.append(chipEl);
        }
        nodes.push(strip);
      } else {
        const artifact = el("article", "cxa-artifact");
        const artHead = el("div", "cxa-art-head");
        const iconHolder = el("span", "cxa-art-ic");
        iconHolder.append(iconSpan(card.icon, 14));
        const textBlock = el("span");
        const artTitle = el("div", "cxa-art-title");
        artTitle.textContent = card.title;
        const artSub = el("div", "cxa-art-sub");
        artSub.textContent = card.sub;
        textBlock.append(artTitle, artSub);
        artHead.append(iconHolder, textBlock);
        artifact.append(artHead);
        nodes.push(artifact);
      }
    }
    // 「轮到你了」的部分贴在流尾部。
    for (const approval of state.approvals) {
      nodes.push(buildApprovalCard(approval));
    }
    for (const request of state.userInputs) {
      nodes.push(buildQuestionsCard(request));
    }
    for (const method of state.unsupported) {
      const alertLine = el("div", "cxa-alert");
      alertLine.textContent = t("ui.m161", { p0: method || t("ui.m128") });
      nodes.push(alertLine);
    }
    if (state.error) {
      const alert = el("div", "cxa-alert");
      alert.textContent = resolveText(state.error);
      nodes.push(alert);
    }
    if (state.detail?.running) nodes.push(runningLine(t("ui.m043")));
    return nodes;
  }

  function buildRuntimeMissingPanel(): HTMLElement {
    const box = el("div", "cxa-empty-thread cxa-runtime-missing");
    const title = el("div", "cxa-runtime-missing-t");
    title.textContent = t("ui.m044");
    const body = el("p", "cxa-runtime-missing-b");
    body.textContent = t("ui.m014");
    const repair = el("button", "cxa-btn primary") as HTMLButtonElement;
    repair.type = "button";
    repair.dataset.cxaRepairRuntime = "1";
    repair.textContent = t("ui.m045");
    repair.addEventListener("click", () => handlers.onRepairRuntime());
    box.append(title, body, repair);
    return box;
  }

  function replaceThreadContent(...nodes: Node[]): void {
    if (!localizing) { threadBox.replaceChildren(...nodes); return; }
    const next = threadBox.cloneNode(false) as HTMLElement;
    next.append(...nodes);
    patchLocalizedContent(threadBox, next);
  }

  function renderThread(): void {
    const wasAtBottom =
      threadBox.scrollTop + threadBox.clientHeight >= threadBox.scrollHeight - 28;
    const cards = buildStreamCards();
    if (!selectedTask()) {
      if (state.runtimeMissing) {
        // 内核缺失是终态：给出可点的一键修复，而不是「正在获取工作…」无限转圈。
        replaceThreadContent(buildRuntimeMissingPanel());
        return;
      }
      const empty = el("div", "cxa-empty-thread");
      empty.textContent = state.loading
        ? t("ui.m032")
        : t("ui.m046");
      replaceThreadContent(...cards, empty);
      return;
    }
    if (cards.length === 0 && state.loading) {
      cards.unshift(runningLine(t("ui.m032")));
    }
    replaceThreadContent(...cards);
    if (!localizing && wasAtBottom) threadBox.scrollTop = threadBox.scrollHeight;
  }

  /* ---- Inspector 三 tab ---- */

  function inspectorSection(headerText: string, actionLabel?: string, action?: () => void): {
    root: HTMLElement;
    header: HTMLElement;
  } {
    const section = el("section", "cxa-sec");
    const headerRow = el("div", "cxa-sec-h");
    const title = el("span", "cxa-sec-t");
    title.textContent = headerText;
    headerRow.append(title);
    if (actionLabel && action) {
      const link = el("span", "cxa-sec-a");
      link.textContent = actionLabel;
      link.onclick = action;
      headerRow.append(link);
    }
    section.append(headerRow);
    return { root: section, header: headerRow };
  }

  function inspectorItem(
    icon: "folder" | "globe" | "file-text" | "workflow" | "sparkles",
    title: string,
    sub: string,
    opts?: { onClick?: () => void; tag?: string },
  ): HTMLElement {
    const clickable = Boolean(opts?.onClick);
    const item = clickable
      ? (el("button", "cxa-item") as HTMLButtonElement)
      : el("div", "cxa-item");
    if (clickable && opts?.onClick) (item as HTMLButtonElement).onclick = opts.onClick;
    const iconHolder = el("span", "cxa-item-ic");
    iconHolder.append(iconSpan(icon, 12));
    const block = el("span", "cxa-item-b");
    const titleEl = el("span", "cxa-item-t");
    titleEl.textContent = title;
    const subEl = el("span", "cxa-item-s");
    subEl.textContent = sub;
    block.append(titleEl, subEl);
    item.append(iconHolder, block);
    if (opts?.tag) {
      const tag = el("span", "cxa-item-tag");
      tag.textContent = opts.tag;
      item.append(tag);
    }
    return item;
  }

  function renderInspector(): void {
    const localeTarget = localizing ? inspectorBody.cloneNode(false) as HTMLElement : inspectorBody;
    try {
      for (const btn of tabButtons) {
        const selected = btn.dataset.cxaTab === inspectorTab;
        btn.classList.toggle("active", selected);
        btn.setAttribute("aria-selected", String(selected));
      }
      localeTarget.replaceChildren();

      if (inspectorTab === "context") {
        const row = selectedTask();
        const folderSection = inspectorSection(t("ui.m047"));
        if (row) folderSection.root.append(inspectorItem("folder", baseNameOf(row.cwd), row.cwd));
        else folderSection.root.append(folderNote(t("ui.m048")));
        localeTarget.append(folderSection.root);

        const goalSection = inspectorSection(
          t("ui.m049"),
          row ? t("ui.m050") : undefined,
          () => composeInput.focus(),
        );
        if (row) {
          const summary = el("div", "cxa-summary");
          const summaryT = el("div", "cxa-summary-t");
          summaryT.textContent = resolveText(state.detail?.goal ?? row.name);
          summary.append(summaryT);
          if (state.detail?.goalNote) {
            const summaryS = el("div", "cxa-summary-s");
            summaryS.textContent = state.detail.goalNote;
            summary.append(summaryS);
          }
          goalSection.root.append(summary);
        } else {
          goalSection.root.append(folderNote(t("ui.m048")));
        }
        localeTarget.append(goalSection.root);

        const materialsSection = inspectorSection(
          t("ui.m051"),
        );
        const materials = state.detail?.materials ?? [];
        if (materials.length > 0) {
          for (const material of materials) {
            materialsSection.root.append(
              inspectorItem(material.icon, material.title, material.sub),
            );
          }
        } else if (row) {
          materialsSection.root.append(folderNote(t("ui.m052")));
        }
        localeTarget.append(materialsSection.root);
        return;
      }

      if (inspectorTab === "files") {
        const files = state.detail?.fileChanges ?? [];
        const section = inspectorSection(t("ui.m053"));
        const countTag = el("span", "cxa-item-tag");
        countTag.textContent = t("ui.m162", { p0: files.length });
        section.header.append(countTag);
        if (files.length === 0) {
          section.root.append(folderNote(t("ui.m054")));
        } else {
          const editor = state.linkedApps.find((app) => app.appId === "com.reai.text-editor");
          const canOpenEditor = Boolean(editor?.installed && editor.enabled);
          for (const change of files) {
            const fileName = change.path.split("/").at(-1) ?? change.path;
            section.root.append(
              inspectorItem("file-text", fileName, change.label ?? t("ui.m055"), {
                ...(canOpenEditor ? { onClick: () => handlers.onOpenExternal(change.path) } : {}),
                tag: canOpenEditor ? t("ui.m056") : t("ui.m057"),
              }),
            );
          }
        }
        localeTarget.append(section.root);
        const editor = state.linkedApps.find((app) => app.appId === "com.reai.text-editor");
        const canOpenEditor = Boolean(editor?.installed && editor.enabled);
        if (files.length > 0 && canOpenEditor) {
          const openAll = el("button", "cxa-open-plugin") as HTMLButtonElement;
          openAll.type = "button";
          openAll.append(
            iconSpan("external-link", 11),
            document.createTextNode(t("ui.m058")),
          );
          openAll.onclick = () => handlers.onOpenExternal(files[0]!.path);
          localeTarget.append(openAll);
        }
        return;
      }

      const appsSection = inspectorSection(t("ui.m059"));
      if (state.capabilitiesLoading && state.linkedApps.length === 0) {
        appsSection.root.append(folderNote(t("ui.m060")));
      } else if (state.linkedApps.length === 0) {
        appsSection.root.append(folderNote(t("ui.m061")));
      } else {
        for (const app of state.linkedApps) {
          const tag = !app.installed ? t("ui.m062") : app.enabled ? t("ui.m063") : t("ui.m064");
          appsSection.root.append(
            inspectorItem(
              "file-text",
              resolveText(app.name),
              app.enabled ? t("ui.m065") : t("ui.m066"),
              { tag },
            ),
          );
        }
      }
      localeTarget.append(appsSection.root);

      const skillsSection = inspectorSection(t("ui.m067"));
      if (!selectedTask()) {
        skillsSection.root.append(folderNote(t("ui.m068")));
      } else if (state.capabilitiesLoading && state.skills.length === 0) {
        skillsSection.root.append(folderNote(t("ui.m069")));
      } else if (state.skills.length === 0) {
        skillsSection.root.append(folderNote(t("ui.m070")));
      } else {
        for (const skill of state.skills) {
          skillsSection.root.append(
            inspectorItem("sparkles", skill.displayName, resolveText(skill.description), {
              tag: skill.scope,
            }),
          );
        }
      }
      localeTarget.append(skillsSection.root);

      if (state.capabilitiesError) {
        localeTarget.append(folderNote(resolveText(state.capabilitiesError)));
      }
    } finally {
      if (localizing) patchLocalizedContent(inspectorBody, localeTarget);
    }
  }

  /* ---- 设置页 ---- */

  function labeledRow(title: string, sub?: string): { row: HTMLElement } {
    const row = el("div", "row");
    const left = el("div", "rl");
    const rt = el("div", "rt");
    rt.textContent = title;
    left.append(rt);
    if (sub !== undefined) {
      const subEl = el("div", "rt-sub");
      subEl.textContent = sub;
      left.append(subEl);
    }
    row.append(left);
    return { row };
  }

  function renderSettings(): void {
    workspace.style.display = "none";
    // 设置页自带登录入口；连接卡只在工作台视图全屏出现。
    let frame = root.querySelector<HTMLElement>("#cxaSettingsFrame");
    if (!frame) {
      frame = el("div", "cxa-settings-frame");
      frame.id = "cxaSettingsFrame";
      const intro = el("div", "voice-settings-intro");
      const introCopy = el("div", "voice-settings-intro-copy");
      const introTitle = el("div", "voice-settings-intro-title");
      introTitle.textContent = t("ui.m010");
      const introSub = el("div", "voice-settings-intro-sub");
      introSub.textContent = t("ui.m011");
      introCopy.append(introTitle, introSub);
      const backChip = el("button", "cxa-settings-back") as HTMLButtonElement;
      backChip.type = "button";
      backChip.append(iconSpan("arrow-left", 13), document.createTextNode(t("ui.m071")));
      backChip.onclick = () => handlers.onExitSettings();
      intro.append(introCopy, backChip);
      const body = el("div", "cxa-settings-body");
      body.id = "cxaSettingsBody";
      frame.append(intro, body);
      root.append(frame);
    }
    renderSettingsBody(frame.querySelector<HTMLElement>("#cxaSettingsBody")!);
  }

  function renderSettingsBody(originalBody: HTMLElement): void {
    const body = localizing ? originalBody.cloneNode(false) as HTMLElement : originalBody;
    try {
      body.replaceChildren();

      const runtimeGroup = el("div");
      const runtimeLabel = el("div", "slbl");
      runtimeLabel.textContent = t("ui.m072");
      const runtimeCard = el("div", "scard");
      const runtimeRow = labeledRow(
        t("ui.m073"),
        state.runtime ? t("ui.m163", { p0: state.runtime.version }) : t("ui.m074"),
      );
      const runtimeValue = el("span", state.runtime?.running ? "cxa-live-state ok" : "cxa-live-state");
      runtimeValue.textContent = state.runtime
        ? state.runtime.running
          ? t("ui.m075")
          : t("ui.m076")
        : t("ui.m077");
      runtimeRow.row.append(runtimeValue);
      runtimeCard.append(runtimeRow.row);

      if (state.runtime?.installState === "missing" || state.runtimeMissing) {
        const installRow = labeledRow(
          t("ui.m078"),
          t("ui.m079"),
        );
        const repair = el("button", "cxa-btn primary") as HTMLButtonElement;
        repair.type = "button";
        repair.dataset.cxaRepairRuntime = "1";
        repair.textContent = t("ui.m045");
        repair.addEventListener("click", () => handlers.onRepairRuntime());
        installRow.row.append(repair);
        runtimeCard.append(installRow.row);
      }

      for (const app of state.linkedApps) {
        const appRow = labeledRow(resolveText(app.name), t("ui.m080"));
        const appValue = el("span", app.installed && app.enabled ? "cxa-live-state ok" : "cxa-live-state");
        appValue.textContent = !app.installed ? t("ui.m062") : app.enabled ? t("ui.m063") : t("ui.m064");
        appRow.row.append(appValue);
        runtimeCard.append(appRow.row);
      }

      if (state.skillsCwd) {
        const skillsRow = labeledRow(
          t("ui.m081"),
          state.skillsCwd,
        );
        const skillsValue = el("span", "cxa-live-state ok");
        skillsValue.textContent = t("ui.m164", { p0: state.skills.length });
        skillsRow.row.append(skillsValue);
        runtimeCard.append(skillsRow.row);
      }
      if (state.selectedModel) {
        const model = state.models.find((entry) => entry.id === state.selectedModel);
        const modelRow = labeledRow(
          t("ui.m082"),
          state.selectedEffort ? t("ui.m165", { p0: t(`effort.${state.selectedEffort}`) }) : t("ui.m083"),
        );
        const modelValue = el("span", "cxa-live-state ok");
        modelValue.textContent = model?.displayName ?? state.selectedModel;
        modelRow.row.append(modelValue);
        runtimeCard.append(modelRow.row);
      }
      if (state.usage && Object.keys(state.usage).length > 0) {
        const primary = state.usage.primaryUsedPercent;
        const usageRow = labeledRow(
          t("ui.m084"),
          state.usage.lifetimeTokens === undefined
            ? t("ui.m085")
            : t("ui.m166", { p0: Math.round(state.usage.lifetimeTokens).toLocaleString(currentLocale()) }),
        );
        const usageValue = el("span", "cxa-live-state ok");
        usageValue.textContent = primary === undefined ? t("ui.m086") : t("ui.m167", { p0: Math.round(primary) });
        usageRow.row.append(usageValue);
        runtimeCard.append(usageRow.row);
      }
      if (state.capabilitiesError) {
        const errorRow = labeledRow(t("ui.m087"), resolveText(state.capabilitiesError));
        runtimeCard.append(errorRow.row);
      }
      runtimeGroup.append(runtimeLabel, runtimeCard);
      body.append(runtimeGroup);

      const accountGroup = el("div");
      const accountLabel = el("div", "slbl");
      accountLabel.textContent = t("ui.m088");
      const accountCard = el("div", "scard");
      const accountRow = el("div", "row");
      const accountMain = el("div", "cxa-settings-account");
      const accountLogo = el("span", "cxa-settings-logo");
      accountLogo.append(iconSpan("codex", 17));
      const accountBlock = el("span", "cxa-settings-account-b");
      const accountTitle = el("span", "cxa-settings-account-t");
      accountTitle.textContent = state.account
        ? resolveText(state.account.plan)
        : state.accountProbed
          ? t("ui.m089")
          : t("ui.m090");
      const accountSub = el("span", "cxa-settings-account-s");
      accountSub.textContent = state.account?.email ?? t("ui.m091");
      accountBlock.append(accountTitle, accountSub);
      accountMain.append(accountLogo, accountBlock);
      accountRow.append(accountMain);
      if (state.account) {
        const okPill = el("span", "cxa-settings-ok");
        okPill.append(el("i"), document.createTextNode(t("ui.m092")));
        accountRow.append(okPill);
      }
      accountCard.append(accountRow);

      if (!state.account && state.accountProbed) {
        const loginActions = el("div", "row");
        const loginLeft = el("div", "rl");
        const loginRt = el("div", "rt");
        loginRt.textContent = t("ui.m009");
        loginLeft.append(loginRt);
        const right = el("div", "cxa-settings-login");
        const go = el("button", "cxa-btn primary") as HTMLButtonElement;
        go.type = "button";
        go.textContent = t("ui.m093");
        go.onclick = () => handlers.onLoginBrowser();
        const device = el("button", "cxa-btn secondary") as HTMLButtonElement;
        device.type = "button";
        device.textContent = t("ui.m094");
        device.onclick = () => handlers.onLoginDevice();
        right.append(go, device);
        loginActions.append(right);
        loginActions.prepend(loginLeft);
        accountCard.append(loginActions);
      } else {
        const logoutRow = el("button", "row account-signout") as HTMLButtonElement;
        logoutRow.type = "button";
        const logoutLeft = el("div", "rl");
        const logoutRt = el("div", "rt danger");
        logoutRt.textContent = t("ui.m095");
        logoutLeft.append(logoutRt);
        logoutRow.append(logoutLeft);
        logoutRow.onclick = () => handlers.onLogout();
        accountCard.append(logoutRow);
      }

      if (state.loginStatus) {
        const statusLine = el("div", "cxa-login-status");
        statusLine.textContent = resolveText(state.loginStatus);
        accountCard.append(statusLine);
      }
      if (state.deviceLogin) {
        const codeBox = el("div", "cxa-device-code");
        const codeValue = el("strong");
        codeValue.textContent = state.deviceLogin.userCode;
        const copy = el("button", "cxa-btn secondary") as HTMLButtonElement;
        copy.type = "button";
        copy.textContent = t("ui.m096");
        copy.onclick = () => state.deviceLogin && handlers.onCopyText(state.deviceLogin.userCode);
        const codeUrl = el("small");
        codeUrl.textContent = state.deviceLogin.verificationUrl;
        codeBox.append(codeValue, copy, codeUrl);
        accountCard.append(codeBox);
      }
      accountGroup.append(accountLabel, accountCard);
      body.append(accountGroup);
    } finally { if (localizing) patchLocalizedContent(originalBody, body); }
  }

  /* ---- 全量绘制入口（骨架复用）---- */

  function renderWork(): void {
    root.querySelector<HTMLElement>("#cxaSettingsFrame")?.remove();
    workspace.style.display = "";
    // 冷启动时官方 runtime 还在恢复持久账号。只有 account/read 已明确返回
    // 未登录后才显示授权页，不能把一次暂时未读到状态画成“又要登录”。
    // 内核缺失时账号不可读是必然，显示的是修复引导而不是登录页。
    authOverlay.classList.toggle(
      "show",
      !state.logged && !state.loading && !state.runtimeMissing,
    );
    renderTaskList();
    renderHeaderMeta();
    renderContextChips();
    renderThread();
    renderInspector();
    composeInput.disabled = !state.selectedId || Boolean(state.detailLoading);
    renderComposeControls();
    // 未选工作文件夹时输入框是禁用的：占位必须解释“为什么不能输入”，
    // 否则只剩一个无反应的灰框（CODEXAPP-02 UX）。详情加载是暂态，仍用常规占位。
    composeInput.placeholder = !state.selectedId && !state.detailLoading
      ? t("ui.m181")
      : state.newWorkMode
        ? t("ui.m002")
        : t("ui.m001");
  }

  function replaceSelectOptions(
    select: HTMLSelectElement,
    rows: Array<{ value: string; label: string }>,
    selected: string | undefined,
  ): void {
    const signature = rows.map((row) => `${row.value}\u0000${row.label}`).join("\u0001");
    if (localizing) {
      // Locale changes only option labels; do not reset a pending selection.
      for (const option of Array.from(select.options)) {
        const row = rows.find(item => item.value === option.value);
        if (row) option.textContent = row.label;
      }
      select.dataset.signature = signature;
      return;
    }
    if (select.dataset.signature !== signature) {
      select.replaceChildren(...rows.map((row) => {
        const option = el("option") as HTMLOptionElement;
        option.value = row.value;
        option.textContent = row.label;
        return option;
      }));
      select.dataset.signature = signature;
    }
    if (!localizing && selected && rows.some((row) => row.value === selected)) select.value = selected;
  }

  function renderComposeControls(): void {
    replaceSelectOptions(
      modelSelect,
      state.models.map((model) => ({ value: model.id, label: model.displayName })),
      state.selectedModel,
    );
    const model = state.models.find((entry) => entry.id === state.selectedModel);
    replaceSelectOptions(
      effortSelect,
      (model?.efforts ?? []).map((entry) => ({ value: entry.value, label: t(`effort.${entry.value}`) })),
      state.selectedEffort,
    );
    const active = Boolean(state.detail?.running);
    modelSelect.disabled = active || composeBusy || state.models.length === 0;
    effortSelect.disabled = active || composeBusy || !model || model.efforts.length === 0;
    // 模式对「本回合及后续回合」生效，活动 turn 期间锁定当前值。locale 刷新
    // （localizing pass）只换 option 文案，不回写 value——否则会吃掉尚未投影的
    // 用户选中（与 effort 选择器同一条纪律）。
    if (!localizing) modeSelect.value = state.selectedMode ?? "plan";
    modeSelect.disabled = active || composeBusy;
    const usage = state.usage;
    const usageParts: string[] = [];
    if (usage?.primaryUsedPercent !== undefined) {
      usageParts.push(t("ui.m168", { p0: Math.round(usage.primaryUsedPercent) }));
    }
    if (usage?.lifetimeTokens !== undefined) {
      usageParts.push(t("ui.m166", { p0: Math.round(usage.lifetimeTokens).toLocaleString(currentLocale()) }));
    }
    usageLabel.textContent = active
      ? [t("ui.m097"), t("ui.m098"), ...usageParts].join(" · ")
      : usageParts.join(" · ");
    usageLabel.title = usageParts.join(" · ");
    // 宽限占位（firstTurnGrace）是只读展示：占位没有 activeTurnId，停止与
    // 追加发送必然失败（m154/m153）并进 Host 错误通道；窗口内隐藏/禁用这两个
    // 入口，权威详情落地后恢复，不新增失败上报路径。
    const graceHold = Boolean(state.firstTurnGrace);
    interruptButton.hidden = !active || graceHold;
    interruptButton.disabled = interruptBusy;
    sendButton.title = active && !graceHold ? t("ui.m099") : t("ui.m026");
    sendButton.setAttribute("aria-label", sendButton.title);
    sendButton.disabled =
      composeBusy || Boolean(state.detailLoading) || graceHold ||
      composeInput.value.trim().length === 0 || !state.selectedId;
  }

  function refreshStaticText(): void {
    newButton.title = t("ui.m021");
    inspectToggle.title = t("ui.m022");
    modelSelect.title = t("ui.m023");
    effortSelect.title = t("ui.m024");
    modeSelect.title = t("ui.m182");
    for (const mode of TURN_MODES) {
      const option = modeSelect.querySelector<HTMLOptionElement>(`option[value="${mode}"]`);
      if (option) option.textContent = t(`mode.${mode}`);
    }
    interruptButton.title = t("ui.m025");
    inspectorTitle.textContent = t("ui.m027");
    inspectorSub.textContent = t("ui.m004");
    inspectorClose.title = t("ui.m028");
    authHeading.textContent = t("ui.m005");
    authBody.textContent = t("ui.m006");
    authGo.textContent = t("ui.m009");
    searchInput.placeholder = t("ui.m003");
    inspectToggle.title = inspectorOff ? t("ui.m022") : t("ui.m028");
    modelSelect.setAttribute("aria-label", modelSelect.title);
    effortSelect.setAttribute("aria-label", effortSelect.title);
    modeSelect.setAttribute("aria-label", modeSelect.title);
    interruptButton.setAttribute("aria-label", interruptButton.title);
    inspectorClose.setAttribute("aria-label", inspectorClose.title);
    const tabKeys = ["ui.m029", "ui.m030", "ui.m031"];
    tabButtons.forEach((button, index) => { button.textContent = t(tabKeys[index]!); });
    const alt = authAlt.cloneNode(false) as HTMLElement;
    alt.append(document.createTextNode(t("ui.m007")), el("br"), document.createTextNode(t("ui.m008")));
    patchLocalizedContent(authAlt, alt);
    { const node = root.querySelector<HTMLElement>("#cxaSettingsFrame .voice-settings-intro-title");
      if (node) node.textContent = t("ui.m010"); }
    { const node = root.querySelector<HTMLElement>("#cxaSettingsFrame .voice-settings-intro-sub");
      if (node) node.textContent = t("ui.m011"); }
    const back = root.querySelector<HTMLElement>(".cxa-settings-back");
    if (back?.lastChild?.nodeType === 3) back.lastChild.nodeValue = t("ui.m071");
  }

  function render(): void {
    if (disposed) return;
    if (state.view === "settings") renderSettings();
    else renderWork();
  }

  /* ---- 骨架级事件（一次性绑定）---- */

  newButton.addEventListener("click", () => {
    // 目录选择取消或 thread/start 失败时，不伪造“新工作”状态。
    // main.ts 只有拿到真实 thread.id 后才把 newWorkMode 切为 true。
    handlers.onNewWork();
  });

  searchInput.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(renderTaskList, 60);
  });

  taskListBox.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    const folder = target.closest<HTMLElement>("[data-cxa-folder]");
    if (folder) {
      const dir = folder.dataset.cxaFolder!;
      if (collapsedFolders.has(dir)) collapsedFolders.delete(dir);
      else collapsedFolders.add(dir);
      renderTaskList();
      return;
    }
    const task = target.closest<HTMLElement>("[data-cxa-task]");
    if (task) {
      state.newWorkMode = false;
      handlers.onSelectTask(task.dataset.cxaTask!);
    }
  });

  composeInput.addEventListener("input", () => {
    renderComposeControls();
    composeInput.style.height = "auto";
    composeInput.style.height = `${Math.min(composeInput.scrollHeight, 130)}px`;
  });

  const submitCompose = async (): Promise<void> => {
    const text = composeInput.value.trim();
    // 宽限占位期间占位详情没有 activeTurnId，发送必然失败：与按钮禁用同源拦截。
    if (!text || !state.selectedId || composeBusy || state.detailLoading || state.firstTurnGrace) {
      return;
    }
    composeBusy = true;
    renderComposeControls();
    try {
      await handlers.onSend(text);
      composeInput.value = "";
      composeInput.style.height = "";
    } catch {
      view.toast(message("ui.m100"));
    } finally {
      composeBusy = false;
      renderComposeControls();
    }
  };

  sendButton.addEventListener("click", () => void submitCompose());
  composeInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submitCompose();
    }
  });

  modelSelect.addEventListener("change", () => handlers.onSelectModel(modelSelect.value));
  effortSelect.addEventListener("change", () => {
    handlers.onSelectEffort(effortSelect.value as ReasoningEffort);
  });
  modeSelect.addEventListener("change", () => {
    handlers.onSelectMode(modeSelect.value as CodexTurnMode);
  });
  interruptButton.addEventListener("click", () => {
    // 宽限占位期间没有可停止的真实 turn id：按钮隐藏后再兜底一层，避免任何
    // 程序化触发走进必然失败的 interrupt 链路。
    if (interruptBusy || !state.detail?.running || state.firstTurnGrace) return;
    interruptBusy = true;
    renderComposeControls();
    void handlers.onInterrupt()
      .catch(() => view.toast(message("ui.m101")))
      .finally(() => {
        interruptBusy = false;
        renderComposeControls();
      });
  });

  const setInspectorOff = (next: boolean): void => {
    inspectorOff = next;
    root.classList.toggle("inspector-off", inspectorOff);
    inspectToggle.classList.toggle("on", !inspectorOff);
    inspectToggle.setAttribute("aria-expanded", String(!inspectorOff));
    inspectToggle.title = inspectorOff ? t("ui.m022") : t("ui.m028");
    inspector.setAttribute("aria-hidden", String(inspectorOff));
    inspector.inert = inspectorOff;
  };

  inspectToggle.addEventListener("click", () => {
    setInspectorOff(!inspectorOff);
  });
  inspectorClose.addEventListener("click", () => setInspectorOff(true));

  tabBar.addEventListener("click", (event) => {
    const tab = (event.target as HTMLElement).closest<HTMLElement>("[data-cxa-tab]");
    if (!tab) return;
    inspectorTab = tab.dataset.cxaTab as typeof inspectorTab;
    renderInspector();
  });

  authGo.addEventListener("click", () => handlers.onLoginBrowser());

  const view: CxaView = {
    update(patch) {
      const shouldFocusNewWork = patch.newWorkMode === true && !state.newWorkMode;
      if (patch.userInputs) {
        const activeRequestIds = new Set(patch.userInputs.map((request) => request.requestId));
        for (const requestId of questionDrafts.keys()) {
          if (!activeRequestIds.has(requestId)) questionDrafts.delete(requestId);
        }
      }
      Object.assign(state, patch);
      render();
      if (shouldFocusNewWork) composeInput.focus();
    },
    refreshLocale(locale, patch) {
      if (disposed) return;
      setLocale(locale);
      if (patch) Object.assign(state, patch);
      localizing = true;
      try { refreshStaticText(); render(); }
      finally { localizing = false; }
      if (toastBox.classList.contains("show")) toastBox.textContent = resolveText(toastMessage);
    },
    snapshot: () => ({ ...state }),
    toast(message) {
      if (disposed) return;
      clearTimeout(toastTimer);
      toastMessage = message;
      toastBox.textContent = resolveText(message);
      toastBox.classList.add("show");
      toastTimer = setTimeout(() => toastBox.classList.remove("show"), 2200);
    },
    destroy() {
      disposed = true;
      clearTimeout(toastTimer);
      clearTimeout(searchTimer);
      root.replaceChildren();
      root.classList.remove("cxa-page", "inspector-off");
    },
  };

  render();
  return view;
}
