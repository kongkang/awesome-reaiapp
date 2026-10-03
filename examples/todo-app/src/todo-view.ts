import {
  button,
  element,
  mountAgentComposer,
  mountConversationStream,
  type Agent,
  type StreamItem,
  type StreamMsg,
} from "@reai/agent-ui";
import {
  acceptSuggestion,
  addLocalDays,
  addChildNode,
  allChildrenDone,
  childrenOf,
  conversationKeyForTask,
  dismissSuggestion,
  futureDateKeys,
  localDateKey,
  markOccurrence,
  overdueNodes,
  parseLocalDateKey,
  pendingSuggestions,
  timelineForDate,
  undatedNodes,
  updateNode,
  type ConversationKey,
  type TodoDisplayItem,
  type TodoNode,
  type TodoState,
} from "./todo-model";
import type { TodoStateReducer } from "./state-coordinator";

export type TodoIntent =
  | { type: "new-task" }
  | { type: "open-assistant"; conversationKey?: ConversationKey }
  | { type: "talk-to-assistant"; conversationKey?: ConversationKey };

interface TodoOptions {
  state: TodoState;
  now?: () => Date;
  updateState(reducer: TodoStateReducer): Promise<TodoState>;
  enqueueAnalysis(node: TodoNode, supplement?: string): void;
  answerAgent?(node: TodoNode, text: string): void | Promise<void>;
  onPersistenceError?(cause: unknown): void;
  idFactory?: () => string;
}

export interface TodoView {
  setState(state: TodoState): void;
  applyIntent(intent?: TodoIntent): void;
  /** 硬件 New 键 / new-task Intent 的落点：打开「新增一件事」专注层。 */
  openComposer(): void;
  dispose(): void;
}

const WEEKDAYS = ["一", "二", "三", "四", "五", "六", "日"];

/** `Date.getDay()`（0=周日）下标直取，供页头「周X」用（对稿 tdWd）；跟上面
 * 月历表头的 WEEKDAYS（周一起、不带「周」字）是两套不同用途，不能共用。 */
const WEEKDAY_FULL = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

/** 「M月D日」标准格式（对稿 tdMd）。formatDay / dayLabel 的月日部分复用它。 */
function monthDayLabel(date: Date): string {
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

/** 「周X」标准格式（对稿 tdWd）。 */
function weekdayFullLabel(date: Date): string {
  return WEEKDAY_FULL[date.getDay()];
}

function tbcTag(): HTMLElement {
  const tag = element("span", "tbc-option-tag");
  tag.dataset.tbcId = "tbc.todo-agent-flow";
  tag.textContent = "TBC";
  tag.title = "AI 分析与追问当前由 Mock workflow 驱动";
  tag.setAttribute("aria-label", "TBC：AI 分析与追问当前由 Mock workflow 驱动");
  return tag;
}

/** 「日程 / 列表」两档视角（对稿 tdViewSeg）：日程=按天滚动的流，列表=root 事情的集合。 */
type TodoViewMode = "schedule" | "list";
const VIEW_MODES: ReadonlyArray<{ mode: TodoViewMode; label: string }> = [
  { mode: "schedule", label: "日程" },
  { mode: "list", label: "列表" },
];

/**
 * 新增专注层里的可选属性（V1.3）。默认只是一排图标，点哪个才展开哪一条——
 * 补细节是可选动作，不是填表义务；展开后留空视同没说过，不写入空字段。
 */
const COMPOSE_ATTRS = [
  { key: "who", icon: "users", label: "谁", placeholder: "和谁一起？" },
  { key: "where", icon: "map-pin", label: "地点", placeholder: "在哪儿？" },
  { key: "when", icon: "clock", label: "时间", placeholder: "什么时候？没说也行，助理会问" },
  { key: "steps", icon: "list-todo", label: "步骤", placeholder: "分几步做？用逗号隔开" },
] as const satisfies ReadonlyArray<{ key: string; icon: TodoIconName; label: string; placeholder: string }>;

type ComposeAttrKey = (typeof COMPOSE_ATTRS)[number]["key"];

type TodoIconName =
  | "sparkles" | "x" | "chevron" | "chevron-left" | "plus" | "check"
  | "mic" | "send" | "users" | "map-pin" | "clock" | "list-todo"
  | "calendar" | "repeat" | "flag" | "alert-circle";

function todoIcon(name: TodoIconName, size = 16): SVGSVGElement {
  const paths: Record<TodoIconName, string> = {
    sparkles: '<path d="m12 3 1.3 4.2L17.5 8.5l-4.2 1.3L12 14l-1.3-4.2-4.2-1.3 4.2-1.3Z"></path><path d="m18 14 .7 2.3L21 17l-2.3.7L18 20l-.7-2.3L15 17l2.3-.7Z"></path>',
    x: '<path d="m6 6 12 12M18 6 6 18"></path>',
    chevron: '<path d="m9 18 6-6-6-6"></path>',
    "chevron-left": '<path d="m15 18-6-6 6-6"></path>',
    plus: '<path d="M12 5v14M5 12h14"></path>',
    check: '<path d="M20 6 9 17l-5-5"></path>',
    mic: '<rect x="9" y="2" width="6" height="12" rx="3"></rect><path d="M19 11a7 7 0 0 1-14 0"></path><path d="M12 18v4"></path>',
    send: '<path d="M4 12 20 4l-3 8 3 8Z"></path>',
    users: '<path d="M16 20v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M22 20v-2a4 4 0 0 0-3-3.9"></path>',
    "map-pin": '<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"></path><circle cx="12" cy="10" r="3"></circle>',
    clock: '<circle cx="12" cy="12" r="9"></circle><path d="M12 7v5l3 2"></path>',
    "list-todo": '<path d="M9 6h12M9 12h12M9 18h12"></path><circle cx="4" cy="6" r="1.4"></circle><circle cx="4" cy="12" r="1.4"></circle><circle cx="4" cy="18" r="1.4"></circle>',
    calendar: '<rect x="3" y="4" width="18" height="17" rx="2"></rect><path d="M16 2v4M8 2v4M3 10h18"></path>',
    repeat: '<path d="m17 2 4 4-4 4"></path><path d="M3 11v-1a4 4 0 0 1 4-4h14"></path><path d="m7 22-4-4 4-4"></path><path d="M21 13v1a4 4 0 0 1-4 4H3"></path>',
    flag: '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"></path><path d="M4 22v-7"></path>',
    "alert-circle": '<circle cx="12" cy="12" r="9"></circle><path d="M12 8v4"></path><path d="M12 16h.01"></path>',
  };
  const node = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  node.setAttribute("viewBox", "0 0 24 24");
  node.setAttribute("width", String(size));
  node.setAttribute("height", String(size));
  node.setAttribute("fill", "none");
  node.setAttribute("stroke", "currentColor");
  node.setAttribute("stroke-width", "2");
  node.setAttribute("stroke-linecap", "round");
  node.setAttribute("stroke-linejoin", "round");
  node.innerHTML = paths[name];
  node.setAttribute("aria-hidden", "true");
  return node;
}

function formatDay(dateKey: string, today: string): { eyebrow: string; title: string } {
  const date = new Date(`${dateKey}T12:00:00`);
  const label = new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", weekday: "long" }).format(date);
  return dateKey === today ? { eyebrow: label, title: "今天" } : { eyebrow: label, title: monthDayLabel(date) };
}

/** 列表视角里日期 chip 的措辞（对稿 tdDayLabel）：近三天说人话，其余给「N月D日」。 */
function dayLabel(dateKey: string, today: string): string {
  if (dateKey === today) return "今天";
  if (dateKey === addLocalDays(today, 1)) return "明天";
  if (dateKey === addLocalDays(today, 2)) return "后天";
  return monthDayLabel(parseLocalDateKey(dateKey));
}

function formatTime(node: TodoNode): string | undefined {
  if (!node.startAt) return undefined;
  const start = new Date(node.startAt);
  const formatter = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
  if (!node.endAt) return formatter.format(start);
  return `${formatter.format(start)}–${formatter.format(new Date(node.endAt))}`;
}

function analysisLabel(node: TodoNode): string | undefined {
  if (node.analysis.status === "queued") return "待整理";
  if (node.analysis.status === "processing") return "正在整理";
  if (node.analysis.status === "needs-input") return "需要确认";
  return undefined;
}

function isConversationKey(value: string | undefined): value is ConversationKey {
  return value === "app" || Boolean(value?.startsWith("task:") && value.length > 5);
}

function taskIdFromConversation(key: ConversationKey): string | undefined {
  return key.startsWith("task:") ? key.slice(5) : undefined;
}

export function mountTodoView(root: HTMLElement, options: TodoOptions): TodoView {
  let state = options.state;
  const now = options.now ?? (() => new Date());
  const idFactory = options.idFactory ?? (() => crypto.randomUUID());
  let disposed = false;
  let overdueExpanded = false;
  let selectedDate = localDateKey(now());
  /* 视角是看日程的方式，不是日程数据本身：跟稿里 TD.view 一样只活在会话内，
     不写进 TodoState——换一次视角不该动磁盘上的档案。 */
  let viewMode: TodoViewMode = "schedule";
  // 离开日程档那一刻的滚动位置（切回时还原，对稿 tdViewSeg 不重渲日程流）。
  let agendaScrollMemory = 0;
  let calendarMonth = new Date(`${selectedDate}T12:00:00`);
  let detailTaskId: string | undefined;
  let agentOpen = false;
  let agentTaskId: string | undefined;
  let agentListening = false;
  /** 助理是「自己来找人」的那一档：不提升详情、不抢焦点、不挡住日程流。 */
  let agentAside = false;
  let suggestionsExpanded = false;
  let statusMessage = "";
  let composeOpen = false;
  let composeDraft = "";
  /** 语音是这块键盘的主路径：专注层一打开就在听，一敲键盘才转打字。 */
  let composeListening = true;
  const composeAttrsOpen = new Set<ComposeAttrKey>();
  const composeAttrDrafts = new Map<ComposeAttrKey, string>();
  const subtaskDrafts = new Map<string, string>();
  const agentDrafts: Partial<Record<ConversationKey, string>> = {};
  const asideAskedTaskIds = new Set<string>();
  let pendingAsideTaskId: string | undefined;
  let restoreTaskId: string | undefined;
  let composerDispose = () => {};

  const runUpdate = async (reducer: TodoStateReducer): Promise<TodoState | undefined> => {
    try {
      return await options.updateState(reducer);
    } catch (cause) {
      statusMessage = "保存失败，请重试";
      options.onPersistenceError?.(cause);
      if (!disposed) render();
      return undefined;
    }
  };

  /** 焦点回到来源行：日程流里是 `.todo-task-open`，列表档里是 `.todo-list-open`。 */
  function focusTaskRow(taskId: string) {
    const escaped = CSS.escape(taskId);
    root.querySelector<HTMLElement>(`[data-task-id="${escaped}"] .todo-task-open, [data-task-id="${escaped}"] .todo-list-open`)?.focus();
  }

  const closeAgent = () => {
    const wasAside = agentAside;
    const previousTaskId = agentTaskId;
    agentOpen = false;
    agentListening = false;
    agentAside = false;
    agentTaskId = undefined;
    render();
    // aside 是助理自己冒出来的，用户根本没把焦点交出去；收起时也不该把焦点搬走。
    if (!wasAside && previousTaskId) focusTaskRow(previousTaskId);
  };

  const closeDetail = () => {
    restoreTaskId = detailTaskId;
    detailTaskId = undefined;
    suggestionsExpanded = false;
    render();
    if (restoreTaskId) focusTaskRow(restoreTaskId);
  };

  const modalFocusRoot = (): HTMLElement | undefined => {
    if (composeOpen) return root.querySelector<HTMLElement>(".todo-compose-card") ?? undefined;
    // aside 助理不是模态：它不能把 Tab 圈进自己，否则「不理它」就变成了「先退出来再说」。
    if (agentOpen && !agentAside && !agentTaskId) return root.querySelector<HTMLElement>(".todo-agent-drawer") ?? undefined;
    if (!agentOpen && detailTaskId) return root.querySelector<HTMLElement>(".todo-detail-drawer") ?? undefined;
    return undefined;
  };

  const trapFocus = (event: KeyboardEvent) => {
    const container = modalFocusRoot();
    if (!container) return;
    const focusable = Array.from(container.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
    )).filter((candidate) => !candidate.hasAttribute("hidden") && candidate.getAttribute("aria-hidden") !== "true");
    if (!focusable.length) return;
    const active = document.activeElement as HTMLElement | null;
    const first = focusable[0]!;
    const last = focusable.at(-1)!;
    if (!active || !container.contains(active)) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    } else if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const onDocumentKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Tab") {
      trapFocus(event);
      return;
    }
    // Esc 层级：新增专注层 > 助理 > 详情。逐级后退，一次只关一层。
    if (event.key === "Escape") {
      if (composeOpen) {
        event.preventDefault();
        closeCompose();
      } else if (agentOpen) {
        event.preventDefault();
        closeAgent();
      } else if (detailTaskId) {
        event.preventDefault();
        closeDetail();
      }
    }
  };
  document.addEventListener("keydown", onDocumentKeyDown);

  function taskById(taskId: string | undefined): TodoNode | undefined {
    return taskId ? state.nodes.find((node) => node.id === taskId) : undefined;
  }

  function openDetail(taskId: string) {
    detailTaskId = taskId;
    restoreTaskId = taskId;
    suggestionsExpanded = false;
    render();
    root.querySelector<HTMLElement>(".todo-detail-drawer")?.focus();
  }

  /**
   * `aside` 表示「助理主动来找人」，方向和「人去找助理」相反，落地也必须不同：
   * 人从一件事唤醒助理，说明他正看着这件事，把详情提升为主内容是顺着他的注意力走；
   * 助理自己冒出来追问时，人刚说完一句话正要回到日程流，这时顶开详情、抢走焦点，
   * 「不回也没事」就不再是零代价了。
   */
  function openAgent(taskId?: string, options: { listening?: boolean; aside?: boolean } = {}) {
    agentTaskId = taskId;
    agentOpen = true;
    agentListening = options.listening ?? false;
    agentAside = options.aside ?? false;
    if (taskId && !agentAside) detailTaskId = taskId;
    render();
    if (!agentAside) root.querySelector<HTMLInputElement>(".agent-composer-input")?.focus();
  }

  function openCompose() {
    if (composeOpen) return;
    composeOpen = true;
    composeListening = true;
    composeDraft = "";
    composeAttrsOpen.clear();
    composeAttrDrafts.clear();
    statusMessage = "";
    render();
    root.querySelector<HTMLInputElement>("#todo-new-task")?.focus();
  }

  function closeCompose() {
    if (!composeOpen) return;
    composeOpen = false;
    composeDraft = "";
    composeAttrsOpen.clear();
    composeAttrDrafts.clear();
    render();
    // 页头新增按钮已撤（B6-27）：焦点归到仍存在的视角切换档（对稿 tdViewSeg）。
    root.querySelector<HTMLElement>(".todo-view-seg-btn.is-active")?.focus();
    // 专注层开着的时候压下来的追问，等这一层让开再问。
    flushPendingAside();
  }

  /**
   * 助理主动追问的触发点：某件事的分析刚落到 needs-input。
   * 只在**状态跃迁**时问一次——从磁盘读出来就已经是 needs-input 的旧事项不算，
   * 一开页面就弹助理是另一种打扰。
   */
  function noticeNeedsInput(previous: TodoState, next: TodoState) {
    for (const node of next.nodes) {
      if (node.analysis.status !== "needs-input" || asideAskedTaskIds.has(node.id)) continue;
      const before = previous.nodes.find((candidate) => candidate.id === node.id);
      if (!before || before.analysis.status === "needs-input") continue;
      asideAskedTaskIds.add(node.id);
      if (composeOpen) { pendingAsideTaskId = node.id; return; }
      openAgent(node.id, { aside: true });
      return;
    }
  }

  function flushPendingAside() {
    const taskId = pendingAsideTaskId;
    pendingAsideTaskId = undefined;
    if (!taskId) return;
    if (taskById(taskId)?.analysis.status !== "needs-input") return;
    openAgent(taskId, { aside: true });
  }

  async function toggleDisplayItem(item: TodoDisplayItem, checked: boolean) {
    if (item.occurrenceId) {
      await runUpdate((current) => markOccurrence(current, item.node.id, item.dateKey, checked, now()));
    } else {
      await runUpdate((current) => updateNode(current, item.node.id, { done: checked }, now()));
    }
  }

  function taskRow(item: TodoDisplayItem, compact = false): HTMLElement {
    const row = element("article", `todo-task-row${item.done ? " is-done" : ""}${compact ? " is-compact" : ""}`);
    row.dataset.taskId = item.node.id;
    const check = element("input", "todo-task-check");
    check.type = "checkbox";
    check.checked = item.done;
    check.setAttribute("aria-label", `${item.done ? "恢复" : "完成"}：${item.node.title}`);
    check.addEventListener("change", () => { void toggleDisplayItem(item, check.checked); });

    const open = button("todo-task-open", "");
    open.type = "button";
    open.addEventListener("click", () => openDetail(item.node.id));
    const main = element("span", "todo-task-main");
    const title = element("strong", "todo-task-title");
    title.textContent = item.node.title;
    const meta = element("span", "todo-task-meta");
    const parts: string[] = [];
    const time = formatTime(item.node);
    if (time) parts.push(time);
    if (item.node.location) parts.push(item.node.location);
    if (item.node.people.length) parts.push(item.node.people.join("、"));
    const childCount = childrenOf(state, item.node.id).length;
    if (childCount) parts.push(`${childCount} 个步骤`);
    meta.textContent = parts.join(" · ") || (item.node.analysis.summary ?? "点击查看详情");
    main.append(title, meta);
    open.appendChild(main);
    const label = analysisLabel(item.node);
    if (label) {
      const status = element("span", `todo-analysis-pill is-${item.node.analysis.status}`);
      status.textContent = label;
      open.appendChild(status);
    } else if (item.node.recurrence) {
      const recurring = element("span", "todo-recurring-pill");
      recurring.textContent = "循环";
      open.appendChild(recurring);
    }
    row.append(check, open);
    return row;
  }

  function agendaSection(dateKey: string, sectionName?: string): HTMLElement {
    const descriptor = formatDay(dateKey, localDateKey(now()));
    const section = element("section", "todo-day-section");
    // 月历点某天要滚到这里来，所以每一组都留一个日期锚点。
    section.dataset.day = dateKey;
    if (sectionName) section.dataset.section = sectionName;
    const header = element("header", "todo-section-heading");
    const copy = element("div");
    const eyebrow = element("p", "todo-section-eyebrow");
    eyebrow.textContent = descriptor.eyebrow;
    const title = element("h2", "todo-section-title");
    title.textContent = descriptor.title;
    copy.append(eyebrow, title);
    const items = timelineForDate(state, dateKey, now());
    const count = element("span", "todo-section-count");
    count.textContent = `${items.filter((item) => !item.done).length} 件待处理`;
    header.append(copy, count);
    const list = element("div", "todo-task-list");
    if (items.length) items.forEach((item) => list.appendChild(taskRow(item)));
    else {
      const empty = element("div", "todo-day-empty");
      const mark = element("span");
      mark.appendChild(todoIcon("check", 16));
      const emptyTitle = element("strong");
      emptyTitle.textContent = "这一天还很轻";
      const emptyHint = element("small");
      emptyHint.textContent = "有新安排时，直接在上面写一句话。";
      empty.append(mark, emptyTitle, emptyHint);
      list.appendChild(empty);
    }
    section.append(header, list);
    return section;
  }

  function overdueArea(): HTMLElement | undefined {
    const items = overdueNodes(state, now());
    if (!items.length) return undefined;
    const area = element("section", "todo-overdue");
    const toggle = button("todo-overdue-toggle", "");
    toggle.setAttribute("aria-expanded", String(overdueExpanded));
    toggle.append(todoIcon("chevron", 14));
    const copy = element("span", "todo-overdue-copy");
    const title = element("strong");
    title.textContent = `${items.length} 件之前的事情还没处理`;
    const hint = element("small");
    hint.textContent = "不催你，只是先放在这里";
    copy.append(title, hint);
    const action = element("span", "todo-overdue-action");
    action.textContent = overdueExpanded ? "收起" : "看看";
    toggle.append(copy, action);
    const panel = element("div", "todo-overdue-panel");
    panel.hidden = !overdueExpanded;
    items.forEach((node) => panel.appendChild(taskRow({ node, dateKey: node.scheduledDate ?? localDateKey(new Date(node.deadlineAt ?? node.startAt ?? node.createdAt)), done: node.done }, true)));
    toggle.addEventListener("click", () => { overdueExpanded = !overdueExpanded; render(); });
    area.append(toggle, panel);
    return area;
  }

  /** 列表视角里 root 事项的排序（对稿 tdRenderList）：没完成的在前，按日期升序，没日期的殿后，再看重要度。 */
  function rootNodesByListOrder(): TodoNode[] {
    return state.nodes.filter((node) => !node.parentId).slice().sort((left, right) => {
      if (left.done !== right.done) return left.done ? 1 : -1;
      const leftDate = left.scheduledDate ?? "9999-12";
      const rightDate = right.scheduledDate ?? "9999-12";
      return leftDate < rightDate ? -1 : leftDate > rightDate ? 1 : right.importance - left.importance;
    });
  }

  /** 列表档「N 件事进行中」的口径：未完成的根任务数（对稿 tdRenderHead），
   * 复用 rootNodesByListOrder() 的 root 过滤，不额外维护第二份统计逻辑。 */
  function incompleteRootCount(): number {
    return rootNodesByListOrder().filter((node) => !node.done).length;
  }

  function listRow(node: TodoNode): HTMLElement {
    const row = element("article", `todo-list-row${node.done ? " is-done" : ""}`);
    row.dataset.taskId = node.id;
    const check = element("input", "todo-task-check");
    check.type = "checkbox";
    check.checked = node.done;
    check.setAttribute("aria-label", `${node.done ? "恢复" : "完成"}：${node.title}`);
    check.addEventListener("change", () => { void runUpdate((current) => updateNode(current, node.id, { done: check.checked }, now())); });

    const open = button("todo-list-open", "");
    open.type = "button";
    open.addEventListener("click", () => openDetail(node.id));
    const main = element("span", "todo-list-main");
    const title = element("strong", "todo-list-title");
    title.textContent = node.title;
    main.appendChild(title);
    const today = localDateKey(now());
    const chips: Array<{ icon?: TodoIconName; label: string; tone?: "accent" | "alert" }> = [];
    if (node.recurrence) chips.push({ icon: "repeat", label: "长期 · 每天" });
    else if (node.scheduledDate) chips.push({ icon: "calendar", label: dayLabel(node.scheduledDate, today) });
    else chips.push({ label: "未定日期" });
    const suggestionCount = pendingSuggestions(state, node.id).length;
    if (suggestionCount) chips.push({ icon: "sparkles", label: `${suggestionCount} 条建议`, tone: "accent" });
    if (node.analysis.status === "needs-input") chips.push({ icon: "alert-circle", label: "等你补充", tone: "alert" });
    if (chips.length || node.importance >= 80) {
      const meta = element("span", "todo-list-meta");
      chips.forEach(({ icon, label, tone }) => {
        const chip = element("span", `todo-list-chip${tone === "accent" ? " is-accent" : ""}${tone === "alert" ? " is-alert" : ""}`);
        if (icon) chip.appendChild(todoIcon(icon, 14));
        const text = element("span");
        text.textContent = label;
        chip.appendChild(text);
        meta.appendChild(chip);
      });
      if (node.importance >= 80) {
        const flag = element("span", "todo-list-flag");
        flag.title = "重要";
        flag.appendChild(todoIcon("flag", 14));
        meta.appendChild(flag);
      }
      main.appendChild(meta);
    }
    open.appendChild(main);
    row.append(check, open);
    const kids = childrenOf(state, node.id);
    if (kids.length) {
      const doneCount = kids.filter((kid) => kid.done).length;
      const progress = element("span", "todo-list-progress");
      const bar = element("span", "todo-list-progress-bar");
      const fill = element("i");
      fill.style.width = `${Math.round((doneCount / kids.length) * 100)}%`;
      bar.appendChild(fill);
      const count = element("span", "todo-list-progress-count");
      count.textContent = `${doneCount}/${kids.length}`;
      progress.append(bar, count);
      row.appendChild(progress);
    }
    return row;
  }

  /**
   * 列表视角（对稿 tdList）：root 事情的集合，回答「我手上总共有多少件事」（§6.1）。
   * 日程流回答「接下来怎么过」，这里回答「总共背着几件」——两个问题都常被问到，
   * 所以用一档切换而不是两页。
   */
  function listView(): HTMLElement {
    const list = element("div", "todo-list-view");
    const roots = rootNodesByListOrder();
    if (!roots.length) {
      const empty = element("p", "todo-list-empty");
      empty.textContent = "还没有任何事。";
      list.appendChild(empty);
      return list;
    }
    roots.forEach((node) => list.appendChild(listRow(node)));
    return list;
  }

  function createFromCompose() {
    const value = composeDraft.trim();
    if (!value) return;
    // 展开了却留空的属性当作没说过——用户看了一眼决定不补，不该变成空字段。
    const filled = (key: ComposeAttrKey): string | undefined => {
      if (!composeAttrsOpen.has(key)) return undefined;
      return composeAttrDrafts.get(key)?.trim() || undefined;
    };
    const who = filled("who");
    const where = filled("where");
    const when = filled("when");
    const steps = filled("steps");
    const createdAt = now();
    const node: TodoNode = {
      id: idFactory(),
      title: value,
      done: false,
      createdAt: createdAt.toISOString(),
      updatedAt: createdAt.toISOString(),
      people: who ? who.split(/[,，、\s]+/).filter(Boolean) : [],
      ...(where ? { location: where } : {}),
      importance: 50,
      reminder: { enabled: false },
      conflicts: [],
      analysis: { status: "queued", summary: "已收下，等待日程助理整理" },
    };
    const children = (steps ?? "").split(/[,，;；]+/).map((step) => step.trim()).filter(Boolean).map((title) => ({
      id: idFactory(),
      title,
      parentId: node.id,
      now: createdAt,
      analysis: { status: "queued" as const, summary: "等待日程助理整理" },
    }));
    closeCompose();
    void runUpdate((current) => {
      let next = { ...current, nodes: [...current.nodes, node] };
      for (const child of children) next = addChildNode(next, node.id, child);
      return next;
    }).then((saved) => {
      if (!saved || disposed) return;
      /* 不报「已收下」：事项已经带着「待整理」出现在日程流里，那就是收下的证据。
         再挂一行永不消失的提示只是噪音。这里只留失败时的话——那时候事情**没**进去，
         不说就真的丢了。 */
      statusMessage = "";
      // 属性行是这句话的补充，不改标题——标题永远是用户自己说的那句。
      const supplement = [when, where ? `在${where}` : undefined].filter(Boolean).join("，");
      options.enqueueAnalysis(node, supplement || undefined);
      for (const child of children) {
        const persisted = saved.nodes.find((candidate) => candidate.id === child.id);
        if (persisted) options.enqueueAnalysis(persisted);
      }
      render();
    });
  }

  /**
   * 新增 = 整页专注层（V1.3）。原来这是头部一个常驻输入框：一天用不了几次，却天天
   * 占着两行高度。现在入口收成一颗，点开才铺开——常驻的重量换成按需的专注。
   *
   * 蒙版只盖住日程 App 自己这一页。Host 的侧栏和标题条不归 App 管，插件也画不到
   * 那上面去；「此刻只有这件事重要」由页内完成。
   */
  function composeLayer(): HTMLElement {
    const layer = element("div", "todo-compose-layer");
    const scrim = button("todo-compose-scrim", "", "取消新增");
    scrim.addEventListener("click", closeCompose);
    const card = element("div", "todo-compose-card");
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-modal", "true");
    card.setAttribute("aria-labelledby", "todo-compose-hint");

    const hint = element("p", `todo-compose-hint${composeListening ? " is-listening" : ""}`);
    hint.id = "todo-compose-hint";
    const dot = element("span", "todo-compose-dot");
    const hintText = element("span");
    hintText.textContent = composeListening ? "正在听，说一句就行" : "已停止收音，直接打字就行";
    hint.append(dot, hintText);

    const form = element("form", "todo-compose-form");
    const mic = button(`todo-compose-mic${composeListening ? " is-on" : ""}`, "", composeListening ? "停止收音" : "开始收音");
    mic.type = "button";
    mic.setAttribute("aria-pressed", String(composeListening));
    mic.appendChild(todoIcon("mic", 14));
    mic.addEventListener("click", () => { composeListening = !composeListening; render(); });
    const input = element("input", "todo-compose-input");
    input.id = "todo-new-task";
    input.name = "todo-title";
    input.placeholder = "比如「下周三下午和小李去仁和医院看病」";
    input.autocomplete = "off";
    input.setAttribute("aria-label", "新日程内容");
    input.dataset.todoFocusKey = "compose";
    input.value = composeDraft;
    const submit = button("todo-compose-submit", "", "收下");
    submit.type = "submit";
    submit.disabled = !composeDraft.trim();
    submit.appendChild(todoIcon("send", 14));
    input.addEventListener("input", () => {
      composeDraft = input.value;
      // 一敲字就停止收音：人已经用行动选了打字，不必再问一次。
      if (composeListening) {
        composeListening = false;
        render();
      } else {
        submit.disabled = !composeDraft.trim();
      }
    });
    form.append(mic, input, submit);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      createFromCompose();
    });

    const attrs = element("div", "todo-compose-attrs");
    COMPOSE_ATTRS.forEach((attr) => {
      const open = composeAttrsOpen.has(attr.key);
      const toggle = button(`todo-compose-attr${open ? " is-on" : ""}`, "");
      toggle.type = "button";
      toggle.setAttribute("aria-pressed", String(open));
      toggle.dataset.attr = attr.key;
      const label = element("span");
      label.textContent = attr.label;
      toggle.append(todoIcon(attr.icon, 14), label);
      toggle.addEventListener("click", () => {
        if (composeAttrsOpen.has(attr.key)) {
          composeAttrsOpen.delete(attr.key);
          composeAttrDrafts.delete(attr.key);
        } else {
          composeAttrsOpen.add(attr.key);
        }
        render();
        root.querySelector<HTMLInputElement>(`[data-todo-focus-key="compose:${attr.key}"]`)?.focus();
      });
      attrs.appendChild(toggle);
    });

    const fields = element("div", "todo-compose-fields");
    COMPOSE_ATTRS.filter((attr) => composeAttrsOpen.has(attr.key)).forEach((attr) => {
      const row = element("div", "todo-compose-field");
      row.dataset.field = attr.key;
      const label = element("label", "todo-compose-field-label");
      label.textContent = attr.label;
      label.htmlFor = `todo-compose-${attr.key}`;
      const field = element("input");
      field.id = `todo-compose-${attr.key}`;
      field.placeholder = attr.placeholder;
      field.autocomplete = "off";
      field.dataset.todoFocusKey = `compose:${attr.key}`;
      field.value = composeAttrDrafts.get(attr.key) ?? "";
      field.addEventListener("input", () => { composeAttrDrafts.set(attr.key, field.value); });
      field.addEventListener("keydown", (event) => {
        // 属性行里回车 = 收下，跟主输入框一个语义，不用回去点按钮。
        if (event.key === "Enter" && !event.isComposing) {
          event.preventDefault();
          createFromCompose();
        }
      });
      row.append(label, field);
      fields.appendChild(row);
    });

    const foot = element("p", "todo-compose-foot");
    const footCopy = element("span");
    footCopy.textContent = "说完直接收下，缺的信息助理会来问";
    const footKeys = element("span", "todo-compose-keys");
    footKeys.textContent = "Enter 收下 · Esc 取消";
    foot.append(footCopy, footKeys);

    card.append(hint, form, attrs, fields, foot);
    layer.append(scrim, card);
    return layer;
  }

  /**
   * 头部只剩两样东西：左侧身份与右侧操作，同处 y=44 起的紧凑页头。
   * 操作是「新增」、它旁边那颗小一号的助理图标，以及最外侧「日程 / 列表」
   * 视角切换 seg——一个把事收下，一个帮你想清楚，一个换一种看法。
   * 原来这一行还挂着日历展开、通知铃铛两颗常驻按钮，V1.3 全部撤掉
   * （开发指南「界面克制」1 与 2）。
   *
   * plugin-development-v1 §3.1：0–44px 只归 Host；页头用统一变量从 y=44 开始，
   * 自身没有 padding-top，也不把旧顶部间距叠加到安全线。
   *
   * 标题/副标逐字对稿 tdRenderHead（design/VoiceType_UI_Designs.html 约
   * 15975–15985 行）：日程档「今天」+「M月D日 · 周X · 今日优先」（用真实的
   * 今天 now()，不是 selectedDate）；列表档「列表」+「N 件事进行中 · 点一件
   * 进去看或管」，N 口径同列表视角未完成根任务数（incompleteRootCount()）。
   * 旧文案「日程」「先把今天过好」已撤，避免跟面包屑的插件名重复。每次
   * render() 都重建，只按 viewMode 取值，不影响视角切换/滚动记忆逻辑。
   */
  function topbar(): HTMLElement {
    const header = element("header", "todo-topbar");
    const heading = element("div", "todo-topbar-heading");
    const mark = element("span", "todo-identity-mark");
    mark.appendChild(todoIcon("check", 20));
    const copy = element("div");
    const title = element("h1");
    const subtitle = element("p");
    if (viewMode === "list") {
      title.textContent = "列表";
      subtitle.textContent = `${incompleteRootCount()} 件事进行中 · 点一件进去看或管`;
    } else {
      const today = now();
      title.textContent = "今天";
      subtitle.textContent = `${monthDayLabel(today)} · ${weekdayFullLabel(today)} · 今日优先`;
    }
    copy.append(title, subtitle);
    heading.append(mark, copy);

    const actions = element("div", "todo-topbar-actions");
    /* B6-27（用户 2026-08-20 裁定，覆盖稿 4424-4431 侧栏页头画法）：页头
       新增/助理按钮撤除，入口只留 titlebar 栈（manifest titlebarActions：
       new-task + assistant）。视角切换（对稿 tdViewSeg 4497-4499）保留。 */
    /* 「日程 / 列表」视角切换（对稿 tdViewSeg）：两档互斥——日程是按天过的流，
       列表回答「我手上总共有多少件事」。 */
    const seg = element("div", "todo-view-seg");
    seg.setAttribute("role", "group");
    seg.setAttribute("aria-label", "视角切换");
    VIEW_MODES.forEach(({ mode, label }) => {
      const option = button(`todo-view-seg-btn${viewMode === mode ? " is-active" : ""}`, label);
      option.type = "button";
      option.dataset.view = mode;
      option.setAttribute("aria-pressed", String(viewMode === mode));
      option.addEventListener("click", () => {
        if (viewMode === mode) return;
        /* 对稿 tdViewSeg：稿里切视角只重画头/列表/布局，日程流 DOM 不动、
           scrollTop 天然保留；这里是整页重建，切走再切回会弹回「今天」顶部。
           离开日程档那一刻记下滚动位置，切回来还到原处（dsh 补审对 #343）。 */
        if (viewMode === "schedule") {
          const leaving = root.querySelector<HTMLElement>(".todo-agenda");
          if (leaving) agendaScrollMemory = leaving.scrollTop;
        }
        viewMode = mode;
        render();
        if (mode === "schedule") {
          const agenda = root.querySelector<HTMLElement>(".todo-agenda");
          if (agenda) agenda.scrollTop = agendaScrollMemory;
        }
        root.querySelector<HTMLButtonElement>(`.todo-view-seg-btn[data-view="${mode}"]`)?.focus();
      });
      seg.appendChild(option);
    });
    actions.append(seg);

    header.append(heading, actions);
    if (statusMessage) {
      const status = element("p", "todo-topbar-status");
      status.setAttribute("role", "status");
      status.textContent = statusMessage;
      header.appendChild(status);
    }
    return header;
  }

  function monthDays(): Array<{ dateKey: string; inMonth: boolean; day: number }> {
    const first = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth(), 1, 12);
    const startOffset = (first.getDay() + 6) % 7;
    const start = new Date(first);
    start.setDate(first.getDate() - startOffset);
    return Array.from({ length: 42 }, (_, index) => {
      const date = new Date(start);
      date.setDate(start.getDate() + index);
      return { dateKey: localDateKey(date), inMonth: date.getMonth() === calendarMonth.getMonth(), day: date.getDate() };
    });
  }

  /**
   * 月历是**跳转控件，不是第二个列表**（V1.3）。点某一天，变的是左边——日程流滚过去
   * 并闪一下；月历自身尺寸不变，也不在下方再列一遍那天的事。那一天没有安排时，
   * 落到其后最近的一天，比原地不动更接近人点这一下想知道的事。
   */
  function goToDay(dateKey: string) {
    // 那天在流里但当前是列表视角 → 先切回日程视角，否则滚了也看不见（对稿 tdGotoDay）。
    if (viewMode !== "schedule") {
      viewMode = "schedule";
      render();
    }
    const agenda = root.querySelector<HTMLElement>(".todo-agenda");
    if (!agenda) return;
    const sections = Array.from(agenda.querySelectorAll<HTMLElement>("[data-day]"));
    const target = sections.find((section) => section.dataset.day === dateKey)
      ?? sections.find((section) => (section.dataset.day ?? "") >= dateKey)
      ?? sections.at(-1);
    if (!target) return;
    // 今天是流的起点，直接回到最顶——它上面压着的逾期块也是今天该看到的上下文。
    const top = dateKey === localDateKey(now())
      ? 0
      : Math.max(0, agenda.scrollTop + (target.getBoundingClientRect().top - agenda.getBoundingClientRect().top) - 8);
    agenda.scrollTo?.({ top, behavior: "smooth" });
    // 没有这一下，滚动结束后人得自己找「我点的是哪天」——尤其那天本来就在视口里、
    // 根本没发生滚动的时候。
    target.classList.add("is-day-hit");
  }

  function calendar(): HTMLElement {
    const section = element("section", "todo-calendar-card");
    section.dataset.section = "calendar";
    // 月份标题是非交互内容，单独一带；翻页与「回到今天」是交互控件，压在它下面。
    const heading = element("div", "todo-calendar-heading");
    const month = element("strong");
    month.textContent = new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long" }).format(calendarMonth);
    heading.appendChild(month);
    const header = element("header", "todo-calendar-header");
    const todayButton = button("todo-calendar-today", "回到今天");
    todayButton.addEventListener("click", () => {
      const todayKey = localDateKey(now());
      selectedDate = todayKey;
      calendarMonth = new Date(`${todayKey}T12:00:00`);
      render();
      goToDay(todayKey);
    });
    const previous = button("todo-calendar-nav", "", "上个月");
    previous.appendChild(todoIcon("chevron-left", 16));
    const next = button("todo-calendar-nav", "", "下个月");
    next.appendChild(todoIcon("chevron", 16));
    previous.addEventListener("click", () => { calendarMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() - 1, 1, 12); render(); });
    next.addEventListener("click", () => { calendarMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + 1, 1, 12); render(); });
    header.append(todayButton, previous, next);
    const weekdays = element("div", "todo-calendar-weekdays");
    WEEKDAYS.forEach((weekday) => {
      const item = element("span");
      item.textContent = weekday;
      weekdays.appendChild(item);
    });
    const grid = element("div", "todo-calendar-grid");
    const today = localDateKey(now());
    monthDays().forEach((day) => {
      const dayButton = button(`todo-calendar-day${day.inMonth ? "" : " is-outside"}${day.dateKey === today ? " is-today" : ""}${day.dateKey === selectedDate ? " is-selected" : ""}`, String(day.day));
      dayButton.setAttribute("aria-label", day.dateKey);
      const count = timelineForDate(state, day.dateKey, now()).filter((item) => !item.done).length;
      if (count) {
        const dot = element("span", "todo-calendar-dot");
        dot.textContent = count > 9 ? "9+" : String(count);
        dayButton.appendChild(dot);
      }
      dayButton.addEventListener("click", () => {
        selectedDate = day.dateKey;
        calendarMonth = new Date(`${day.dateKey}T12:00:00`);
        render();
        goToDay(day.dateKey);
      });
      grid.appendChild(dayButton);
    });
    section.append(heading, header, weekdays, grid);
    return section;
  }

  function undated(): HTMLElement {
    const section = element("section", "todo-undated-card");
    section.dataset.section = "undated";
    const header = element("header");
    const heading = element("div");
    const title = element("h2");
    title.textContent = "未定日期";
    const hint = element("p");
    hint.textContent = "还不用急着决定什么时候";
    heading.append(title, hint);
    const count = element("span");
    const nodes = undatedNodes(state);
    count.textContent = String(nodes.length);
    header.append(heading, count);
    const list = element("div", "todo-undated-list");
    if (nodes.length) nodes.forEach((node) => list.appendChild(taskRow({ node, dateKey: "", done: node.done }, true)));
    else {
      const empty = element("p", "todo-undated-empty");
      empty.textContent = "没有悬着的事";
      list.appendChild(empty);
    }
    section.append(header, list);
    return section;
  }

  /**
   * 默认顺序永远是今日优先：选中某个日期改变的是滚动位置，不是哪一天占据首屏。
   * 早一版把选中日期顶到「今天」那一格的位置，等于让日历重排左边的语义。
   * 视角只换中栏：列表档不再按天分组，右栏（日历 + 未定日期）两种视角都在场。
   * 详情开着时右栏让位（对稿 tdSyncLayout：Drawer 开了，右栏藏起）——
   * 被挤窄的是「视野」，不是「可达性」，日程流一直看得见、点得动。
   */
  function normalLayout(contextVisible = true): HTMLElement {
    const layout = element("div", "todo-layout");
    const agenda = element("main", "todo-agenda");
    if (viewMode === "list") {
      agenda.appendChild(listView());
    } else {
      const overdue = overdueArea();
      if (overdue) agenda.appendChild(overdue);
      const today = localDateKey(now());
      agenda.appendChild(agendaSection(today, "today"));
      const future = element("div", "todo-future");
      futureDateKeys(state, today).forEach((dateKey) => future.appendChild(agendaSection(dateKey)));
      agenda.appendChild(future);
    }
    layout.appendChild(agenda);
    if (contextVisible) {
      const context = element("aside", "todo-context-column");
      context.append(calendar(), undated());
      layout.appendChild(context);
    }
    return layout;
  }

  function detailFields(node: TodoNode): HTMLElement {
    const fields = element("dl", "todo-detail-fields");
    const entries: Array<[string, string]> = [
      ["时间", node.startAt ? `${node.scheduledDate ?? localDateKey(new Date(node.startAt))} ${formatTime(node)}` : node.scheduledDate ?? "未安排"],
      ["截止", node.deadlineAt ? new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(node.deadlineAt)) : "未设置"],
      ["同行", node.people.length ? node.people.join("、") : "未提到"],
      ["地点", node.location ?? (node.analysis.status === "needs-input" ? "等待你确认" : "未提到")],
      ["提醒", node.reminder.enabled ? "已开启" : "未开启"],
      ["冲突", node.conflicts.length ? node.conflicts.map((conflict) => conflict.reason).join("；") : "暂未发现"],
    ];
    entries.forEach(([term, value]) => {
      const group = element("div");
      const dt = element("dt");
      dt.textContent = term;
      const dd = element("dd");
      dd.textContent = value;
      group.append(dt, dd);
      fields.appendChild(group);
    });
    return fields;
  }

  function suggestionSection(node: TodoNode): HTMLElement | undefined {
    const suggestions = pendingSuggestions(state, node.id);
    if (!suggestions.length && !allChildrenDone(state, node.id)) return undefined;
    const section = element("section", "todo-detail-section todo-suggestions");
    const header = element("header", "todo-detail-section-heading");
    const copy = element("div");
    const title = element("h3");
    title.textContent = "助理建议";
    const hint = element("p");
    hint.textContent = "只把有把握的放在前面，你来决定要不要";
    copy.append(title, hint);
    header.appendChild(copy);
    section.appendChild(header);
    if (allChildrenDone(state, node.id) && !node.done) {
      const complete = element("article", "todo-parent-complete");
      const completeCopy = element("div");
      const completeTitle = element("strong");
      completeTitle.textContent = "已知步骤都完成了";
      const completeHint = element("p");
      completeHint.textContent = "整件事是否完成仍由你决定";
      completeCopy.append(completeTitle, completeHint);
      const completeButton = button("todo-parent-complete-action", "标记整件事完成");
      completeButton.addEventListener("click", () => { void runUpdate((current) => updateNode(current, node.id, { done: true }, now())); });
      complete.append(completeCopy, completeButton);
      section.appendChild(complete);
    }
    const visible = suggestionsExpanded ? suggestions : suggestions.slice(0, 3);
    visible.forEach((suggestion) => {
      const card = element("article", "todo-suggestion-card");
      const confidence = element("span", "todo-suggestion-confidence");
      confidence.textContent = `${Math.round(suggestion.confidence * 100)}%`;
      const body = element("div");
      const cardTitle = element("strong");
      cardTitle.textContent = suggestion.title;
      const detail = element("p");
      detail.textContent = suggestion.detail;
      body.append(cardTitle, detail);
      const actions = element("div", "todo-suggestion-actions");
      const accept = button("todo-suggestion-accept", "加入");
      const dismiss = button("todo-suggestion-dismiss", "不需要");
      accept.addEventListener("click", () => { void runUpdate((current) => acceptSuggestion(current, suggestion.id, now(), idFactory)); });
      dismiss.addEventListener("click", () => { void runUpdate((current) => dismissSuggestion(current, suggestion.id, now())); });
      actions.append(accept, dismiss);
      card.append(confidence, body, actions);
      section.appendChild(card);
    });
    if (suggestions.length > 3) {
      const more = button("todo-suggestions-more", suggestionsExpanded ? "收起额外建议" : `另外 ${suggestions.length - 3} 条建议`);
      more.setAttribute("aria-expanded", String(suggestionsExpanded));
      more.addEventListener("click", () => { suggestionsExpanded = !suggestionsExpanded; render(); });
      section.appendChild(more);
    }
    return section;
  }

  function subtaskTree(parentId: string, depth = 0): HTMLElement {
    const list = element("div", "todo-subtask-tree");
    for (const child of childrenOf(state, parentId)) {
      const row = element("div", `todo-subtask${child.done ? " is-done" : ""}`);
      row.style.setProperty("--todo-depth", String(depth));
      const check = element("input");
      check.type = "checkbox";
      check.checked = child.done;
      check.setAttribute("aria-label", `完成：${child.title}`);
      check.addEventListener("change", () => { void runUpdate((current) => updateNode(current, child.id, { done: check.checked }, now())); });
      const open = button("todo-subtask-open", child.title);
      open.addEventListener("click", () => openDetail(child.id));
      row.append(check, open);
      list.appendChild(row);
      if (childrenOf(state, child.id).length) list.appendChild(subtaskTree(child.id, depth + 1));
    }
    return list;
  }

  function detailContent(node: TodoNode, promoted = false): HTMLElement {
    const content = element("div", `todo-detail-content${promoted ? " is-promoted" : ""}`);
    const stateRow = element("div", "todo-detail-state-row");
    const check = element("input");
    check.type = "checkbox";
    check.checked = node.done;
    check.setAttribute("aria-label", `完成整件事：${node.title}`);
    check.addEventListener("change", () => { void runUpdate((current) => updateNode(current, node.id, { done: check.checked }, now())); });
    const stateCopy = element("div");
    const title = element("h2");
    title.textContent = node.title;
    const summary = element("p");
    summary.textContent = node.analysis.summary ?? "这件事还没有更多信息";
    stateCopy.append(title, summary);
    stateRow.append(check, stateCopy);
    content.append(stateRow, detailFields(node));
    const suggestion = suggestionSection(node);
    if (suggestion) content.appendChild(suggestion);
    const subtasks = element("section", "todo-detail-section todo-subtasks-section");
    const subheading = element("header", "todo-detail-section-heading");
    const headingCopy = element("div");
    const subTitle = element("h3");
    subTitle.textContent = "步骤";
    const subHint = element("p");
    subHint.textContent = "需要时再拆，层级不限";
    headingCopy.append(subTitle, subHint);
    subheading.appendChild(headingCopy);
    const tree = subtaskTree(node.id);
    const form = element("form", "todo-subtask-form");
    const input = element("input");
    input.placeholder = "加一个步骤…";
    input.setAttribute("aria-label", `给${node.title}添加步骤`);
    input.dataset.todoFocusKey = `subtask:${node.id}`;
    input.value = subtaskDrafts.get(node.id) ?? "";
    input.addEventListener("input", () => { subtaskDrafts.set(node.id, input.value); });
    const add = button("todo-subtask-add", "添加");
    add.type = "submit";
    form.append(input, add);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const value = input.value.trim();
      if (!value) return;
      subtaskDrafts.delete(node.id);
      input.value = "";
      const childId = idFactory();
      void runUpdate((current) => addChildNode(current, node.id, {
        id: childId,
        title: value,
        now: now(),
        analysis: { status: "queued", summary: "等待日程助理整理" },
      })).then((saved) => {
        const child = saved?.nodes.find((candidate) => candidate.id === childId);
        if (child) options.enqueueAnalysis(child);
      });
    });
    subtasks.append(subheading, tree, form);
    content.appendChild(subtasks);
    return content;
  }

  /**
   * 详情 Drawer 是挤压式的一列（对稿 .td-detail.open，V1.5 评审前的形态差异已按稿收齐）：
   * 主列表让位——右栏收起、日程流被挤窄——但不盖蒙版，列表一直看得见、点得动。
   * 长期开着也不该挡内容，跟 aside 助理是同一种「挤」的判断。
   */
  function detailDrawer(node: TodoNode): HTMLElement {
    const drawer = element("aside", "todo-detail-drawer");
    drawer.setAttribute("role", "dialog");
    // 非模态：背景的日程流可见可点（点别的事情就换详情），只是让出了位置。
    drawer.setAttribute("aria-modal", "false");
    drawer.setAttribute("aria-labelledby", "todo-detail-drawer-title");
    drawer.tabIndex = -1;
    const header = element("header", "todo-detail-header");
    const heading = element("div");
    const eyebrow = element("span");
    eyebrow.textContent = node.parentId ? "子任务详情" : "事项详情";
    const title = element("strong");
    title.id = "todo-detail-drawer-title";
    title.textContent = node.title;
    heading.append(eyebrow, title);
    const actions = element("div");
    const assistant = button("todo-detail-assistant", "");
    assistant.append(todoIcon("sparkles", 14), document.createTextNode("问助理"), tbcTag());
    assistant.addEventListener("click", () => openAgent(node.id));
    const close = button("todo-detail-close", "", "关闭详情");
    close.appendChild(todoIcon("x", 16));
    close.addEventListener("click", closeDetail);
    actions.append(assistant, close);
    header.append(heading, actions);
    const scroll = element("div", "todo-detail-scroll");
    scroll.appendChild(detailContent(node));
    drawer.append(header, scroll);
    return drawer;
  }

  function defaultConversation(task?: TodoNode): StreamItem[] {
    const time = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }).format(now());
    const welcome = task
      ? task.analysis.status === "needs-input"
        ? `我已经把「${task.title}」里的时间和人物整理好了，但具体地点还不清楚。告诉我地点，我会直接补回详情。`
        : `我在看「${task.title}」。你可以直接说想改什么，我会把确认后的内容更新回详情。`
      : "我是这个 App 的日程助理。你可以让我一起规划今天、整理某件事，或者回答日程相关的问题。";
    return [{ k: "msg", text: welcome, ts: time, ava: "程" } satisfies StreamMsg];
  }

  async function sendAgentMessage(key: ConversationKey, text: string) {
    const task = taskById(taskIdFromConversation(key));
    const time = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }).format(now());
    const fallback = defaultConversation(task);
    const mine: StreamMsg = { k: "msg", me: 1, text, ts: time };
    const saved = await runUpdate((latest) => ({
      ...latest,
      conversations: {
        ...latest.conversations,
        [key]: [...(latest.conversations[key]?.length ? latest.conversations[key]! : fallback), mine],
      },
    }));
    if (!saved) return;
    if (task) await options.answerAgent?.(task, text);
    const response: StreamMsg = {
      k: "msg",
      text: task?.analysis.status === "needs-input"
        ? "收到，我已经把这条信息交给当前事项，详情会同步更新。"
        : "收到。我会围绕当前日程继续整理；这版使用 Mock 工作流演示更新闭环。",
      ts: time,
      ava: "程",
    };
    await runUpdate((latest) => ({
      ...latest,
      conversations: {
        ...latest.conversations,
        [key]: [...(latest.conversations[key] ?? [...fallback, mine]), response],
      },
    }));
  }

  function agentDrawer(task?: TodoNode, aside = false): HTMLElement {
    const drawer = element("aside", `todo-agent-drawer${aside ? " is-aside" : ""}`);
    drawer.setAttribute("role", "dialog");
    drawer.setAttribute("aria-modal", String(!task && !aside));
    drawer.setAttribute("aria-labelledby", "todo-agent-title");
    const header = element("header", "todo-agent-header");
    const avatar = element("span", "todo-agent-avatar");
    avatar.textContent = "程";
    const identity = element("div");
    const title = element("strong");
    title.id = "todo-agent-title";
    title.textContent = "日程助理";
    title.appendChild(tbcTag());
    const subtitle = element("span");
    subtitle.textContent = task
      ? aside ? `想跟你确认 · ${task.title}` : `正在处理 · ${task.title}`
      : "只处理当前日程 App";
    identity.append(title, subtitle);
    const close = button("todo-agent-close", "", "关闭日程助理");
    close.appendChild(todoIcon("x", 16));
    close.addEventListener("click", closeAgent);
    header.append(avatar, identity, close);
    drawer.appendChild(header);
    if (agentListening) {
      const listening = element("div", "todo-agent-listening");
      const pulse = element("span");
      const copy = element("div");
      const label = element("strong");
      label.textContent = "正在聆听";
      const hint = element("small");
      hint.textContent = "这是客户端动作的 Mock 状态";
      copy.append(label, hint);
      listening.append(pulse, copy);
      drawer.appendChild(listening);
    }
    const conversationKey = conversationKeyForTask(task?.id);
    const items = state.conversations[conversationKey]?.length ? state.conversations[conversationKey]! : defaultConversation(task);
    const agent: Agent = {
      id: "schedule-assistant",
      kind: "agent",
      ava: "程",
      name: "日程助理",
      role: "帮你把事情变得更容易完成",
      status: "idle",
      time: "现在",
      last: "",
      stream: items,
    };
    const stream = mountConversationStream(drawer, { agent, items });
    const composer = mountAgentComposer(drawer, {
      placeholder: task ? `继续说「${task.title}」…` : "和日程助理说…",
      scrollContainer: stream.element,
      onSend: (text) => {
        agentDrafts[conversationKey] = "";
        void sendAgentMessage(conversationKey, text);
      },
    });
    composer.input.dataset.todoFocusKey = `agent:${conversationKey}`;
    composer.input.value = agentDrafts[conversationKey] ?? "";
    composer.input.addEventListener("input", () => { agentDrafts[conversationKey] = composer.input.value; });
    composer.element.querySelector<HTMLElement>(".agent-composer-button:not(.is-mic)")?.remove();
    composer.element.querySelector<HTMLButtonElement>(".agent-composer-button.is-mic")?.addEventListener("click", () => {
      agentListening = true;
      render();
    });
    composerDispose = composer.dispose;
    return drawer;
  }

  function assistantWorkspace(node: TodoNode): HTMLElement {
    const workspace = element("section", "todo-assistant-workspace");
    const context = element("main", "todo-assistant-context");
    const header = element("header", "todo-assistant-context-header");
    const back = button("todo-assistant-back", "");
    back.append(todoIcon("chevron-left", 14), document.createTextNode("返回日程"));
    back.addEventListener("click", closeAgent);
    const label = element("span");
    label.textContent = "助理正在同步修改右侧这件事";
    header.append(back, label);
    const scroll = element("div", "todo-assistant-context-scroll");
    scroll.appendChild(detailContent(node, true));
    context.append(header, scroll);
    workspace.append(context, agentDrawer(node));
    return workspace;
  }

  function render() {
    if (disposed) return;
    const activeInput = root.contains(document.activeElement) && document.activeElement instanceof HTMLInputElement
      ? document.activeElement
      : undefined;
    const focusSnapshot = activeInput?.dataset.todoFocusKey ? {
      key: activeInput.dataset.todoFocusKey,
      start: activeInput.selectionStart,
      end: activeInput.selectionEnd,
    } : undefined;
    composerDispose();
    composerDispose = () => {};
    const frame = element("section", "plugin-main-frame");
    const app = element("section", "main-body todo-app");
    frame.appendChild(app);
    const commit = () => {
      root.replaceChildren(frame);
      if (!focusSnapshot) return;
      const replacement = root.querySelector<HTMLInputElement>(`[data-todo-focus-key="${CSS.escape(focusSnapshot.key)}"]`);
      replacement?.focus();
      if (replacement && focusSnapshot.start !== null && focusSnapshot.end !== null) {
        replacement.setSelectionRange(focusSnapshot.start, focusSnapshot.end);
      }
    };
    const activeAgentTask = taskById(agentTaskId);
    // 「详情提升为主内容」只在人真的从一件事唤醒助理时发生。助理自己来追问的那一档
    // 不走这条路——中栏被藏掉、详情又没开，屏幕正中就是一片空白。
    if (agentOpen && activeAgentTask && !agentAside) {
      app.classList.add("is-agent-context");
      app.appendChild(assistantWorkspace(activeAgentTask));
      commit();
      return;
    }
    app.appendChild(topbar());
    const body = element("div", "todo-body");
    // 挤压式详情是 body 的第三列：右栏让位、日程流变窄，但没有蒙版盖在上面。
    const detail = taskById(detailTaskId);
    if (detail) body.classList.add("is-detail-open");
    body.appendChild(normalLayout(!detail));
    if (detail) body.appendChild(detailDrawer(detail));
    // aside 助理是挤压式的第三列：日程流被挤窄，但一直看得见、点得动。
    if (agentOpen && activeAgentTask && agentAside) body.appendChild(agentDrawer(activeAgentTask, true));
    app.appendChild(body);
    if (agentOpen && !agentTaskId) {
      const layer = element("div", "todo-agent-layer");
      const scrim = button("todo-agent-scrim", "", "关闭日程助理");
      scrim.addEventListener("click", closeAgent);
      layer.append(scrim, agentDrawer());
      app.appendChild(layer);
    }
    if (composeOpen) app.appendChild(composeLayer());
    commit();
  }

  const view: TodoView = {
    setState(next) {
      const previous = state;
      state = next;
      if (disposed) return;
      render();
      noticeNeedsInput(previous, next);
    },
    applyIntent(intent) {
      if (!intent) return;
      if (intent.type === "new-task") {
        openCompose();
        return;
      }
      const key = isConversationKey(intent.conversationKey) ? intent.conversationKey : "app";
      const taskId = taskIdFromConversation(key);
      if (taskId && !taskById(taskId)) return;
      openAgent(taskId, { listening: intent.type === "talk-to-assistant" });
    },
    openComposer() {
      openCompose();
    },
    dispose() {
      disposed = true;
      composerDispose();
      document.removeEventListener("keydown", onDocumentKeyDown);
      root.replaceChildren();
    },
  };

  render();
  return view;
}
