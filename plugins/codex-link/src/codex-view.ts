import { bindText, bindAttribute, bindTemplate, localizedTextNode, readText, replaceChildren, releaseLocaleBindings, setCodexLocale, codexLocale, t, type TextSource, type CodexLocalePort } from "./codex-i18n";
import { renderAccount } from "./codex-account-view";
import type { CodexStore } from "./codex-repository";
import {
  desktopOpenAvailability,
  formatCodexError,
  formatRelativeTime,
  type DashboardThread,
  type PendingRequestSummary,
} from "./codex-model";
import {
  CodexRepository,
  TaskCreationError,
  type CodexCall,
  type CodexRepositorySnapshot,
  type ComposeDefaults,
  type StartTaskOptions,
  type TaskModel,
} from "./codex-repository";

/**
 * C-3b：Action 层挂载口（Host 侧 `actionItems.*`）。
 *
 * 收成一个窄口而不是直接吃整个 AppContext：这个视图在测试里是脱离 Host 跑的，
 * 而挂载是**用户意愿的持久化**，不该被测试桩顺手写进真实清单。
 */
export interface ActionLayerPort {
  onChange?(handler: () => void): () => void;
  /** ⚠️ 快照里条目 id 的字段名是 `itemId`（Host `ActionMount.item_id`），不是请求里的 `id`。 */
  list(): Promise<Array<{ kind: string; itemId: string }>>;
  mount(item: {
    kind: "item";
    id: string;
    title: string;
    detail?: string;
    badge?: string;
    icon?: string;
    target: { surfaceId: string; intent?: unknown };
  }): Promise<void>;
  unmount(kind: "item", id: string): Promise<void>;
}

/** Action 层挂上来的 Skill 被按下时，Host 投回来的 intent 形状。 */
export interface MountedSkillIntent {
  type: "actionItem.skill";
  name: string;
  path: string;
  cwd: string;
}

export function isMountedSkillIntent(intent: unknown): intent is MountedSkillIntent {
  if (!intent || typeof intent !== "object") return false;
  const value = intent as Record<string, unknown>;
  return (
    value.type === "actionItem.skill" &&
    typeof value.name === "string" &&
    typeof value.path === "string" &&
    typeof value.cwd === "string"
  );
}

/**
 * Host 侧 `actionItems.mount` 对 id/title/detail/badge 的短文本上限
 * （`action_items.rs` 的 `MAX_TEXT_LEN = 200`，超限整单拒收）。Skill 的描述、
 * 名字、路径都来自用户的 Codex 环境、长度不受我们控制——按码点截断，
 * 别让一颗勾选因为第三方文本太长而挂不上去。
 */
const ACTION_ITEM_TEXT_LIMIT = 200;

function clampActionItemText(text: string): string {
  const chars = [...text];
  if (chars.length <= ACTION_ITEM_TEXT_LIMIT) return text;
  return `${chars.slice(0, ACTION_ITEM_TEXT_LIMIT - 1).join("")}…`;
}

/** Skill 在 Action 层里的稳定 id：同名 Skill 可能来自不同目录。
 *  id 也在 Host 的 200 字上限内，超长路径/名字就地截断——挂与卸、勾选态回读
 *  都经过这一处，截断口径一致就不会对不上（>199 字同前缀的两个 skill 才会撞，可忽略）。 */
export function mountedSkillId(cwd: string, name: string): string {
  return clampActionItemText(`skill:${cwd}:${name}`);
}

/**
 * 拨杆档位带过来的起跑预设。
 *
 * 字段就是 Host 侧 `static_input` 白名单里的那四项——**没有「模式」这种字段**：
 * Codex 协议不提供切换会话审批模式的方法，建 thread / 起 turn 的窄口也不收，
 * 硬造一个只会变成一句空头承诺。
 */
export interface ComposePreset {
  /** 起跑工作目录。Host 的 static_input 不送这一项；页内「快速开始」点 Skill 时用它把目录对齐到 Skill 所属项目。 */
  cwd?: string;
  model?: string;
  effort?: string;
  skillName?: string;
  promptPrefix?: string;
}

export interface CodexViewOptions {
  locale?: CodexLocalePort;
  repository?: CodexRepository;
  call?: CodexCall;
  store?: CodexStore;
  pollIntervalMs?: number;
  pendingCloseDelayMs?: number;
  now?: () => number;
  onSnapshot?: (snapshot: CodexRepositorySnapshot, selectedThreadId?: string) => void;
  /** 缺省是内存桩：脱离 Host 的测试/预览不写真实挂载清单。 */
  actionLayer?: ActionLayerPort;
  /** 让用户挑一个目录，取消时回 undefined（Host 的 `system.folder-pick@1`）。 */
  pickFolder?: () => Promise<string | undefined>;
  /**
   * 一条会话真的被打开了（任务详情视图落到这个 thread）。
   *
   * 「开过对话即消失」的回报口（C-2）：宿主后台任务子系统以「那条会话被打开」为
   * 「已看过」的判据，插件在详情真的渲染出来之后才调它——早调等于替用户宣布
   * 「你已经看过了」。
   */
  onConversationOpened?: (threadId: string) => void;
}

function volatileActionLayer(): ActionLayerPort {
  const mounted = new Set<string>();
  return {
    async list() {
      // 形状必须与真实 Host 一致（itemId 而不是 id），否则这个桩会把字段名
      // 写错的缺陷一路掩盖到发版。
      return [...mounted].map((itemId) => ({ kind: "item", itemId }));
    },
    async mount(item) {
      mounted.add(item.id);
    },
    async unmount(_kind, id) {
      mounted.delete(id);
    },
  };
}

function volatileStore(): CodexStore {
  const values = new Map<string, unknown>();
  return {
    async get<T>(key: string) { return values.get(key) as T | undefined; },
    async set(key: string, value: unknown) { values.set(key, value); },
    async delete(key: string) { values.delete(key); },
    async keys() { return [...values.keys()]; },
  };
}

function button(label: TextSource, action: string, className = "cx-btn"): HTMLButtonElement {
  const element = document.createElement("button");
  element.type = "button";
  element.className = className;
  bindText(element, label);
  element.dataset.action = action;
  return element;
}

function featureEnabled(
  features: CodexRepositorySnapshot["status"]["features"],
  feature: string,
): boolean {
  return Array.isArray(features) ? features.includes(feature) : features?.[feature] === true;
}

/**
 * 目录只在**显示**时净化，发出去的值保持原样。
 *
 * 路径来自本机 Codex，本身在信任边界内，但一条带 U+202E（从右到左覆盖）的路径能在
 * 候选列表里伪装成另一个目录——用户以为选的是 `/work/safe`，agent 实际跑在别处。
 * 控制字符同理（换行能把一行拆成两行）。一律换成 U+FFFD：看得见异常，也就骗不到人。
 */
function displayPath(path: string): string {
  // C0 / DEL / C1 与 bidi 覆盖符（U+200E/200F、U+202A–202E、U+2066–2069）
  const clean = path.replace(/[\u0000-\u001F\u007F-\u009F\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, "\uFFFD");
  // 稿内的目录一律 `~/…` 缩写。纯展示变换：发出去的值保持原样。
  return clean
    .replace(/^\/Users\/[^/]+(?=\/|$)/, "~")
    .replace(/^\\Users\\[^\\]+(?=\\|$)/, "~")
    .replace(/^C:\\Users\\[^\\]+(?=\\|$)/, "~");
}

function option(label: TextSource, value: string): HTMLOptionElement {
  const element = document.createElement("option");
  bindText(element, label);
  element.value = value;
  return element;
}

export function mountCodexView(root: HTMLElement, options: CodexViewOptions = {}) {
  setCodexLocale(options.locale?.getSnapshot().locale ?? "zh");
  const now = options.now ?? Date.now;
  const displayError = (cause: unknown): string => {
    const detail = formatCodexError(cause);
    if (cause instanceof Error && "getLocalizedMessage" in cause) return detail;
    return t("errors.actionFailed", { detail });
  };
  const repository = options.repository ?? new CodexRepository(
    options.call,
    options.store ?? volatileStore(),
    { now },
  );
  const actionLayer = options.actionLayer ?? volatileActionLayer();
  /** 已挂进 Action 层的 Skill id（勾选态的唯一事实源在 Host，这里是镜像）。 */
  let mountedSkills = new Set<string>();
  const pollIntervalMs = options.pollIntervalMs ?? 20_000;
  const pendingCloseDelayMs = options.pendingCloseDelayMs ?? 8_000;
  let disposed = false;
  let refreshInFlight: Promise<void> | undefined;
  let refreshFailure: (() => string) | undefined;
  let accountSyncInFlight: Promise<void> | undefined;
  let realtimeTimer: number | undefined;
  let realtimeRefreshActive = false;
  let realtimeDirty = false;
  let snapshot: CodexRepositorySnapshot | undefined;
  let selectedThreadId: string | undefined;
  let farOpen = false;
  let drawerOpen = false;
  let drawerReturnFocus: HTMLElement | null = null;
  let composeReturnFocus: HTMLElement | null = null;
  let detailThreadId: string | undefined;
  let detailReturnFocus: HTMLElement | null = null;
  let detailSignature: string | undefined;
  let approvalInFlight = false;
  /**
   * 本次已经批过/拒过的审批。Host 快照追上来之前用它把按钮撤掉。
   * 键带上 threadId：app-server 的 request id 每次进程重启都从头递增，
   * 只记数字的话重启后一条全新的审批会撞上旧号，被永久遮蔽成「说着等你审批、却只有关闭按钮」。
   */
  const resolvedRequestKeys = new Set<string>();
  const requestKey = (threadId: string, serverRequestId: number) => `${threadId}:${serverRequestId}`;
  let taskModels: TaskModel[] = [];
  let taskModelFeature: boolean | undefined;
  let taskModelsSettled = false;
  let creationPromise: Promise<void> | undefined;
  /** 「正在创建」的权威标志：它比 `creationPromise` 早一步立起来，见 `isCreating()`。 */
  let creatingTask = false;
  let pendingCanClose = false;
  let pendingTimer: number | undefined;
  let retryOptions: Pick<StartTaskOptions, "threadId" | "clientUserMessageId"> | undefined;
  let creationBlocked = false;
  /** 目录候选来自快照（Skills 与任务列表里出现过的 cwd），顺序即最近用过的顺序。 */
  let cwdCandidates: string[] = [];
  /** 当前选中的目录：没敲搜索词时它写在 placeholder 上，等于「不动它就用它」。 */
  let composeCwd = "";
  let cwdQuery = "";
  let cwdPickedByUser = false;
  let cwdSearchFocused = false;
  /** 上一次渲染出来的候选列表长什么样；内容没变就不重建 DOM（否则会打掉键盘焦点）。 */
  let cwdListSignature = "";
  let storedDefaults: ComposeDefaults = {};
  let storedDefaultsLoaded = false;
  let storedDefaultsPromise: Promise<void> | undefined;
  /** 上次用过的推理强度只在强度选项首次填充时消费一次，之后换模型一律回模型默认。 */
  let pendingStoredEffort: string | undefined;
  /**
   * 用户通过「选文件夹…」挑回来的目录。
   *
   * 候选本来是从 Codex 的 skills / threads 里推出来的——**刚挑的新目录还没有任何
   * 会话，推不出来**。放进这里，下一次重渲染才留得住，否则用户选完一刷新就没了。
   */
  const pickedCwds: string[] = [];
  /** 拨杆档位带来的起跑预设（`applyComposePreset`）。 */
  let composePreset: ComposePreset | undefined;
  /** 上一次铺进输入框的前缀，换档位时凭它把旧的那句摘掉。 */
  let lastAppliedPrefix = "";
  /** 第一份快照还没到时收到的预设，等快照落地再铺。 */
  let deferredPreset: ComposePreset | undefined;
  /**
   * Host 从胶囊 / Tab 层点开的那条会话，等快照里有它了再落到详情视图。
   *
   * 冷启动时快照与 intent 谁先到没有保证；直接丢弃的话用户点完胶囊只落在列表页，
   * 「点开胶囊进到那条会话」就断了。过期丢弃，与 `pendingPreset` 同一条纪律。
   */
  let pendingConversation: { threadId: string; atMs: number } | undefined;
  const PENDING_CONVERSATION_TTL_MS = 30_000;

  const frame = document.createElement("div");
  frame.className = "plugin-main-frame";
  const page = document.createElement("main");
  page.className = "main-body cx-page";
  frame.appendChild(page);
  page.innerHTML = `
    <!-- 图标精灵图：path 摘自 Host 图标表（driver-v2/src/shell/icons.ts），只抄这一页用得到的几个。
         前缀沿用 reai-icon-，等平台注入公共 sprite 时删掉这段即可，引用处不用动。
         参数见《插件设计规范 v1》§2。 -->
    <svg class="cx-sprite" aria-hidden="true"><defs>
      <symbol id="reai-icon-x" viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></symbol>
      <symbol id="reai-icon-rotate-cw" viewBox="0 0 24 24"><path d="M23 4v6h-6"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></symbol>
      <symbol id="reai-icon-plus" viewBox="0 0 24 24"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></symbol>
      <symbol id="reai-icon-folder" viewBox="0 0 24 24"><path d="M3 6.5h6l2 2h10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></symbol>
      <symbol id="reai-icon-search" viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></symbol>
      <symbol id="reai-icon-chevron-down" viewBox="0 0 24 24"><path d="m7 10 5 5 5-5"/></symbol>
      <symbol id="reai-icon-alert-circle" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></symbol>
      <symbol id="reai-icon-external-link" viewBox="0 0 24 24"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></symbol>
    </defs></svg>
    <section class="cx-main" data-i18n-aria-label="page.tasks">
      <header class="cx-head">
        <!-- 页名由 Host 标题栏面包屑承载（仓库合同禁止首屏重画「Codex Link」），
             页内标题用设计稿的 19px/11px 两档：问句标题 + 覆盖范围副题。 -->
        <div><h1 class="cx-title"><span data-i18n="page.heading"></span></h1><p class="cx-title-s"><span data-i18n="page.scope"></span></p></div>
        <div class="cx-conn" role="status"><span class="cx-dot"></span><span data-slot="connection"><span data-i18n="page.connecting"></span></span><button type="button" class="cx-icon-btn" data-action="refresh" data-i18n-aria-label="common.refresh"><svg class="cx-icon" aria-hidden="true"><use href="#reai-icon-rotate-cw"></use></svg></button></div>
      </header>
      <section class="cx-auth-card" aria-labelledby="cx-auth-title" aria-live="polite" hidden></section>
      <div class="cx-compat" data-slot="compat" hidden></div>
      <div class="cx-error" data-slot="error" hidden></div>
      <div class="cx-scroll" data-slot="groups" aria-live="polite"></div>
    </section>
    <aside class="cx-side" aria-label="Skills">
      <div class="cx-side-head"><div><h2 class="cx-side-t"><span data-i18n="page.quickStart"></span></h2><p class="cx-side-s"><span data-i18n="page.quickStartSub"></span></p></div><button type="button" class="cx-icon-btn" data-action="refresh-skills" data-i18n-aria-label="skills.refresh"><svg class="cx-icon" aria-hidden="true"><use href="#reai-icon-rotate-cw"></use></svg></button></div>
      <div data-slot="skills"></div>
    </aside>
    <button type="button" class="cx-skills-fab" data-action="open-skills-drawer" data-i18n-aria-label="skills.open" aria-controls="cx-skills-drawer" aria-expanded="false">
      <span>Skills</span><b data-slot="skills-count">0</b>
    </button>
    <div class="cx-skills-drawer" id="cx-skills-drawer" role="dialog" aria-modal="true" aria-labelledby="cx-skills-drawer-title" hidden>
      <section class="cx-skills-drawer-panel">
        <div class="cx-side-head">
          <div><h2 class="cx-side-t" id="cx-skills-drawer-title"><span data-i18n="page.quickStart"></span></h2><p class="cx-side-s"><span data-i18n="page.quickStartSub"></span></p></div>
          <button type="button" class="cx-icon-btn" data-action="close-skills-drawer" data-i18n-aria-label="skills.close"><svg class="cx-icon" aria-hidden="true"><use href="#reai-icon-x"></use></svg></button>
        </div>
        <div data-slot="skills"></div>
      </section>
    </div>
    <div class="cx-compose" aria-hidden="true" role="dialog" aria-modal="true" aria-labelledby="cx-compose-title" hidden>
      <form class="cx-compose-card" data-form="compose" aria-busy="false">
        <header><h2 id="cx-compose-title"><span data-i18n="compose.title"></span></h2><button type="button" class="cx-icon-btn" data-action="close-compose" data-i18n-aria-label="common.close"><svg class="cx-icon" aria-hidden="true"><use href="#reai-icon-x"></use></svg></button></header>
        <div class="cx-field cx-field-wide" data-slot="cwd-field">
          <label id="cx-cwd-label" for="cx-cwd-input"><span data-i18n="compose.directory"></span></label>
          <!-- D-2（设计稿第 2 轮判定 + 第 5 轮附言）：目录不是原生下拉，而是「带搜索的输入框 + 候选列表」。
               没敲搜索词时**不列候选**——默认目录直接写在 placeholder 上（不动它就用它），
               focus 时 placeholder 换成「输入搜索」告诉用户这里能打字，blur 再换回来。
               并排那颗「选文件夹…」交给系统面板挑一个新的：目录多起来之后敲两个字比翻列表快，
               而第一次用的人候选是空的，那颗按钮就是他唯一需要的东西。
               按钮不放进 <label> 里——点它会连带激活 label 把焦点甩回输入框，
               弹面板的同时输入框被抢焦点；所以用 <label for> 显式关联，按钮做兄弟节点。 -->
          <div class="dirpick">
            <span class="dirpick-in"><svg class="cx-icon" aria-hidden="true"><use href="#reai-icon-search"></use></svg><input type="text" id="cx-cwd-input" data-field="cwd-search" autocomplete="off" spellcheck="false" maxlength="512"></span>
            <button type="button" class="dirpick-btn" data-action="pick-folder" data-write-action><svg class="cx-icon" aria-hidden="true"><use href="#reai-icon-folder"></use></svg><span data-i18n="compose.pickFolder"></span></button>
          </div>
          <div class="dirpick-list" data-slot="cwd-list" role="group" data-i18n-aria-label="compose.matches"></div>
          <span class="cx-sr-only" data-slot="cwd-status" role="status" aria-live="polite"></span>
          <small data-slot="cwd-empty" hidden><span data-i18n="compose.noDirectories"></span></small>
        </div>
        <div class="cx-compose-grid">
          <label class="cx-field"><span><span data-i18n="compose.model"></span></span><span class="cx-select-shell"><select data-field="model" aria-describedby="cx-model-status"><option value="" data-i18n="compose.defaultModel"></option></select><svg class="cx-icon cx-select-chevron" aria-hidden="true"><use href="#reai-icon-chevron-down"></use></svg></span></label>
          <label class="cx-field"><span><span data-i18n="compose.effort"></span></span><span class="cx-select-shell"><select data-field="effort"><option value="" data-i18n="compose.defaultEffort"></option></select><svg class="cx-icon cx-select-chevron" aria-hidden="true"><use href="#reai-icon-chevron-down"></use></svg></span></label>
        </div>
        <div class="cx-model-status" id="cx-model-status" data-slot="model-status" aria-live="polite"></div>
        <!-- 档位预设对不上当前 Codex 时的说明。单独一槽、每次整条重写：
             追加到模型状态行后面的话，一次按键会接两遍，再开一次又长一截。 -->
        <div class="cx-preset-note" data-slot="preset-note" aria-live="polite" hidden></div>
        <label class="cx-field cx-field-wide"><span><span data-i18n="compose.prompt"></span></span><textarea data-field="prompt" rows="4" maxlength="12000" data-i18n-placeholder="compose.placeholder" required></textarea></label>
        <div class="cx-compose-progress" data-slot="compose-progress" role="status" aria-live="polite" hidden></div>
        <footer><span><i>Enter</i> <span data-i18n="compose.start"></span> · <i>Shift+Enter</i> <span data-i18n="compose.newline"></span> · <i>Esc</i> <span data-i18n="common.cancel"></span></span><button type="submit" class="cx-primary" data-action="submit-task" data-write-action><span data-i18n="compose.start"></span></button></footer>
      </form>
    </div>
    <!-- D-4 任务详情：审批（批准/拒绝）只在这里出现，任务列表行内没有。
         入口是「再点一次已经选中的那一行」，与设计稿一致。 -->
    <div class="cx-detail" data-slot="detail" role="dialog" aria-modal="true" aria-labelledby="cx-detail-title" hidden>
      <section class="cx-d-card" data-slot="detail-card" tabindex="-1"></section>
    </div>
    <div class="cx-toast" data-slot="toast" role="status" aria-live="polite" hidden></div>
  `;
  root.replaceChildren(frame);
  bindTemplate(page);
  bindAttribute(page, "lang", () => codexLocale());

  const groupsRoot = page.querySelector<HTMLElement>('[data-slot="groups"]')!;
  const skillsRoots = Array.from(page.querySelectorAll<HTMLElement>('[data-slot="skills"]'));
  const skillsCounts = Array.from(page.querySelectorAll<HTMLElement>('[data-slot="skills-count"]'));
  const skillsTrigger = page.querySelector<HTMLButtonElement>('[data-action="open-skills-drawer"]')!;
  const skillsDrawer = page.querySelector<HTMLElement>("#cx-skills-drawer")!;
  const skillsDrawerClose = page.querySelector<HTMLButtonElement>('[data-action="close-skills-drawer"]')!;
  const mainSurface = page.querySelector<HTMLElement>(".cx-main")!;
  const sideSurface = page.querySelector<HTMLElement>(".cx-side")!;
  const accountSession = page.querySelector<HTMLElement>(".cx-conn")!;
  const accountCard = page.querySelector<HTMLElement>(".cx-auth-card")!;
  let accountBusy = false;
  let accountActionError: TextSource;
  const connection = page.querySelector<HTMLElement>('[data-slot="connection"]')!;
  const connectionDot = page.querySelector<HTMLElement>(".cx-dot")!;
  const compatibility = page.querySelector<HTMLElement>('[data-slot="compat"]')!;
  const errorBox = page.querySelector<HTMLElement>('[data-slot="error"]')!;
  const compose = page.querySelector<HTMLElement>(".cx-compose")!;
  const composeForm = page.querySelector<HTMLFormElement>('[data-form="compose"]')!;
  const cwdSearch = page.querySelector<HTMLInputElement>('[data-field="cwd-search"]')!;
  const cwdList = page.querySelector<HTMLElement>('[data-slot="cwd-list"]')!;
  const cwdField = page.querySelector<HTMLElement>('[data-slot="cwd-field"]')!;
  const cwdStatus = page.querySelector<HTMLElement>('[data-slot="cwd-status"]')!;
  const promptInput = page.querySelector<HTMLTextAreaElement>('[data-field="prompt"]')!;
  const modelSelect = page.querySelector<HTMLSelectElement>('[data-field="model"]')!;
  const effortSelect = page.querySelector<HTMLSelectElement>('[data-field="effort"]')!;
  const modelStatus = page.querySelector<HTMLElement>('[data-slot="model-status"]')!;
  const presetNote = page.querySelector<HTMLElement>('[data-slot="preset-note"]')!;
  const cwdEmpty = page.querySelector<HTMLElement>('[data-slot="cwd-empty"]')!;
  const composeProgress = page.querySelector<HTMLElement>('[data-slot="compose-progress"]')!;
  const submitButton = page.querySelector<HTMLButtonElement>('[data-action="submit-task"]')!;
  const closeComposeButton = page.querySelector<HTMLButtonElement>('[data-action="close-compose"]')!;
  /* B6-27：页内「新任务」按钮撤除（入口只留 titlebar 栈）。焦点归还与兜底
     落到状态条的刷新钮——它常驻且永远可按。 */
  const refreshButton = page.querySelector<HTMLButtonElement>('[data-action="refresh"]')!;
  const pickFolderButton = page.querySelector<HTMLButtonElement>('[data-action="pick-folder"]')!;
  const detail = page.querySelector<HTMLElement>('[data-slot="detail"]')!;
  const detailCard = page.querySelector<HTMLElement>('[data-slot="detail-card"]')!;
  const toast = page.querySelector<HTMLElement>('[data-slot="toast"]')!;
  let toastTimer: number | undefined;

  const showToast = (message: TextSource, failure = false) => {
    if (disposed) return;
    if (toastTimer !== undefined) window.clearTimeout(toastTimer);
    toast.hidden = false;
    toast.classList.toggle("fail", failure);
    bindText(toast, message);
    toastTimer = window.setTimeout(() => { toast.hidden = true; }, 3_500);
  };

  const setBackgroundInert = (inert: boolean) => {
    mainSurface.inert = inert;
    sideSurface.inert = inert;
    skillsTrigger.inert = inert;
  };

  const closeCompose = (clear = !creationPromise, force = false) => {
    if (creationPromise && !pendingCanClose && !force) return;
    compose.hidden = true;
    compose.setAttribute("aria-hidden", "true");
    setBackgroundInert(false);
    if (clear) {
      promptInput.value = "";
      retryOptions = undefined;
      creationBlocked = false;
      composeProgress.hidden = true;
      // 档位预设跟着这张表单一起结束：留着的话，下次用户自己点「新任务」会莫名其妙
      // 用上一次拨杆那一档的模型 / 推理强度 / Skill，界面上却什么都没说。
      clearComposePreset();
    }
    // 长等待时允许关闭但不取消请求；入口可重新打开同一个 pending 视图。
    const returnFocus = composeReturnFocus;
    composeReturnFocus = null;
    (returnFocus?.isConnected ? returnFocus : refreshButton).focus();
  };

  /**
   * `resetEffort` 只在**换模型**时为真：不同模型的可选强度不是同一套，把上一个模型的
   * 取值留在框里，用户以为自己没改过、实际发出去的是另一套语义。所以换模型一律回到
   * 新模型自己的默认；别的调用点（如创建结束后重算禁用态）必须原样保留用户的选择。
   */
  const updateEfforts = (resetEffort = false) => {
    const current = resetEffort ? "" : effortSelect.value;
    const model = taskModels.find((item) => item.id === modelSelect.value);
    replaceChildren(effortSelect, option(() => t("compose.defaultEffort"), ""));
    for (const effort of model?.efforts ?? []) {
      effortSelect.append(option(
        effort.description ? `${effort.id} · ${effort.description}` : effort.id,
        effort.id,
      ));
    }
    // 上次用过的强度只在有强度可选时兑现一次，之后就当它不存在。
    // 换模型（resetEffort）那一次绝不兑现：那颗子弹若因首读失败留到此刻才打出去，
    // 正好会把上一个模型的强度套到新模型上——那是这段注释明令要防的事。
    const restored = !resetEffort && model && model.efforts.length > 0
      ? pendingStoredEffort
      : undefined;
    if (model && model.efforts.length > 0) pendingStoredEffort = undefined;
    const preferred = restored && model?.efforts.some((item) => item.id === restored)
      ? restored
      : current && model?.efforts.some((item) => item.id === current)
      ? current
      : model?.defaultEffort;
    effortSelect.value = preferred && model?.efforts.some((item) => item.id === preferred)
      ? preferred
      : "";
    effortSelect.disabled = !model || model.efforts.length === 0 || isCreating();
  };

  const loadTaskModels = async (force = false) => {
    if (disposed) return;
    if (!snapshot) {
      bindText(modelStatus, () => t("models.connecting"));
      return;
    }
    if (!force && taskModelsSettled) return;
    taskModelsSettled = true;
    if (!featureEnabled(snapshot.status.features, "task_options_v1")) {
      bindText(modelStatus, () => t("models.legacy"));
      return;
    }
    bindText(modelStatus, () => t("models.loading"));
    try {
      // 先等上次的默认值读完，才知道该把哪一项选中；它只读本地 KV，不会拖慢这里。
      await ensureStoredDefaults();
      if (disposed) return;
      const models = await repository.listTaskModels(force);
      if (disposed) return;
      taskModels = models;
      const current = modelSelect.value;
      replaceChildren(modelSelect, option(() => t("compose.defaultModel"), ""));
      for (const model of taskModels) {
        modelSelect.append(option(model.displayName, model.id));
      }
      const preferred = taskModels.find((item) => item.id === current)
        ?? taskModels.find((item) => item.id === storedDefaults.model)
        ?? taskModels.find((item) => item.isDefault);
      modelSelect.value = preferred?.id ?? "";
      bindText(modelStatus, () => taskModels.length > 0
        ? t("models.source")
        : t("models.empty"));
      updateEfforts();
    } catch (cause) {
      if (disposed) return;
      taskModels = [];
      replaceChildren(modelSelect, option(() => t("compose.defaultModel"), ""));
      updateEfforts();
      replaceChildren(modelStatus,
        localizedTextNode(() => t("models.unavailable", { detail: formatCodexError(cause) })),
        button(() => t("common.retry"), "retry-models", "cx-inline-action"),
      );
    }
  };

  /**
   * 把拨杆档位的起跑预设铺到表单上。
   *
   * 模型 / 推理强度要等目录读回来才知道服务端到底支持哪些，所以这里**只在候选里真有
   * 这一项时才选中**；对不上就照实说一句，不静默改成别的档位——用户以为自己在跑 xhigh，
   * 实际跑的是默认值，是比报错更坏的结果。
   */
  const applyPresetToFields = () => {
    if (disposed) return;
    // 说明写在自己的槽里，每次整条重写。早先是往模型状态行后面追加，结果一次按键会
    // 接两遍（openCompose 的异步回调一次、applyComposePreset 同步一次），
    // 再开一次表单又长一截。
    replaceChildren(presetNote);
    presetNote.hidden = true;
    if (!composePreset) return;
    const notes: Array<() => string> = [];
    if (composePreset.model !== undefined) {
      const hit = taskModels.some((item) => item.id === composePreset?.model);
      if (hit) {
        modelSelect.value = composePreset.model;
        updateEfforts();
      } else if (taskModelsSettled && taskModels.length > 0) {
        notes.push(() => t("preset.modelUnavailable", { model: composePreset?.model }));
      }
    }
    if (composePreset.effort !== undefined) {
      const hit = Array.from(effortSelect.options).some(
        (item) => item.value === composePreset?.effort,
      );
      if (hit) effortSelect.value = composePreset.effort;
      else if (taskModelsSettled && effortSelect.options.length > 1) {
        notes.push(() => t("preset.effortUnavailable", { effort: composePreset?.effort }));
      }
    }
    if (notes.length > 0) {
      bindText(presetNote, () => t("preset.join", { notes: notes.map(readText).join(codexLocale() === "zh" ? "；" : " ") }));
      presetNote.hidden = false;
    }
  };

  /**
   * 卸掉档位预设，让表单回到「手动新建任务」的样子。
   *
   * 不清的话，用户关掉这张表单、过一会儿自己点「新任务」，模型 / 推理强度 / Skill
   * 还是上一次拨杆那一档的，界面上却没有任何东西说明这是哪来的。
   */
  const clearComposePreset = () => {
    composePreset = undefined;
    deferredPreset = undefined;
    lastAppliedPrefix = "";
    replaceChildren(presetNote);
    presetNote.hidden = true;
  };

  /** 预设里的 Skill 在当前目录能不能对上（对不上要说清楚，不能默默不带）。 */
  const resolvePresetSkill = (cwd: string): { name: string; path: string } | undefined => {
    const name = composePreset?.skillName;
    if (!name) return undefined;
    const hit = snapshot?.skills
      .find((entry) => entry.cwd === cwd)
      ?.skills.find((skill) => skill.name === name && skill.enabled !== false);
    return hit?.path ? { name: hit.name, path: hit.path } : undefined;
  };

  const openCompose = () => {
    if (!compose.hidden) return;
    // body 不算返回点（titlebar 打开时 activeElement 就是它）：兜到刷新钮。
    composeReturnFocus = document.activeElement instanceof HTMLElement && document.activeElement !== document.body
      ? document.activeElement
      : refreshButton;
    compose.hidden = false;
    compose.setAttribute("aria-hidden", "false");
    setBackgroundInert(true);
    // 每次打开都从「没在搜索」的状态起步：默认目录写在 placeholder 上，列表是收起的。
    cwdQuery = "";
    cwdSearch.value = "";
    // 目录格的锁也要重算：关掉时清过 retryOptions 的话，重开就该解锁。
    syncCwdLock();
    // 关掉再打开时，按钮的文字与禁用态可能还停在上一次失败那一刻——打开路径重算一次，
    // 否则用户会看到一颗写着「重试首个回合」却其实会新建对话的按钮，或者一颗没有任何
    // 解释的灰按钮（旧代码要等 20 秒轮询或敲一个字才自己好）。
    syncSubmitButton();
    // 上次的默认值读失败过就再试一次：读不到只是少一个默认值，但一直不再试等于这一整个
    // 会话都没有「继承上次」。
    void ensureStoredDefaults();
    // 目录默认值已经摆在那了，用户下一步要做的是说清楚要干什么——焦点直接给它。
    if (creationPromise) closeComposeButton.focus();
    else promptInput.focus();
    void loadTaskModels().then(applyPresetToFields);
  };

  /**
   * 拨杆档位按下硬件键时调：铺好预设再把表单打开。
   *
   * 正文前缀直接写进输入框而不是偷偷拼在提交时——用户看得见这一档给他垫了什么话，
   * 不想要可以当场删掉。光标落在末尾，接着往下打就行。
   */
  const applyComposePreset = (preset: ComposePreset) => {
    if (refreshFailure) {
      const failure = refreshFailure;
      showToast(() => t("errors.presetDisconnected", { detail: failure() }), true);
      return;
    }
    // 还没拿到第一份快照就先攒着，等它到了再铺。
    //
    // 硬件键把插件从零拉起时就是这个时刻：没有快照就 ① 判不出只读态（会掀开一张
    // 点不动的表单）、② 模型目录还没读（预设里的 model 既选不中也不报错，填了不生效
    // 还不吭声）。把这条守在这里而不是调用方，是因为「谁在什么时候调」会变，
    // 而「没有快照就不能铺」是这个函数自己的前提。
    if (!snapshot) {
      deferredPreset = preset;
      return;
    }
    // 只读态（Driver 版本对不上）下这张表单提交不了、按钮也全被藏起来了。
    // 硬件键照样把它掀开的话，用户会盯着一张点不动的空表单——说清楚为什么更有用。
    if (snapshot.compatibility.readOnly) {
      showToast(
        () => t("errors.unsupportedCreate"),
        true,
      );
      return;
    }
    composePreset = preset;
    // 快速开始点 Skill 自带目录：对齐到 Skill 所属项目——否则 resolvePresetSkill 会在
    // 默认目录里找不到它、当成「预设缺失」丢掉。视同用户手挑（cwdPickedByUser），
    // 之后的目录刷新不许把它悄悄换掉。
    if (preset.cwd) {
      composeCwd = preset.cwd;
      cwdPickedByUser = true;
    }
    if (!creationPromise && !creationBlocked) {
      const prefix = preset.promptPrefix ?? "";
      // 换档位要先把上一档的前缀摘掉再铺新的。拨杆本来就是随手换的：在 CHAT 档按了
      // New、改主意推到 PLAN 再按一次，不摘就会得到两句互相矛盾的开场白叠在一起。
      // 用户自己动过开头（不再以旧前缀打头）就不碰——那是他写的字。
      if (lastAppliedPrefix && promptInput.value.startsWith(lastAppliedPrefix)) {
        promptInput.value = promptInput.value.slice(lastAppliedPrefix.length);
      }
      // 已经有半句没发出去的话就不覆盖，只补前缀，免得吃掉用户刚敲的内容。
      // 没有前缀的档位一个字都不加。
      if (prefix && !promptInput.value.startsWith(prefix)) {
        promptInput.value = `${prefix}${promptInput.value}`;
      }
      lastAppliedPrefix = prefix;
    }
    openCompose();
    if (!creationPromise) {
      promptInput.focus();
      const end = promptInput.value.length;
      promptInput.setSelectionRange(end, end);
    }
    applyPresetToFields();
  };

  const setSkillsDrawerOpen = (open: boolean) => {
    if (drawerOpen === open) return;
    drawerOpen = open;
    skillsDrawer.hidden = !open;
    skillsTrigger.setAttribute("aria-expanded", String(open));
    setBackgroundInert(open);
    if (open) {
      drawerReturnFocus = document.activeElement instanceof HTMLElement
        ? document.activeElement
        : skillsTrigger;
      skillsDrawerClose.focus();
    } else {
      const returnFocus = drawerReturnFocus;
      drawerReturnFocus = null;
      (returnFocus?.isConnected ? returnFocus : skillsTrigger).focus();
    }
  };

  /**
   * 选中态原样上报，历史会话也照报。
   * 历史行没有待审批，Host 侧 resolveApprovalTarget 会返回 NOT_FOUND——那正是要的结果：
   * 用户的视线停在这一行，硬件审批键就不该越过它去批别的会话里那条他没看见的命令。
   * 报 undefined 会让 Host 落进「全局只有一条就批它」的分支，等于一次盲批。
   */
  const notifySelection = () => {
    if (snapshot) options.onSnapshot?.(snapshot, selectedThreadId);
  };

  const selectButtonOf = (threadId: string) =>
    Array.from(page.querySelectorAll<HTMLElement>('[data-action="select"]'))
      .find((element) => element.dataset.threadId === threadId);

  const selectThread = (threadId: string) => {
    selectedThreadId = threadId;
    renderDashboard();
    renderSkills();
    notifySelection();
    // 列表整块重渲后原按钮已经不在 DOM 里，键盘用户会当场丢焦点、走不到第二击。
    selectButtonOf(threadId)?.focus();
  };

  /** 返回值告诉调用方这次动作到底成没成——详情层要靠它决定「关掉」还是「留着让人看清失败」。 */
  const runAction = async (action: () => Promise<void>, success: TextSource): Promise<boolean> => {
    try {
      await action();
      showToast(success);
      await refresh();
      return true;
    } catch (cause) {
      showToast(() => displayError(cause), true);
      return false;
    }
  };

  const findDashboardThread = (threadId: string): DashboardThread | undefined => {
    const groups = snapshot?.dashboard;
    if (!groups) return undefined;
    // 逐个列出五组而不是 Object.values：interface 拿不到隐式索引签名，
    // 那样写会静默退化成 any[]，行元素的类型就全丢了。
    for (const rows of [groups.waiting, groups.unseen, groups.failed, groups.other, groups.far]) {
      const found = rows.find((thread) => thread.id === threadId);
      if (found) return found;
    }
    return undefined;
  };

  /**
   * 能真正在这一页回复的审批请求。
   * 排除三类：userInput（只能去 Codex 里回答）、没有 serverRequestId 的、以及本次已经批过/拒过的
   * （`resolvedRequestIds`）。最后一类是关键：Host 快照可能比我们的动作慢一拍，
   * 不把已决的挡掉，按钮会在原地多留一会儿，用户再点一次就撞上 Host 的防重复报错。
   */
  const isResolved = (thread: DashboardThread, request: PendingRequestSummary) =>
    Number.isSafeInteger(request.serverRequestId)
    && resolvedRequestKeys.has(requestKey(thread.id, request.serverRequestId as number));

  const approvableRequests = (thread: DashboardThread) =>
    thread.pendingRequests.filter(
      (request): request is PendingRequestSummary & { serverRequestId: number } =>
        request.kind !== "userInput"
        && Number.isSafeInteger(request.serverRequestId)
        && !isResolved(thread, request),
    );

  /** 这一页回不了的等待项：列出来说明它是什么、该去哪儿处理，不给按钮。 */
  const unanswerableRequests = (thread: DashboardThread) => {
    const answerable = new Set<PendingRequestSummary>(approvableRequests(thread));
    return thread.pendingRequests.filter((request) =>
      !answerable.has(request) && !isResolved(thread, request)
    );
  };

  /**
   * 双向文本控制符会让屏幕上的字序和真实内容不一致。审批说明是用户做决定的唯一依据，
   * 而它的内容可能被 Codex 读到的仓库内容间接影响——这里统一剥掉。
   */
  const plainText = (value: string) => value.replace(/[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, "");

  const approvalText = (request: PendingRequestSummary) => {
    const summary = request.summary?.trim();
    return summary ? t("approval.summary", { summary: plainText(summary) }) : t("approval.waiting");
  };

  const unanswerableText = (request: PendingRequestSummary) => {
    const summary = request.summary?.trim();
    if (request.kind === "userInput") {
      return summary ? t("approval.replyInCodex", { summary: plainText(summary) }) : t("approval.inputUnavailable");
    }
    return t("approval.handleInCodex", { summary: approvalText(request) });
  };

  const alertIcon = () => {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "cx-icon");
    svg.setAttribute("aria-hidden", "true");
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", "#reai-icon-alert-circle");
    svg.append(use);
    return svg;
  };

  /**
   * 按设计稿的主/次层级：批准是主按钮（accent 实心），拒绝是次按钮。
   * 复用页面既有的 .cx-primary / .cx-btn，不为详情另造一套按钮皮肤。
   */
  const approvalButtons = (serverRequestId: number): HTMLButtonElement[] => {
    const deny = button(() => t("approval.deny"), "deny", "cx-btn");
    const approve = button(() => t("approval.approve"), "approve", "cx-primary");
    for (const element of [deny, approve]) {
      element.dataset.requestId = String(serverRequestId);
      // 提交期间禁用，避免同一条审批被连点两次——Host 会对第二次报「已响应」，
      // 用户先看到绿色成功再看到红色报错，反而分不清到底批没批。
      element.disabled = approvalInFlight;
    }
    return [deny, approve];
  };

  /**
   * 一次只呈现一条待审批。
   *
   * 设计稿只画了单条，而真实 Codex 会同时挂多条、还可能混进「问你个问题」这种本页答不了的。
   * 早先的做法是多条时改成列表、页脚回落成「关闭」——两个后果都不能接受：
   * ① 警示块显示的是 pendingRequests[0]，按钮批的却是第一条**可回复**的，二者可能不是同一条，
   *    等于让人在没看到内容的情况下批准；
   * ② 处理到只剩一条时布局跳变，页脚最右从「关闭」变成「批准」，鼠标停在原处就会误批。
   * 所以现在恒定是「警示块 = 页脚按钮作用的那一条」，剩下的排队，用一行说明交代还有几条。
   */
  const renderDetail = () => {
    if (detailThreadId === undefined) return;
    const thread = findDashboardThread(detailThreadId);
    if (!thread) return;

    const readOnly = snapshot?.compatibility.readOnly ?? false;
    const answerable = approvableRequests(thread);
    const current = readOnly ? undefined : answerable[0];
    const others = unanswerableRequests(thread);
    const queued = current ? answerable.length - 1 : 0;
    // 目录走 displayPath：控制字符会被换成可见的 �，跟列表行和新任务卡同一套策略。
    // 审批屏是权限最高的那一屏，不能是唯一一处让伪装过的路径原样穿过去的地方。
    const metaText = () => plainText(
      [thread.cwd && displayPath(thread.cwd), thread.id, formatRelativeTime(thread.recencyAtMs, now())]
        .filter(Boolean)
        .join(" · "),
    );
    // 兜底只在没有任何可解释的等待项时才用：waitingReason 本身就是 pendingRequests[0] 的转述，
    // 否则同一句话会先以强调样式出现一次、再以压低样式出现一次，而强调的那份看着像「现在要你决策」。
    const askText = () => current
      ? approvalText(current)
      : others.length === 0 && thread.waitingReason
        ? plainText(thread.waitingReason)
        : "";

    // 内容没变就不重建。整块重建会把焦点打回 body、把滚动位置清零，而轮询与
    // Codex 事件推送在审批场景下非常密集——那正是用户手停在按钮上的时候。
    const signature = JSON.stringify([
      thread.title,
      metaText(),
      askText(),
      others.map(unanswerableText),
      thread.preview,
      queued,
      current?.serverRequestId ?? null,
      approvalInFlight,
    ]);
    if (signature === detailSignature) return;
    detailSignature = signature;

    const activeElement = document.activeElement;
    const hadFocus = activeElement instanceof HTMLElement
      && (detailCard === activeElement || detailCard.contains(activeElement));
    // 只记动作名（approve / deny / close-detail 三个字面量），不拼用户数据进选择器。
    const activeAction = hadFocus ? (activeElement as HTMLElement).dataset.action : undefined;
    const scrollTop = detailCard.scrollTop;

    replaceChildren(detailCard);

    const title = document.createElement("h2");
    title.className = "cx-d-t";
    title.id = "cx-detail-title";
    // 卡片里所有来自 Codex 的文本都过一遍：这是审批决策界面，标题同样能被拿来伪造上下文。
    bindText(title, () => plainText(thread.title));

    const meta = document.createElement("p");
    meta.className = "cx-d-m";
    bindText(meta, metaText);
    detailCard.append(title, meta);

    if (askText()) {
      const ask = document.createElement("div");
      ask.className = "cx-d-ask";
      const text = document.createElement("span");
      bindText(text, askText);
      ask.append(alertIcon(), text);
      detailCard.append(ask);
    }
    for (const request of others) {
      const note = document.createElement("div");
      note.className = "cx-d-ask mut";
      const text = document.createElement("span");
      bindText(text, () => unanswerableText(request));
      note.append(alertIcon(), text);
      detailCard.append(note);
    }
    if (thread.preview) {
      const summary = document.createElement("p");
      summary.className = "cx-d-m";
      summary.textContent = plainText(thread.preview);
      detailCard.append(summary);
    }
    if (queued > 0) {
      const queue = document.createElement("p");
      queue.className = "cx-d-m";
      bindText(queue, () => t("approval.queued", { count: queued }));
      detailCard.append(queue);
    }

    const footer = document.createElement("div");
    footer.className = "cx-d-ft";
    if (current) footer.append(...approvalButtons(current.serverRequestId));
    else footer.append(button(() => t("common.close"), "close-detail", "cx-btn"));
    detailCard.append(footer);

    detailCard.scrollTop = scrollTop;
    if (hadFocus) {
      const restored = activeAction
        ? detailCard.querySelector<HTMLButtonElement>(`[data-action="${activeAction}"]`)
        : null;
      // 重建后同名按钮可能变成禁用（提交中），那就退回卡片本身，别把焦点丢到 body。
      (restored && !restored.disabled ? restored : detailCard).focus();
    }
  };

  const openDetail = (threadId: string) => {
    if (!detail.hidden) return;
    if (!findDashboardThread(threadId)) return;
    detailReturnFocus = document.activeElement instanceof HTMLElement
      && document.activeElement !== document.body
      ? document.activeElement
      : null;
    detailThreadId = threadId;
    detailSignature = undefined;
    detail.hidden = false;
    setBackgroundInert(true);
    renderDetail();
    // 聚焦卡片本身而不是第一颗按钮：那是「拒绝」，让破坏性选项成为默认不合适。
    detailCard.focus();
    // 详情真的渲染出来了才算「那条会话被打开」——铁规 6 的回报在最后一步。
    options.onConversationOpened?.(threadId);
  };

  /**
   * Host 从胶囊 / Tab 层待办点开这条任务：把详情视图落到这条会话上。
   *
   * 快照里还没有它（冷启动，第一份快照在途）就先攒着，等快照落地补开；等不到
   * （会话已删 / 快照一直不来）过 TTL 丢弃，用户停在列表页——诚实好过凭空开一张
   * 不存在的详情。
   */
  const openConversation = (threadId: string) => {
    if (findDashboardThread(threadId)) {
      // 详情已开着另一条时先关再开：openDetail 对「已开着」是早退，不关的话点
      // 胶囊切到另一条任务会毫无反应。
      if (!detail.hidden && detailThreadId !== threadId) closeDetail();
      selectThread(threadId);
      openDetail(threadId);
      return;
    }
    pendingConversation = { threadId, atMs: now() };
  };

  /**
   * 审批提交的唯一入口。
   * 提交前回查这条 id 是不是当前详情里真的那一条——按钮上的 id 只是 DOM 属性，
   * 快照刚换过、或 DOM 被外部改过时都不该拿它直接去调 Host（批准是有副作用的）。
   */
  const respondApproval = (serverRequestId: number, decision: "approved" | "denied") => {
    if (approvalInFlight || detailThreadId === undefined) return;
    const thread = findDashboardThread(detailThreadId);
    const current = thread ? approvableRequests(thread)[0] : undefined;
    if (!thread || !current || current.serverRequestId !== serverRequestId) {
      showToast(() => t("approval.expired"), true);
      // 失效签名强制重建：DOM 上那颗按钮带着已经不成立的 id，得把它拉回真值。
      detailSignature = undefined;
      renderDetail();
      return;
    }
    const key = requestKey(thread.id, serverRequestId);
    approvalInFlight = true;
    renderDetail();
    void runAction(async () => {
      await repository.respondApproval(serverRequestId, decision);
      // 先登记再刷新：刷新可能被合并到一个更早发出的请求上而读回旧快照，
      // 那时只有这个集合能证明这条已经处理完了。
      resolvedRequestKeys.add(key);
    }, () => decision === "approved" ? t("approval.approved") : t("approval.denied")).then((ok) => {
      approvalInFlight = false;
      if (ok) closeDetailWhenSettled();
      renderDetail();
    });
  };

  /** 审批成功后：还剩别的待审批就留在详情里继续处理，处理完最后一条才关。 */
  const closeDetailWhenSettled = () => {
    if (detailThreadId === undefined) return;
    const thread = findDashboardThread(detailThreadId);
    if (!thread || approvableRequests(thread).length === 0) closeDetail();
  };

  function closeDetail() {
    if (detailThreadId === undefined) return;
    const closedThreadId = detailThreadId;
    detailThreadId = undefined;
    detailSignature = undefined;
    detail.hidden = true;
    replaceChildren(detailCard);
    setBackgroundInert(false);
    const returnFocus = detailReturnFocus;
    detailReturnFocus = null;
    // 列表会整块重渲，原来那颗按钮多半已经不在 DOM 里了——按 threadId 重新找回同一行。
    const row = selectButtonOf(closedThreadId);
    (returnFocus?.isConnected ? returnFocus : row ?? refreshButton).focus();
  }

  /**
   * 状态徽标（稿 .cx-st）：扫一眼分档的锚，标签与分组标题解耦——「完成未读」
   * 是徽标话术，「干完了，你还没看」是分组话术，稿里就是两套。
   */
  const THREAD_BADGES: Record<DashboardThread["status"], { cls: string; key: string }> = {
    hot: { cls: "hot", key: "task.badgeWaiting" },
    done: { cls: "done", key: "task.badgeUnseen" },
    run: { cls: "run", key: "task.badgeRunning" },
    idle: { cls: "idle", key: "task.badgeIdle" },
    error: { cls: "failed", key: "task.badgeFailed" },
  };

  const renderThread = (thread: DashboardThread, readOnly: boolean): HTMLElement => {
    const article = document.createElement("article");
    article.className = `cx-task ${selectedThreadId === thread.id ? "selected" : ""}`;
    article.dataset.threadId = thread.id;

    const badge = THREAD_BADGES[thread.status] ?? THREAD_BADGES.idle;
    const badgeEl = document.createElement("span");
    badgeEl.className = `cx-st ${badge.cls}`;
    bindText(badgeEl, () => t(badge.key));

    const select = button(() => thread.title, "select", "cx-task-title");
    select.dataset.threadId = thread.id;
    select.setAttribute("aria-pressed", String(selectedThreadId === thread.id));
    // 选中后再点一次进详情；提示写在 title 上，不额外加一颗按钮占版面。
    // aria-haspopup 只在选中态给：没选中的行点下去只是选中，不该对屏幕阅读器宣告「会打开对话框」。
    if (selectedThreadId === thread.id) {
      select.setAttribute("aria-haspopup", "dialog");
      bindAttribute(select, "title", () => t("task.openDetail"));
    } else {
      bindAttribute(select, "title", () => t("task.select"));
    }
    const meta = document.createElement("p");
    meta.className = "cx-task-meta";
    bindText(meta, () => [thread.cwd && displayPath(thread.cwd), formatRelativeTime(thread.recencyAtMs, now())]
      .filter(Boolean).join(" · "));
    const body = document.createElement("div");
    body.className = "cx-task-body";
    body.append(select, meta);
    // 「它在等你什么」（稿 .cx-ask）：只有等待中的会话有，这句话比标题更决定要不要点进去。
    // 预览退位成普通摘要行——waitingReason 已经以强调样式出现，不能再重复一遍。
    if (!readOnly && thread.waitingReason) {
      const ask = document.createElement("p");
      ask.className = "cx-ask";
      const askText = document.createElement("span");
      bindText(askText, () => plainText(thread.waitingReason ?? ""));
      ask.append(alertIcon(), askText);
      body.append(ask);
    } else {
      const summary = document.createElement("p");
      summary.className = "cx-task-summary";
      bindText(summary, () => thread.preview || ({
        thinking: t("task.thinking"),
        completed: t("task.completed"),
        error: t("task.error"),
        idle: t("task.idle"),
        needsInput: t("task.needsInput"),
      } as const)[thread.state]);
      body.append(summary);
    }
    // 会话号（稿 .cx-id）：等宽小字靠右，8 位短形即可辨认，完整 id 进 title。
    const idChip = document.createElement("span");
    idChip.className = "cx-id";
    idChip.textContent = thread.id.split("-")[0] ?? thread.id;
    bindAttribute(idChip, "title", () => thread.id);

    const actions = document.createElement("div");
    actions.className = "cx-actions";

    if (!readOnly) {
      const handoff = desktopOpenAvailability(thread, snapshot?.runtimeThreads ?? [], {
        handoffFeatureKnown: featureEnabled(snapshot?.status.features, "desktop_handoff_v1"),
        handoffAvailable: snapshot?.status.desktopHandoffAvailable,
      });
      const open = button(() => handoff.label, "open", "cx-link");
      open.dataset.threadId = thread.id;
      open.dataset.writeAction = "";
      open.disabled = handoff.disabled;
      if (handoff.disabled) bindAttribute(open, "title", () => handoff.label);
      const openIcon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      openIcon.setAttribute("class", "cx-icon cx-link-ic");
      openIcon.setAttribute("aria-hidden", "true");
      const openUse = document.createElementNS("http://www.w3.org/2000/svg", "use");
      openUse.setAttribute("href", "#reai-icon-external-link");
      openIcon.append(openUse);
      open.prepend(openIcon);
      actions.append(open);
      if (thread.status === "done") {
        const seen = button(() => t("task.markSeen"), "seen", "cx-link");
        seen.dataset.threadId = thread.id;
        seen.dataset.writeAction = "";
        actions.append(seen);
      } else if (repository.localState.seenAtMs[thread.id]) {
        const unseen = button(() => t("task.markUnseen"), "unseen", "cx-link");
        unseen.dataset.threadId = thread.id;
        unseen.dataset.writeAction = "";
        actions.append(unseen);
      }
      if ((thread.state === "thinking" || thread.state === "needsInput") && thread.activeTurnId) {
        const interrupt = button(() => t("task.interrupt"), "interrupt", "cx-danger");
        interrupt.dataset.threadId = thread.id;
        interrupt.dataset.turnId = thread.activeTurnId;
        interrupt.dataset.writeAction = "";
        actions.append(interrupt);
      }
      // 审批（批准/拒绝）不再出现在列表行里——拍板结论：只在任务详情做。
      // 详情的入口是「再点一次已经选中的这一行」，见 select 动作。
    }
    article.append(badgeEl, body, idChip, actions);
    return article;
  };

  const appendGroup = (
    className: string,
    title: TextSource,
    rows: DashboardThread[],
    readOnly: boolean,
  ) => {
    if (rows.length === 0) return;
    const section = document.createElement("section");
    section.className = `cx-group ${className}`;
    const heading = document.createElement("h2");
    // DOM 构造而不是 innerHTML：title 是本文件里的中文字面量（今天零注入面），
    // 但它是这一页唯一带参数的 HTML sink——以后任何人往里拼会话数据就是一个真的
    // 注入口。车道 D（#300）交办：换成 DOM 构造把这扇门焊死（车道 B · C-2 落地）。
    heading.append(localizedTextNode(title));
    const count = document.createElement("b");
    count.textContent = String(rows.length);
    heading.append(count);
    section.append(heading, ...rows.map((thread) => renderThread(thread, readOnly)));
    groupsRoot.append(section);
  };

  const renderDashboard = () => {
    // 列表是整块重渲的，被按住的那颗按钮会离开 DOM。轮询、窗口聚焦、Codex 事件推送都会走到这里，
    // 不接管焦点的话，键盘用户选中一行后只要撞上一次刷新，第二次回车就「按了没反应」。
    const active = document.activeElement;
    const refocus = active instanceof HTMLElement && groupsRoot.contains(active)
      ? active.dataset.action === "select" ? { kind: "select" as const, threadId: active.dataset.threadId }
        : active.dataset.action === "toggle-far" ? { kind: "toggle-far" as const }
        : undefined
      : undefined;
    replaceChildren(groupsRoot);
    if (!snapshot) return;
    const { dashboard, compatibility: compat } = snapshot;
    appendGroup("hot", () => t("groups.waiting"), dashboard.waiting, compat.readOnly);
    appendGroup("done", () => t("groups.unseen"), dashboard.unseen, compat.readOnly);
    appendGroup("failed", () => t("groups.failed"), dashboard.failed, compat.readOnly);
    appendGroup("other", () => t("groups.other"), dashboard.other, compat.readOnly);
    if (dashboard.far.length > 0) {
      const far = document.createElement("section");
      far.className = "cx-group far";
      const toggle = button(() => t("groups.older", { count: dashboard.far.length }), "toggle-far", "cx-far-toggle");
      toggle.setAttribute("aria-expanded", String(farOpen));
      far.append(toggle);
      if (farOpen) far.append(...dashboard.far.map((thread) => renderThread(thread, compat.readOnly)));
      groupsRoot.append(far);
    }
    if (!groupsRoot.childElementCount) {
      const empty = document.createElement("p");
      empty.className = "cx-empty";
      bindText(empty, () => t("page.empty"));
      groupsRoot.append(empty);
    }
    /* B6-50（稿 15155-15167 .r3-note）：「交出去之后在哪儿看」教学卡。无条件渲染
       （空列表也在），钉在列表区尾部、分组与折叠之后。稿内「演示：任务完成的
       那一刻」是 mockup 演示控件（dev-btn + data-tcf），不进产品（PR 登记）。 */
    if (snapshot.hasMoreThreads) groupsRoot.append(button(() => t("history.loadMore"), "load-more", "cx-load-more"));
    groupsRoot.append(renderGlobalCapsuleNote());
    // 展开「48 小时以前」走的也是这条路径，那颗按钮同样会被重建。
    if (refocus?.kind === "select" && refocus.threadId) selectButtonOf(refocus.threadId)?.focus();
    else if (refocus?.kind === "toggle-far") {
      groupsRoot.querySelector<HTMLElement>('[data-action="toggle-far"]')?.focus();
    }
  };

  /* B6-50：DOM 构造（innerHTML 这扇门焊死——C-2 同一条护栏），文案逐字对稿。 */
  const renderGlobalCapsuleNote = () => {
    const note = document.createElement("aside");
    note.className = "cx-r3-note";
    const lead = document.createElement("b");
    bindText(lead, () => t("capsule.heading"));
    note.append(lead, localizedTextNode(() => t("capsule.body")));
    return note;
  };

  const renderSkills = () => {
    const count = snapshot?.skills.reduce(
      (total, entry) => total + entry.skills.filter((item) => item.enabled !== false).length,
      0,
    ) ?? 0;
    for (const element of skillsCounts) element.textContent = String(count);
    bindAttribute(skillsTrigger, "aria-label", () => t("skills.openCount", { count }));

    for (const skillsRoot of skillsRoots) {
      replaceChildren(skillsRoot);
      if (!snapshot) continue;
      // 稿 .cx-sk-hint：一句话说清点 Skill 与勾选各自发生什么。
      const hint = document.createElement("p");
      hint.className = "cx-sk-hint";
      bindText(hint, () => t("skills.hint"));
      skillsRoot.append(hint);
      // 稿右栏没有这张卡，但「第一次用、还没任何会话」的人需要一个挑目录的入口，
      // 所以留成低噪的「添加目录」行，而不是稿里的常驻目录卡。
      const chooseProject = button(() => t("skills.addDirectory"), "pick-skills-folder", "cx-skills-project");
      bindAttribute(chooseProject, "title", () => t("skills.directoryHint"));
      skillsRoot.append(chooseProject);
      if (snapshot.skillsError) {
        const error = document.createElement("p");
        error.className = "cx-error";
        bindText(error, () => snapshot?.skillsErrorKind === "read-failed" ? t("errors.skillsReadFailed") : snapshot?.skillsError);
        skillsRoot.append(error);
      }
      for (const entry of snapshot.skills) {
        if (entry.errors?.length) {
          const warning = document.createElement("p");
          warning.className = "cx-sk-hint";
          bindText(warning, () => t("skills.readWarnings", { count: entry.errors?.length ?? 0 }));
          skillsRoot.append(warning);
        }
        const enabledSkills = entry.skills.filter((item) => item.enabled !== false);
        if (enabledSkills.length === 0) continue;
        const group = document.createElement("section");
        group.className = "cx-skill-group";
        const cwd = document.createElement("h3");
        // 同一页里目录出现在三处，净化只做一处等于没做：换个位置照样能伪装成别的目录。
        cwd.textContent = displayPath(entry.cwd);
        group.append(cwd);
        for (const skill of enabledSkills) {
          const row = document.createElement("div");
          row.className = "cx-skill";
          // 稿的行为语义：点 Skill = 用它开始新对话。铺预设再掀表单——目录对齐到
          // Skill 所属项目、正文垫上 Skill 名，用户看得见、改得了，Enter 才真正创建。
          const main = button(() => skill.name, "start-skill", "cx-skill-main");
          main.dataset.skillName = skill.name;
          main.dataset.skillPath = skill.path;
          main.dataset.cwd = entry.cwd;
          if (snapshot.compatibility.readOnly) {
            main.disabled = true;
            bindAttribute(main, "title", () => t("errors.unsupportedCreate"));
          }
          const name = document.createElement("strong");
          name.textContent = skill.name;
          const description = document.createElement("span");
          description.textContent = skill.description || skill.shortDescription || "";
          main.append(name, description);
          row.append(main);
          // 挂载勾选与 readOnly 无关：把常用的挂进 Action 层不写任何 Codex 状态，
          // 只是记下用户的偏好；兼容性降级时也该能挂。
          const pin = document.createElement("button");
          pin.type = "button";
          pin.className = "cx-sk-pin";
          const id = mountedSkillId(entry.cwd, skill.name);
          const on = mountedSkills.has(id);
          pin.classList.toggle("on", on);
          pin.dataset.action = "toggle-skill-pin";
          pin.dataset.skillName = skill.name;
          pin.dataset.skillPath = skill.path;
          pin.dataset.cwd = entry.cwd;
          pin.dataset.skillDesc = skill.description || skill.shortDescription || "";
          pin.setAttribute("role", "switch");
          pin.setAttribute("aria-checked", String(on));
          bindAttribute(pin, "title", () => t("skills.pin"));
          bindAttribute(pin, "aria-label", () => t("skills.pinName", { name: skill.name }));
          pin.append(document.createElement("i"));
          row.append(pin);
          group.append(row);
        }
        skillsRoot.append(group);
      }
      if (count === 0 && !snapshot.skillsError && !snapshot.skills.some((entry) => entry.errors?.length)) {
        const empty = document.createElement("p");
        empty.className = "cx-empty";
        bindText(empty, () => t("skills.empty"));
        skillsRoot.append(empty);
      }
    }
  };

  /** 拉一次挂载态（勾选态的真源在 Host，别用本地缓存猜）。 */
  let mountedSkillsRead = 0;
  const refreshMountedSkills = async () => {
    const request = ++mountedSkillsRead;
    try {
      const mounts = await actionLayer.list();
      if (disposed || request !== mountedSkillsRead) return;
      mountedSkills = new Set(mounts.filter((m) => m.kind === "item").map((m) => m.itemId));
      renderSkills();
    } catch (cause) {
      console.warn("[codex-link] 读取 Action 层挂载失败", cause);
    }
  };

  /** 勾选 / 取消勾选。失败就把勾选态回到 Host 的真值，不留一个假的对勾。 */
  const toggleSkillPin = async (data: DOMStringMap) => {
    const { skillName: name, skillPath: path, cwd } = data;
    if (!name || !path || !cwd) return;
    const id = mountedSkillId(cwd, name);
    const wasOn = mountedSkills.has(id);
    try {
      if (wasOn) {
        await actionLayer.unmount("item", id);
      } else {
        await actionLayer.mount({
          kind: "item",
          id,
          title: clampActionItemText(name),
          // 设计稿原话：这一层的 Skill 行说的是「按下去会发生什么」。
          detail: data.skillDesc
            ? clampActionItemText(t("skills.actionDescription", { detail: data.skillDesc }))
            : t("skills.actionDetail"),
          // Windows 用反斜杠：只切正斜杠会把整条路径塞进右边那一小格。
          badge: clampActionItemText(cwd.split(/[/\\]/).filter(Boolean).pop() ?? cwd),
          target: {
            surfaceId: "main",
            intent: { type: "actionItem.skill", name, path, cwd } satisfies MountedSkillIntent,
          },
        });
      }
      showToast(() => wasOn ? t("skills.removed", { name }) : t("skills.added", { name }));
    } catch (cause) {
      showToast(() => displayError(cause), true);
    } finally {
      await refreshMountedSkills();
    }
  };

  /**
   * Action 层里那条 Skill 被按下：用它**起一个新对话**。
   *
   * 不复用「发给当前选中的任务」那条路——那要求用户先选中一个在跑的 thread，
   * 而这一层的承诺是「按一下就开始」，开机后第一次按时根本没有选中项。
   */
  const runMountedSkill = async (intent: MountedSkillIntent) => {
    try {
      const result = await repository.startTask({
        cwd: intent.cwd,
        skill: { name: intent.name, path: intent.path },
      });
      selectedThreadId = result.threadId;
      showToast(() => t("skills.started", { name: intent.name }));
    } catch (cause) {
      showToast(() => displayError(cause), true);
    } finally {
      await refresh();
    }
  };

  /** 目录一律按 trim 后的值判定：可用性与提交用同一个判据，免得按钮亮着却点不动。 */
  const effectiveCwd = () => composeCwd.trim();

  /**
   * ⚠️ 不能只看 `creationPromise`：`setCreating(true)` 发生在它被赋值**之前**
   * （中间还要装 pending 计时器、拼请求体），那个窗口里表单必须已经是禁用的，
   * 否则连点两下就是两次创建。
   */
  const isCreating = () => creatingTask || Boolean(creationPromise);

  /**
   * 目录这一格什么时候不能动：正在创建（改了只会让界面和真正在跑的对不上），
   * 以及**重试首个回合**——重试打的是已经建好的 thread，起 turn 的窄口根本不收 cwd，
   * 这时目录是既成事实、不是选项。让它可改而改了不生效，等于界面在撒谎。
   */
  const cwdLocked = () => isCreating() || Boolean(retryOptions);

  const syncCwdLock = () => {
    cwdSearch.disabled = cwdLocked();
    // 「选文件夹…」跟着输入框一起锁：重试首个回合时目录是既成事实，
    // 让它可点而点了不生效，等于界面在撒谎。
    pickFolderButton.disabled = cwdLocked();
    renderCwdList();
  };

  const syncSubmitButton = () => {
    submitButton.disabled = !effectiveCwd() || isCreating() || creationBlocked;
    bindText(submitButton, () => isCreating()
      ? t("compose.creating")
      : retryOptions
      ? t("compose.retryTurn")
      : t("compose.start"));
  };

  /**
   * placeholder 有两副面孔：没聚焦时它是**默认值**，聚焦时它是**用法提示**。
   * 焦点状态用自己记的标志，不读 `document.activeElement`——插件设计规范里对 WKWebView
   * 下读它有明确告警，而这里本来就只有 focus/blur 两个入口，记一个布尔更准。
   */
  const syncCwdPlaceholder = () => {
    bindAttribute(cwdSearch, "placeholder", () => cwdSearchFocused
      ? t("compose.search")
      : composeCwd ? displayPath(composeCwd) : t("compose.chooseDirectory"));
  };

  const cwdItems = () => Array.from(
    cwdList.querySelectorAll<HTMLButtonElement>('[data-action="pick-cwd"]'),
  );

  const cwdHits = () => {
    const query = cwdQuery.trim().toLowerCase();
    // 没搜索词就不摆候选：默认值已经写在 placeholder 上了，再列几条等于把
    // 「你还得挑一个」这件事凭空加回来。列表是搜索的结果，不是常驻的目录栏。
    if (!query) return [];
    // 忽略大小写：macOS 上敲 documents 找不到 Documents 只会让人以为没这个目录。
    return cwdCandidates.filter((dir) => dir.toLowerCase().includes(query));
  };

  /** 敲完字有没有结果，读屏用户也得知道；只在真的在搜索时说话，免得盖掉「已选择目录」那句。 */
  const announceCwd = (message: TextSource) => { bindText(cwdStatus, message); };

  const renderCwdList = () => {
    const query = cwdQuery.trim();
    const hits = cwdHits();
    const locked = cwdLocked();
    // 内容没变就不重建 DOM：20 秒轮询和 Host 推送都会走到这里，无条件 replaceChildren
    // 会把停在候选按钮上的键盘焦点打到 <body>，而这张卡是 aria-modal、背景已 inert，
    // 焦点掉出去就得从头 Tab 一遍。
    const signature = JSON.stringify([query.length > 0, composeCwd, locked, hits]);
    if (signature !== cwdListSignature) {
      cwdListSignature = signature;
      replaceChildren(cwdList);
      // ⚠️ 候选集本来就是空的时候不出这句：那时整格下面已经挂着「还没有用过的目录。
      // 用右边的「选文件夹…」挑一个。」，而候选为空意味着敲任何字都必然无匹配——
      // 第一次用的人随手敲个字，就会收到两句意思重复、指向同一颗按钮的话。
      // 那句说得也更准（「还没有用过的目录」比「没有匹配的目录」更贴合他的处境）。
      if (query && hits.length === 0 && cwdCandidates.length > 0) {
        const empty = document.createElement("p");
        empty.className = "dirpick-empty";
        // 逐字照设计稿。（车道 D 合入时那颗按钮还不存在，暂时换过一句不指向它的；
        // 车道 A 把「选文件夹…」接上后已按报备改回原文。）
        bindText(empty, () => t("compose.noMatchesHint"));
        cwdList.append(empty);
      }
      for (const dir of hits) {
        // 用真正的 <button>：候选是可点的，Tab 就该走得到它，
        // 也免得为了 combobox 的 role 再自造一套半吊子方向键导航。
        const item = document.createElement("button");
        item.type = "button";
        item.className = dir === composeCwd ? "dirpick-it sel" : "dirpick-it";
        item.dataset.action = "pick-cwd";
        item.dataset.cwd = dir;
        item.setAttribute("aria-pressed", String(dir === composeCwd));
        // 搜索框被锁住时候选按钮必须一起锁，否则界面显示的目录会和真正会用的那个对不上。
        item.disabled = locked;
        const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        icon.setAttribute("class", "cx-icon dpk-ic");
        icon.setAttribute("aria-hidden", "true");
        const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
        use.setAttribute("href", "#reai-icon-folder");
        icon.append(use);
        const label = document.createElement("span");
        label.textContent = displayPath(dir);
        item.append(icon, label);
        cwdList.append(item);
      }
    }
    if (query) {
      announceCwd(() => hits.length > 0 ? t("compose.matchCount", { count: hits.length }) : t("compose.noMatches"));
    }
    syncCwdPlaceholder();
  };

  const selectCwd = (dir: string) => {
    if (cwdLocked()) return;
    cwdPickedByUser = true;
    composeCwd = dir;
    void refreshSkillsForCwd(dir);
    // 选完清掉搜索词：列表收起、placeholder 换成刚选的这个，等于当场确认「好，就用它」。
    cwdQuery = "";
    cwdSearch.value = "";
    cwdSearchFocused = false;
    renderCwdList();
    syncSubmitButton();
    // 选中的目录只体现在 placeholder 上，读屏用户听不见，补一句播报。
    bindText(cwdStatus, () => t("compose.selectedAnnouncement", { directory: displayPath(dir) }));
    // 列表刚被收起，焦点不能留在一个已经不存在的按钮上（会掉到 <body>，而这张卡是
    // aria-modal，掉出去就要从头 Tab）。挑完目录的下一步就是说要做什么，焦点给它。
    if (!promptInput.disabled) promptInput.focus();
  };

  const syncComposeCwds = () => {
    // 候选按「最近用过」排：任务列表本身带 recency，Skills 那些目录没有时间戳，接在后面。
    // 顺序直接决定首次使用时 placeholder 里的默认目录，不能拿分组顺序凑合。
    const byRecency = Object.values(snapshot?.dashboard ?? {})
      .flat()
      .map((thread) => ({ cwd: thread.cwd?.trim() ?? "", at: thread.recencyAtMs }))
      .filter((row) => row.cwd)
      .sort((left, right) => right.at - left.at);
    const cwds = new Set<string>();
    // 用户刚用「选文件夹…」挑回来的排最前面：他专门去点了那颗按钮，要的多半就是它；
    // 而这些目录**还没有任何 Codex 会话**，从快照里推不出来，不自己记着就等于白挑。
    for (const picked of pickedCwds) cwds.add(picked);
    for (const row of byRecency) cwds.add(row.cwd);
    for (const entry of snapshot?.skills ?? []) {
      const dir = entry.cwd?.trim();
      if (dir) cwds.add(dir);
    }
    cwdCandidates = [...cwds];
    // 三条规矩：用户自己挑过的一律不许被刷新改掉；已经填上的值也不许在表单开着的时候
    // 被换掉（默认值是异步读回来的，可能晚于第一次快照，用户正看着的目标目录不能自己变）；
    // 只有「还没有值」时才按「上次用过的 → 最近一个」填。
    //
    // ⚠️ 上次用过的目录**不要求它还在候选集里**。候选集是「最近用过的会话」，不是目录
    // 存在性的判据——那条会话在 Codex 里被归档、或干脆老化出榜，目录照样在磁盘上。
    // 拿候选集当丢弃依据，会让「继承上次」在最需要它的时候（比如车道 A 的「选文件夹…」
    // 挑了一个候选集之外的目录）静默失效，甚至倒退成「没有可用目录」把用户挡住。
    // 目录真的没了的话，Host 建 thread 会给明确错误——那是诚实的失败。
    if (!cwdPickedByUser && (compose.hidden || !composeCwd)) {
      composeCwd = storedDefaults.cwd
        ?? (composeCwd && cwds.has(composeCwd) ? composeCwd : cwdCandidates[0] ?? "");
    }
    // 还没拿到第一份快照时不能说「没有可用目录」——那时只是还没连上，说这句是误报。
    cwdEmpty.hidden = !snapshot || cwdCandidates.length > 0 || Boolean(effectiveCwd());
    renderCwdList();
    syncSubmitButton();
  };

  // 默认值继承上次：本地 KV 读一次，早于任何网络往返，够快也够安静。
  // 这个 promise **永不 reject**——它只是「有没有上次的取值」，读不出来就当没有，
  // 绝不能反过来把新任务表单卡住；失败也不记成「已加载」，下次打开表单会再试一次。
  const ensureStoredDefaults = async (): Promise<void> => {
    if (storedDefaultsLoaded) return;
    if (!storedDefaultsPromise) {
      storedDefaultsPromise = (async () => {
        try {
          storedDefaults = await repository.loadComposeDefaults();
          if (disposed) return;
          storedDefaultsLoaded = true;
          pendingStoredEffort = storedDefaults.effort;
          syncComposeCwds();
        } catch (cause) {
          console.warn("[codex-link] 读取上次任务默认值失败", cause);
        } finally {
          storedDefaultsPromise = undefined;
        }
      })();
    }
    return storedDefaultsPromise;
  };
  void ensureStoredDefaults();

  const renderSnapshot = (next: CodexRepositorySnapshot) => {
    snapshot = next;
    const nextTaskModelFeature = featureEnabled(next.status.features, "task_options_v1");
    if (taskModelFeature !== nextTaskModelFeature) {
      taskModelFeature = nextTaskModelFeature;
      taskModelsSettled = false;
    }
    const version = next.status.version?.match(/\b\d+\.\d+\.\d+\b/)?.[0];
    connectionDot.classList.toggle("on", next.status.connected);
    connectionDot.classList.toggle("off", !next.status.connected);
    bindText(connection, () => next.status.connected ? "Codex" : t("connection.disconnected", { detail: "" }));
    bindAttribute(accountSession, "title", () => next.status.connected ? `Codex ${version ?? ""}` : next.status.lastError ?? "");
    renderAccount(accountSession, connection, accountCard, next.status.connected ? next.account : undefined, accountBusy, accountActionError);
    compatibility.hidden = !next.compatibility.readOnly;
    bindText(compatibility, () => next.compatibility.readOnly ? t("errors.unsupportedOperations") : "");
    page.querySelectorAll<HTMLElement>("[data-write-action]").forEach((element) => {
      element.hidden = next.compatibility.readOnly;
    });
    // 选中态只在这一行从看板上消失时才清。以前的判据是「不在活跃会话里」，
    // 于是历史会话和 48 小时以外的行每次刷新都被取消选中，
    // 「再点一次进详情」在那些行上就随机失效——用户的感受是「点了没反应」。
    if (selectedThreadId && !findDashboardThread(selectedThreadId)) {
      selectedThreadId = undefined;
    }
    // Host 已经撤下的审批可以忘掉了，免得这个集合无限长。
    // 只清「会话还在、但这条请求已经没了」的键：断连时 runtimeThreads 会整个空掉，
    // 那时把键全清掉，等连接恢复而 Host 还没撤下那条请求，已批过的按钮会回魂诱人再点一次。
    if (resolvedRequestKeys.size > 0) {
      const liveThreads = new Set<string>();
      const liveRequests = new Set<string>();
      for (const thread of next.runtimeThreads) {
        liveThreads.add(thread.threadId);
        for (const request of thread.pendingRequests) {
          if (Number.isSafeInteger(request.serverRequestId)) {
            liveRequests.add(requestKey(thread.threadId, request.serverRequestId as number));
          }
        }
      }
      for (const key of resolvedRequestKeys) {
        const threadId = key.slice(0, key.lastIndexOf(":"));
        if (liveThreads.has(threadId) && !liveRequests.has(key)) resolvedRequestKeys.delete(key);
      }
    }
    renderDashboard();
    renderSkills();
    syncComposeCwds();
    // 会话已经不在快照里（被清理或换了连接）——关掉详情，不留一张凭空的旧卡片。
    // 这条生命周期判定放在这里而不是 renderDetail 里：渲染函数不该有搬走用户焦点的副作用。
    if (detailThreadId !== undefined && !findDashboardThread(detailThreadId)) closeDetail();
    renderDetail();
    notifySelection();
    // 目录读回来之后必须再铺一次预设：这条路是「表单先开着、模型目录后到」，
    // 不接上的话预设里的 model / effort 永远没人去应用，也永远不会报对不上。
    if (!compose.hidden && !taskModelsSettled) void loadTaskModels().then(applyPresetToFields);
    // 快照到了，把在它之前收到的那个预设补上（此刻只读态判得出来、模型目录也读得到）。
    if (deferredPreset) {
      const preset = deferredPreset;
      deferredPreset = undefined;
      applyComposePreset(preset);
    }
    // 胶囊 / Tab 层点开的那条会话：快照里有它了就落到详情（没有就等下一份或过 TTL）。
    // TTL 先判：过期的定位即便会话晚到也不补开——半小时后凭空弹出一张详情只会吓人。
    if (pendingConversation) {
      const { threadId, atMs } = pendingConversation;
      if (now() - atMs > PENDING_CONVERSATION_TTL_MS) {
        pendingConversation = undefined;
      } else if (findDashboardThread(threadId)) {
        pendingConversation = undefined;
        selectThread(threadId);
        openDetail(threadId);
      }
    }
  };

  const refresh = async (forceReloadSkills = false): Promise<void> => {
    if (disposed) return;
    if (accountSyncInFlight) return accountSyncInFlight;
    if (refreshInFlight) {
      if (!forceReloadSkills) return refreshInFlight;
      await refreshInFlight;
      if (disposed) return;
      return refresh(true);
    }
    refreshInFlight = (async () => {
      try {
        const next = await repository.refresh({ forceReloadSkills });
        if (disposed) return;
        refreshFailure = undefined;
        errorBox.hidden = true;
        renderSnapshot(next);
      } catch (cause) {
        if (disposed) return;
        const message = () => displayError(cause);
        refreshFailure = message;
        connectionDot.classList.add("off");
        connectionDot.classList.remove("on");
        bindText(connection, () => t("connection.failed"));
        renderAccount(accountSession, connection, accountCard, undefined);
        errorBox.hidden = false;
        bindText(errorBox, message);
        // 攒着的档位预设必须在这儿有出口。没有的话：用户按下硬件键 → Host 拉起插件 →
        // 首次刷新失败（Codex 没起来）→ 表单不开、没有提示、**什么都没发生**。
        // 对一颗「按一下就开始干活」的键，这是最坏的失败模式——他分不清是键没绑上、
        // 插件没装，还是 Codex 没连上。
        //
        // 也不能让它继续攒着等下一次轮询：20 秒轮一次，Codex 半小时后起来的话，
        // 表单会自己掀开、输入框里凭空多出一句他不记得写过的话。
        if (deferredPreset) {
          deferredPreset = undefined;
          showToast(() => t("errors.presetDisconnected", { detail: formatCodexError(cause) }), true);
        }
      } finally {
        refreshInFlight = undefined;
      }
    })();
    return refreshInFlight;
  };

  const refreshSkillsForCwd = async (cwd: string) => {
    repository.setSkillsCwd(cwd);
    // Finish an earlier read before issuing the new directory query; otherwise
    // refresh single-flight can reuse the previous directory's result.
    if (refreshInFlight) await refreshInFlight;
    await refresh(true);
  };

  const scheduleRealtimeRefresh = () => {
    if (disposed) return;
    realtimeDirty = true;
    if (realtimeTimer !== undefined || realtimeRefreshActive) return;
    realtimeTimer = window.setTimeout(async () => {
      realtimeTimer = undefined;
      realtimeRefreshActive = true;
      try {
        // 合并同一波 Host 推送；刷新期间若又有事件，循环一次拿到最终状态。
        do {
          realtimeDirty = false;
          await refresh();
        } while (realtimeDirty && !disposed);
      } finally {
        realtimeRefreshActive = false;
        if (realtimeDirty && !disposed) scheduleRealtimeRefresh();
      }
    }, 100);
  };

  /**
   * 「选文件夹…」：让用户在系统面板里挑一个目录。
   *
   * Host 只回一个绝对路径，插件既不读它的内容也没有读写它的能力。挑回来的目录进候选
   * 列表并当场选中——它多半还没有任何 Codex 会话，推不出来，不记住就等于白挑。
   * 面板期间禁用按钮，防止连点弹出一叠。
   */
  const pickFolder = async () => {
    if (cwdLocked()) return;
    if (!options.pickFolder) {
      showToast(() => t("errors.folderUnsupported"), true);
      return;
    }
    pickFolderButton.disabled = true;
    try {
      const picked = (await options.pickFolder())?.trim();
      // 用户按了取消：什么都不做，也不报错——那不是失败。
      if (!picked) return;
      // 记进候选并置顶，同时当选中值。`cwdPickedByUser` 一并置位：
      // 这是用户亲手挑的，后续刷新绝不许把它换掉。
      const at = pickedCwds.indexOf(picked);
      if (at >= 0) pickedCwds.splice(at, 1);
      pickedCwds.unshift(picked);
      composeCwd = picked;
      cwdPickedByUser = true;
      // 选完清掉搜索词：列表收起、placeholder 换成刚选的这个，等于当场确认「好，就用它」。
      cwdQuery = "";
      cwdSearch.value = "";
      syncComposeCwds();
      await refreshSkillsForCwd(picked);
      showToast(() => t("compose.selected", { directory: picked }));
    } catch (cause) {
      showToast(() => displayError(cause), true);
    } finally {
      pickFolderButton.disabled = cwdLocked();
    }
  };

  const onClick = (event: Event) => {
    if (event.target === skillsDrawer) {
      setSkillsDrawerOpen(false);
      return;
    }
    if (event.target === compose) {
      closeCompose();
      return;
    }
    if (event.target === detail) {
      closeDetail();
      return;
    }
    const target = (event.target as HTMLElement | null)?.closest<HTMLButtonElement>("button[data-action]");
    if (!target || target.disabled) return;
    const action = target.dataset.action;
    if (action === "refresh-skills") {
      accountActionError = undefined;
      target.disabled = true;
      void refresh(true).finally(() => { target.disabled = false; });
    }
    if (action === "refresh") {
      if (isCreating()) { showToast(() => t("account.taskCreating"), true); return; }
      accountActionError = undefined;
      target.disabled = true;
      if (!accountSyncInFlight) {
        const earlierRead = refreshInFlight;
        accountSyncInFlight = (async () => {
          if (earlierRead) await earlierRead;
          if (!disposed) await repository.syncAccount();
        })().catch(cause => { if (!disposed) showToast(() => displayError(cause), true); })
          .finally(() => { accountSyncInFlight = undefined; });
      }
      void accountSyncInFlight.then(() => refresh(true)).finally(() => { target.disabled = false; });
    }
    if (action === "load-more") {
      target.disabled = true;
      void repository.loadMore().then(next => { if (!disposed && !refreshFailure) renderSnapshot(next); })
        .catch(cause => showToast(() => displayError(cause), true))
        .finally(() => { target.disabled = false; });
    }
    if (action === "pick-skills-folder") {
      target.disabled = true;
      void (async () => {
        try {
          const cwd = await options.pickFolder?.();
          if (cwd) await refreshSkillsForCwd(cwd);
        } catch (cause) { showToast(() => displayError(cause), true); }
        finally { target.disabled = false; }
      })();
    }
    if (action?.startsWith("login-") && !accountBusy) {
      accountBusy = true;
      accountActionError = undefined;
      const loginId = snapshot?.account?.login?.loginId;
      renderAccount(accountSession, connection, accountCard, snapshot?.account, true);
      void (async () => {
        try {
          if (action === "login-browser") await repository.login("browser");
          else if (action === "login-device") await repository.login("deviceCode");
          else if (action === "login-cancel" && loginId) await repository.cancelLogin(loginId);
          else if (action === "login-open" && loginId) await repository.openLogin(loginId);
        } catch (cause) { accountActionError = () => displayError(cause); }
        finally {
          accountBusy = false;
          // An event-triggered refresh may have started before the command completed.
          if (refreshInFlight) await refreshInFlight;
          await refresh();
        }
      })();
    }
    if (action === "new-task") openCompose();
    if (action === "close-compose") closeCompose();
    if (action === "retry-models") void loadTaskModels(true);
    if (action === "pick-folder") void pickFolder();
    if (action === "open-skills-drawer") setSkillsDrawerOpen(true);
    if (action === "close-skills-drawer") setSkillsDrawerOpen(false);
    if (action === "toggle-far") { farOpen = !farOpen; renderDashboard(); }
    if (action === "close-detail") closeDetail();
    if (action === "pick-cwd" && target.dataset.cwd) selectCwd(target.dataset.cwd.trim());
    if (action === "select" && target.dataset.threadId) {
      // 第一次点是选中，再点一次同一行才进详情——选错了直接跳走的代价太高。
      if (selectedThreadId === target.dataset.threadId) openDetail(target.dataset.threadId);
      else selectThread(target.dataset.threadId);
    }
    if (action === "open" && target.dataset.threadId) {
      void runAction(() => repository.openThread(target.dataset.threadId!), () => t("task.opened"));
    }
    if (action === "seen" && target.dataset.threadId) {
      void runAction(() => repository.markSeen(target.dataset.threadId!), () => t("task.seen"));
    }
    if (action === "unseen" && target.dataset.threadId) {
      void runAction(() => repository.markUnseen(target.dataset.threadId!), () => t("task.unseen"));
    }
    if ((action === "approve" || action === "deny") && target.dataset.requestId) {
      respondApproval(Number(target.dataset.requestId), action === "approve" ? "approved" : "denied");
    }
    if (action === "interrupt" && target.dataset.threadId && target.dataset.turnId) {
      if (!window.confirm(t("task.confirmInterrupt"))) return;
      void runAction(
        () => repository.interruptTurn(target.dataset.threadId!, target.dataset.turnId!),
        () => t("task.interrupted"),
      );
    }
    if (action === "toggle-skill-pin") {
      void toggleSkillPin(target.dataset);
    }
    if (action === "start-skill") {
      const name = target.dataset.skillName;
      const path = target.dataset.skillPath;
      const cwd = target.dataset.cwd;
      if (!name || !path || !cwd) return;
      applyComposePreset({ cwd, skillName: name, promptPrefix: `${name} ` });
    }
  };

  const setCreating = (creating: boolean) => {
    creatingTask = creating;
    if (disposed) return;
    composeForm.setAttribute("aria-busy", String(creating));
    for (const field of [modelSelect, effortSelect, promptInput]) {
      field.disabled = creating;
    }
    if (!creating) updateEfforts();
    // 目录那一格自己判：创建中锁，重试态也锁（见 cwdLocked）。「选文件夹…」跟着它走。
    syncCwdLock();
    syncSubmitButton();
    closeComposeButton.disabled = creating && !pendingCanClose;
    compose.classList.toggle("is-pending", creating);
  };

  const submitTask = (event: SubmitEvent) => {
    event.preventDefault();
    if (creationPromise || creationBlocked) return;
    if (accountSyncInFlight) { showToast(() => t("account.syncPending"), true); return; }
    const cwd = effectiveCwd();
    const prompt = promptInput.value.trim();
    if (!cwd || !prompt) return;
    pendingCanClose = false;
    composeProgress.hidden = false;
    composeProgress.classList.remove("fail");
    const progress = () => retryOptions ? t("compose.retryProgress") : t("compose.createProgress");
    bindText(composeProgress, progress);
    setCreating(true);
    pendingTimer = window.setTimeout(() => {
      pendingCanClose = true;
      closeComposeButton.disabled = false;
      bindText(composeProgress, () => t("compose.longProgress"));
    }, pendingCloseDelayMs);
    // 预设点名的 Skill 在这个目录里对不上就不带，并当场说明——默默不带会让用户以为
    // 这一档的预设生效了。
    const skill = resolvePresetSkill(cwd);
    if (composePreset?.skillName && !skill) {
      const missingName = composePreset.skillName;
      bindText(composeProgress, () => t("preset.missingSkillProgress", { name: missingName, progress: progress() }));
    }
    const request: StartTaskOptions = {
      cwd,
      text: prompt,
      model: modelSelect.value || undefined,
      effort: effortSelect.value || undefined,
      skill,
      ...retryOptions,
    };
    creationPromise = (async () => {
      try {
        const result = await repository.startTask(request);
        selectedThreadId = result.threadId;
        retryOptions = undefined;
        // 默认值继承上次：只记真正创建成功的那一次，失败的组合不该被下次继承。
        // ⚠️ 重试首个回合走的是已经建好的 thread，窄口根本不收 cwd——这时表单里的目录
        // 可能是用户刚改的、从来没跑过的那个，记下来等于给下次一个假的「上次用过」。
        // 所以只有真正新建 thread 的那一次才落盘。
        // 存不下去也只是下次少一个默认值，绝不能反过来把已经建好的任务判成失败。
        if (!request.threadId) {
          const next: ComposeDefaults = { cwd, model: request.model, effort: request.effort };
          storedDefaults = next;
          void repository.saveComposeDefaults(next).catch((cause) => {
            console.warn("[codex-link] 保存本次任务默认值失败", cause);
          });
        }
        if (!compose.hidden) closeCompose(true, true);
        else {
          promptInput.value = "";
          composeProgress.hidden = true;
        }
        showToast(() => t("compose.created"));
      } catch (cause) {
        if (cause instanceof TaskCreationError) {
          if (cause.threadId) selectedThreadId = cause.threadId;
          retryOptions = cause.outcome === "turn-failed" && cause.threadId
            ? { threadId: cause.threadId, clientUserMessageId: cause.clientUserMessageId }
            : undefined;
          creationBlocked = cause.outcome === "unknown";
        }
        if (!disposed) {
          composeProgress.hidden = false;
          bindText(composeProgress, () => displayError(cause));
          composeProgress.classList.add("fail");
          showToast(() => displayError(cause), true);
        }
      } finally {
        if (pendingTimer !== undefined) window.clearTimeout(pendingTimer);
        pendingTimer = undefined;
        pendingCanClose = false;
        creationPromise = undefined;
        // 创建期间关掉表单的那条路走不到 closeCompose 的 clear 分支（`clear = !creationPromise`），
        // 预设会留着，等创建结束用户手动点「新任务」时又被套上。在这儿收口。
        if (compose.hidden) clearComposePreset();
        setCreating(false);
        await refresh();
      }
    })();
  };

  const focusableIn = (container: HTMLElement) =>
    Array.from(container.querySelectorAll<HTMLElement>(
      // 必须是 a[href] 而不是裸 [href]：SVG 的 <use href> 也会命中，
      // 而它不可聚焦——一旦它排在真按钮前面成了 first，Tab 循环就闭不上（按键像失灵）。
      'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
    )).filter((element) => !element.hidden);

  const trapTab = (container: HTMLElement, event: KeyboardEvent) => {
    const focusable = focusableIn(container);
    const first = focusable[0];
    const last = focusable.at(-1);
    if (!first || !last) return;
    // 焦点不在可聚焦成员上时（跑到层外、或停在只能编程聚焦的卡片本身），
    // 下面的首尾判断谁都不匹配，Tab 会按文档顺序把人带出模态。先收回来再说。
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || !focusable.includes(active)) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
      return;
    }
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const onKeydown = (event: KeyboardEvent) => {
    // 详情是最上面那一层，Esc 先关它。
    if (!detail.hidden && event.key === "Escape") {
      event.preventDefault();
      closeDetail();
      return;
    }
    if (!detail.hidden && event.key === "Tab") {
      trapTab(detail, event);
      return;
    }
    if (drawerOpen && event.key === "Escape") {
      event.preventDefault();
      setSkillsDrawerOpen(false);
      return;
    }
    if (drawerOpen && event.key === "Tab") {
      trapTab(skillsDrawer, event);
      return;
    }
    if (!compose.hidden && event.key === "Tab") {
      trapTab(compose, event);
      return;
    }
    // ⚠️ 输入法组字期间的回车是「把候选词上屏」、Esc 是「取消这次组字」，都不是对表单说的话。
    // 不挡这一下，中文用户打到一半按回车就会真的开跑一个 prompt 只有半句的 Codex 任务，
    // 按 Esc 则会连整张表单一起关掉（同仓 composer.ts、todo-view.ts 都挡了这件事）。
    if (event.isComposing) return;
    if (event.key === "Escape" && !compose.hidden) closeCompose();
    if (event.target === cwdSearch && event.key === "Enter") {
      event.preventDefault();
      const first = cwdItems()[0];
      if (first?.dataset.cwd) {
        // 正在搜索、屏幕上有候选：回车＝选中第一条。此刻用户在挑目录，
        // 一次误触不该变成已经开跑的 Codex 任务。
        selectCwd(first.dataset.cwd.trim());
      } else if (!cwdQuery.trim() && !promptInput.disabled) {
        // 搜索框空着＝「就用 placeholder 里那个目录」。**这里不直接提交**：目录框一聚焦，
        // placeholder 就被「输入搜索」占着，屏幕上没有任何地方写着「将在哪个目录跑」——
        // 而把一个目录交给 agent 是有实际后果的授权（它在里面读写、执行）。
        // 所以回车＝确认这一格、把焦点交给「要做什么」；一 blur，placeholder 就换回目录名，
        // 用户恰好在下一步开始之前看见目标。
        promptInput.focus();
      }
      // 敲了词却一条也没匹配上：什么都不做——这时提交等于用一个用户没在看的目录开跑。
      return;
    }
    if (event.target === promptInput && event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      composeForm.requestSubmit();
    }
  };
  const onComposeInput = () => {
    if (!isCreating()) syncSubmitButton();
  };
  const onCwdSearchInput = () => {
    cwdQuery = cwdSearch.value;
    renderCwdList();
  };
  const onCwdSearchFocus = () => { cwdSearchFocused = true; syncCwdPlaceholder(); };
  /**
   * 焦点**离开整个目录格**时，把没落地的搜索词丢掉，列表随之收起、placeholder 换回真实目录。
   *
   * 为什么要清：有一条很容易走的路——敲「firm」看见候选却没点它，直接去写「要做什么」，
   * 然后点「开始」。此时框里明晃晃写着 firm，而 placeholder 有值时根本不显示，
   * 屏幕上没有任何地方写着「将在哪个目录跑」，任务却已经发出去了。把一个目录交给 agent
   * 是有实际后果的授权（它在里面读写、执行），不能发生在用户看不见目标的那一刻。
   *
   * ⚠️ 为什么挂 `focusout` 到整格上、而不是挂 `blur` 到输入框上：键盘用户是靠 Tab
   * 从输入框走到第 2、3 条候选的。挂在输入框上就会在 Tab 的那一瞬间把整片列表拆掉，
   * 而浏览器早就算好了要 focus 哪个元素——等它去 focus 时元素已经不在文档里，焦点直接
   * 掉到 `<body>`。那样一来「候选用 button 让 Tab 走得到」这个有意的选择就白做了。
   * `focusout` 会冒泡且带 `relatedTarget`，一个监听就能判断「焦点是不是还在这一格里」。
   *
   * 残留边界（复审 N2，已知并有意保留）：焦点还停在搜索框里直接点「开始」时，
   * 发出去的值与提交那一刻屏幕上写的**是一致的**（mousedown 先触发失焦，框已清空、
   * placeholder 已回真值），但用户按下按钮时依据的画面是清空前那一帧。要彻底消除得让
   * 搜索期间也看得见当前目标（稿子上没有这个元素，要走一次改稿报备）——
   * 留到车道 A 重画这一格时一并做。
   */
  const onCwdFieldFocusOut = (event: FocusEvent) => {
    cwdSearchFocused = false;
    const next = event.relatedTarget;
    // 焦点只是在这一格内部挪动（输入框 ⇄ 候选按钮），不算离开。
    if (next instanceof Node && cwdField.contains(next)) {
      syncCwdPlaceholder();
      return;
    }
    if (cwdQuery) {
      cwdQuery = "";
      cwdSearch.value = "";
      renderCwdList();
    } else {
      syncCwdPlaceholder();
    }
  };
  /**
   * 鼠标点候选时不让输入框失焦。WKWebView 走 Safari 行为，点按钮默认不把焦点移过去，
   * `relatedTarget` 会是 null——那就会被上面判成「焦点离开了这一格」而清掉列表，
   * click 随即落空（autocomplete 的经典坑）。键盘移动焦点则各浏览器都会给出
   * `relatedTarget`，所以两条路各由一个机制兜住。
   */
  const onCwdListMousedown = (event: MouseEvent) => event.preventDefault();
  const onModelChange = () => updateEfforts(true);
  const onFocus = () => void refresh();
  const onVisibility = () => { if (document.visibilityState === "visible") void refresh(); };
  page.addEventListener("click", onClick);
  page.addEventListener("keydown", onKeydown);
  composeForm.addEventListener("submit", submitTask);
  promptInput.addEventListener("input", onComposeInput);
  cwdSearch.addEventListener("input", onCwdSearchInput);
  cwdSearch.addEventListener("focus", onCwdSearchFocus);
  cwdField.addEventListener("focusout", onCwdFieldFocusOut);
  cwdList.addEventListener("mousedown", onCwdListMousedown);
  modelSelect.addEventListener("change", onModelChange);
  window.addEventListener("focus", onFocus);
  document.addEventListener("visibilitychange", onVisibility);
  const poll = pollIntervalMs > 0
    ? window.setInterval(() => void refresh(), pollIntervalMs)
    : undefined;

  const stopActionChanges = actionLayer.onChange?.(() => void refreshMountedSkills());
  void refreshMountedSkills();
  const stopLocale = options.locale?.onChange(({ locale }) => setCodexLocale(locale));

  return {
    refresh,
    /** Host push/overflow 短窗口合并后重同步；20 秒轮询只做兜底。 */
    notifyRealtime: scheduleRealtimeRefresh,
    /** Action 层里那条挂载的 Skill 被按下（Host 投 intent 过来）。 */
    runMountedSkill,
    getSnapshot() { return snapshot; },
    getSelectedThreadId() { return selectedThreadId; },
    /** 拨杆档位按硬件键起跑：铺好这一档的预设并打开新任务表单。 */
    applyComposePreset,
    /** titlebar「新任务」（B6-27 撤页内按钮后的入口）与测试共用的打开表单路径。 */
    openCompose,
    /** 把某条会话打开成任务详情（Host 的 host.taskConversation intent 用）。 */
    openConversation,
    dispose() {
      disposed = true;
      stopLocale?.();
      releaseLocaleBindings(root);
      stopActionChanges?.();
      if (poll !== undefined) window.clearInterval(poll);
      if (toastTimer !== undefined) window.clearTimeout(toastTimer);
      if (realtimeTimer !== undefined) window.clearTimeout(realtimeTimer);
      if (pendingTimer !== undefined) window.clearTimeout(pendingTimer);
      page.removeEventListener("click", onClick);
      page.removeEventListener("keydown", onKeydown);
      composeForm.removeEventListener("submit", submitTask);
      promptInput.removeEventListener("input", onComposeInput);
      cwdSearch.removeEventListener("input", onCwdSearchInput);
      cwdSearch.removeEventListener("focus", onCwdSearchFocus);
      cwdField.removeEventListener("focusout", onCwdFieldFocusOut);
      cwdList.removeEventListener("mousedown", onCwdListMousedown);
      modelSelect.removeEventListener("change", onModelChange);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
      root.replaceChildren();
    },
  };
}

export type CodexView = ReturnType<typeof mountCodexView>;
