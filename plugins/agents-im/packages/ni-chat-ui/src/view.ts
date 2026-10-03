import { NiChatStateCoordinator } from "./coordinator";
import { button, element, formatBytes, formatClock } from "./dom";
import type {
  ComposerAttachment,
  ConversationSummary,
  Interaction,
  MentionRef,
  Message,
  MessagePart,
  NiChatAdapter,
  NiChatEvent,
  NiChatState,
  Participant,
  Profile,
  ProfileType,
  ReplyReference,
  SentAttachmentRef,
} from "./model";

export interface NiChatViewOptions {
  adapter: NiChatAdapter;
  now?: () => number;
  /** 官方 Agents · IM surface 按设计稿进入置顶入口；通用组件仍可使用未选空态。 */
  initialConversation?: "none" | "pinned";
}

export interface NiChatView {
  dispose(): void;
  /**
   * 把一段跨 App 带进来的外部上下文（A3-24「发给 agent」）放进输入侧附件条。
   *
   * 落点：当前已开的会话；一个都没开时进**第一个**会话——这是 A4-6「不自动
   * 选中」的既定例外（「经跨窗导航落到点击上」），跨 App intent 本身就是一次
   * 用户动作，不落地就等于点了没反应。返回 false = 一个会话都没有，没处可放。
   */
  attachExternalContext(attachment: { label: string; text: string }): boolean;
  /**
   * B6-26「在 IM 里看上下文」：按 agent 身份打开对应会话（任务详情坞反向入口）。
   *
   * 匹配优先级确定化：① 先按 profile（id / displayName / username 任一命中），
   * ② 再挑会话——「本人 + 该 agent」的一对一私聊优先，其次含该 agent 的群会话；
   * 两步任一落空返回 false，不落到错误会话（调用方据此不渲染或如实提示）。
   * 稿 10401-10404「跳之前先验两头都还在」的验活由调用方（插件 app 层
   * ctx.apps 门控）承担；稿内「闪一下锚点卡」一步见 PR 登记：IM 协议预览
   * 模型尚无任务锚点卡合同，本轮为会话级跳转。
   */
  openConversationByAgent(ref: { agentId?: string; agentName: string }): boolean;
}

const PROFILE_BADGE_LABEL: Record<ProfileType, string> = {
  user: "人类",
  agent: "Agent",
  system: "System",
};

/* 抽屉成员档的副行（A4-15，对照稿 .ac-dr-mem-r 的 m.role）：协议 participants
   的 role 是 owner/admin/member 三档枚举，如实映射成中文——查不到该人的
   participant 记录时退回 @username（同为真实字段），不编「总指挥」这类稿上
   的演示文案。 */
const PARTICIPANT_ROLE_LABEL: Record<Participant["role"], string> = {
  owner: "群主",
  admin: "管理员",
  member: "成员",
};

const TRANSIENT_LABEL = {
  typing: "正在输入…",
  thinking: "正在思考…",
  tool_calling: "正在调用工具…",
} as const;

/* 「+」菜单与三个新建落点（对照设计稿 Agents 中栏 al-menu / ngLayer / scanLayer）。
   加 agent 不弹表单，转交给外脑：填字段之前得先说清楚要它干什么，
   而「把话问清楚」这件事本来就该由一个能对话的对象来做。 */
const ADD_HANDOFF_DRAFT = "我想加一个 agent，它负责……";

const GROUP_NAME_PLACEHOLDER = "这个群叫什么，比如「AI Board 01 发布小组」";
const GROUP_NAME_REQUIRED_PLACEHOLDER = "先给它起个名字——不然过两天你也认不出这是干嘛的群";
const GROUP_MEMBER_REQUIRED_PLACEHOLDER = "还要挑至少一个 agent 进来";

/* 扫描本机 Agent：纯演示数据，**不做任何真实探测**。列出来的是
   「这台机器上常见的那几个 CLI」——真实探测属于 Host 侧能力，协议接入后才有。 */
const SCAN_FOUND = [
  { id: "cc", avatarText: "◆", displayName: "Claude Code", detail: "~/Projects/example-app" },
  { id: "codex", avatarText: "⬡", displayName: "Codex", detail: "~/Projects/example-app" },
  { id: "gemini", avatarText: "✦", displayName: "Gemini CLI", detail: "~/Developer" },
  { id: "kimi", avatarText: "◇", displayName: "Kimi Code", detail: "~/.kimi-code" },
] as const;

/* 「+」清单的文件类候选（A4-13，对照稿 PLUS_ATT，文案逐字）：形态贴稿列出，
   但 Host 文件能力未接（既有 title 已承认的同一事实）——选中停在诚实边界
   提示上，不伪造附件进附件条。「使用上下文」一行是真实候选，由渲染时按
   当前会话动态生成，不写死在这里。 */
const PLUS_FILE_ITEMS = [
  { ic: "🖼", nm: "图片", ds: "截图、相册里的图" },
  { ic: "📎", nm: "文件", ds: "本机任意文件" },
] as const;

/* 上下文档位（A4-13，对照稿 CTX_SCOPES 的三档循环结构）：稿的档位是 voice
   存档口径（今天/近 3 天/全部存档），ni-chat 没有存档数据源，按真实数据源
   换成本会话的消息条数——结构同构（三档递增、点 chip 循环换挡），不编不存在的段。 */
const CONTEXT_SCOPES = [
  { count: 5, label: "最近 5 条" },
  { count: 20, label: "最近 20 条" },
  { count: Number.POSITIVE_INFINITY, label: "本会话全部" },
] as const;

/* 「回到最新」胶囊的显隐滞回（A4-10，对照稿 syncJump 的 hyst(gap, 60, 140)）：
   已显示时 gap>60 维持、未显示时要越过 140 才出现，中间是稳定区——
   边界处来回微调不会闪。 */
const JUMP_HYST_LO = 60;
const JUMP_HYST_HI = 140;

/* 待确认坞的滚动收缩滞回（A4-11，对照稿 ASK_HYST_LO/HI，同值 80/220）：往上翻
   看上下文时收缩成一条摘要、回到底部展开。间距 140 必须大于坞展开/收缩的高度
   跳变（约 108px），否则切换后的新 gap 直接落到对侧阈值之外，照样抖。 */
const ASK_HYST_LO = 80;
const ASK_HYST_HI = 220;

/* 待确认坞收缩条的问题摘要截断（对照稿 syncAsk 的 q.brief||q.text.slice(0,18)：
   协议 Interaction 没有 brief 字段，走稿的 fallback 路径——问题前 18 字）。 */
const ASK_BRIEF_SLICE = 18;

/* ===== 中栏拖宽手柄（A4-5，对照稿 alResize 那组常量）=====
   min=稿 AL_MIN（184：Agent 列表内容下界）；def 用本包既有对稿默认宽 282
   （稿 AL_DEF=264——改默认宽会牵连既有对稿断言，本条目只补手柄，复位回本包默认）；
   上限=稿 PANE_MAX（540：1080 基准窗的一半）再扣 CENTER_MIN（320：会话区下界）
   与推挤抽屉展开时的 236（稿 sideCost——抽屉在抢主轴宽度，不算进去两栏拉满
   会把聊天区挤到几十像素）。宽度概念在 760 窄档（宽度被钉死 238px）起失效，
   手柄撤掉，稿小屏短路同一条判断（断点对齐本包窄档而非稿的 520）。 */
const SIDEBAR_MIN = 184;
const SIDEBAR_DEF = 282;
const SIDEBAR_PANE_MAX = 540;
const SIDEBAR_CENTER_MIN = 320;
const SIDEBAR_DRAWER_COST = 236;
const SIDEBAR_NARROW = 760;
const SIDEBAR_W_KEY = "ni-chat.sidebarWidth";

const ERROR_LABEL: Record<string, string> = {
  MESSAGE_TEXT_REQUIRED: "请输入要发送的消息",
  CONVERSATION_NOT_FOUND: "这个会话已不可用，请刷新后重试",
  INTERACTION_NOT_FOUND: "这个问题已不可用，请刷新会话",
  INTERACTION_NOT_PENDING: "这个问题已经有人回答了，请刷新会话",
  INTERACTION_VERSION_CONFLICT: "问题状态已经更新，请重新确认",
  INTERACTION_NOT_ELIGIBLE: "你没有回答这个问题的权限",
  NETWORK_UNAVAILABLE: "网络暂时不可用，请稍后重试",
};

function userFacingError(cause: unknown, fallback: string): string {
  const code = cause instanceof Error ? cause.message : "UNKNOWN";
  console.debug("[ni.chat] adapter operation failed", code);
  return ERROR_LABEL[code] ?? fallback;
}

function conversationTitle(state: NiChatState, conversation: ConversationSummary): string {
  if (conversation.title) return conversation.title;
  const others = conversation.participantIds
    .filter((profileId) => profileId !== state.selfProfileId)
    .map((profileId) => state.profiles[profileId]?.displayName)
    .filter((value): value is string => Boolean(value));
  return others.join("、") || "只和自己";
}

function conversationProfiles(state: NiChatState, conversation: ConversationSummary): Profile[] {
  return conversation.participantIds
    .map((profileId) => state.profiles[profileId])
    .filter((profile): profile is Profile => Boolean(profile));
}

function primaryProfile(state: NiChatState, conversation: ConversationSummary): Profile | undefined {
  const profiles = conversationProfiles(state, conversation);
  return profiles.find((profile) => profile.id !== state.selfProfileId) ?? profiles[0];
}

function profileBadge(profile: Profile): HTMLElement {
  const badge = element("span", `ni-profile-badge is-${profile.type}`);
  badge.dataset.profileType = profile.type;
  const label = PROFILE_BADGE_LABEL[profile.type] ?? "未知类型";
  badge.textContent = label;
  badge.setAttribute("aria-label", `${profile.displayName}，${label}账号`);
  return badge;
}

function avatar(profile: Profile | undefined, profiles: Profile[] = []): HTMLElement {
  const node = element("span", `ni-avatar${profiles.length > 1 ? " is-group" : ""}`);
  if (profiles.length > 1) {
    profiles.slice(0, 4).forEach((member) => {
      const cell = element("i");
      cell.textContent = member.avatarText;
      cell.title = member.displayName;
      node.appendChild(cell);
    });
  } else {
    node.textContent = profile?.avatarText ?? "?";
  }
  return node;
}

function safeHost(value: string): string {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.host : "链接已隐藏";
  } catch {
    return "链接已隐藏";
  }
}

function interactionStateLabel(interaction: Interaction): string {
  switch (interaction.state) {
    case "answered": return "已回答";
    case "cancelled": return "已取消";
    case "expired": return "已过期";
    default: return "等你回答";
  }
}

function messagePreview(message: Message): string {
  if (message.deletedAt) return "消息已删除";
  const text = message.parts.find((part) => part.kind === "text");
  if (text?.kind === "text") return text.text.slice(0, 80);
  const first = message.parts[0];
  if (!first) return "消息";
  if (first.kind === "file" || first.kind === "image" || first.kind === "audio" || first.kind === "video") return first.name;
  if (first.kind === "interaction_ref") return "Interaction";
  if (first.kind === "tool_call" || first.kind === "tool_result") return first.name;
  return "消息内容";
}

function unsupportedPart(originalKind: unknown, safeSummary?: string): HTMLElement {
  const block = element("div", "ni-part-unknown");
  const kind = typeof originalKind === "string" && originalKind.trim()
    ? originalKind.slice(0, 80)
    : "unknown";
  block.textContent = `当前版本暂不支持此消息内容（${safeSummary ?? kind}）`;
  return block;
}

/* 未选对话空白页的图标（A4-6，对照稿 ac-empty-i 的 message-circle）：
   本包没有图标基建，只内联这一枚描边 SVG——线宽 1.6、尺寸随调用方，
   与稿的 data-sw="1.6" / data-sz="34" 对齐。 */
function messageCircleIcon(size: number): SVGSVGElement {
  const node = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  node.setAttribute("viewBox", "0 0 24 24");
  node.setAttribute("width", String(size));
  node.setAttribute("height", String(size));
  node.setAttribute("fill", "none");
  node.setAttribute("stroke", "currentColor");
  node.setAttribute("stroke-width", "1.6");
  node.setAttribute("stroke-linecap", "round");
  node.setAttribute("stroke-linejoin", "round");
  node.setAttribute("aria-hidden", "true");
  node.innerHTML = '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"></path>';
  return node;
}

/* 「回到最新」的下箭头（A4-10，对照稿 acJump 的 arrow-down，data-sz=12 /
   data-sw=2.2——比常规图标线更粗，小尺寸下仍要读得清方向）。 */
function arrowDownIcon(size: number, strokeWidth: number): SVGSVGElement {
  const node = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  node.setAttribute("viewBox", "0 0 24 24");
  node.setAttribute("width", String(size));
  node.setAttribute("height", String(size));
  node.setAttribute("fill", "none");
  node.setAttribute("stroke", "currentColor");
  node.setAttribute("stroke-width", String(strokeWidth));
  node.setAttribute("stroke-linecap", "round");
  node.setAttribute("stroke-linejoin", "round");
  node.setAttribute("aria-hidden", "true");
  node.innerHTML = '<path d="M12 5v14"></path><path d="m19 12-7 7-7-7"></path>';
  return node;
}

/* 待确认坞收缩条的告警图标（A4-11，对照稿 ac-ask-bar 的 alert-circle，
   data-sz=13 / data-sw=2.2——告警线在浅底告警色块上也要立得住）。 */
function alertCircleIcon(size: number, strokeWidth: number): SVGSVGElement {
  const node = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  node.setAttribute("viewBox", "0 0 24 24");
  node.setAttribute("width", String(size));
  node.setAttribute("height", String(size));
  node.setAttribute("fill", "none");
  node.setAttribute("stroke", "currentColor");
  node.setAttribute("stroke-width", String(strokeWidth));
  node.setAttribute("stroke-linecap", "round");
  node.setAttribute("stroke-linejoin", "round");
  node.setAttribute("aria-hidden", "true");
  node.innerHTML = '<circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line>';
  return node;
}

/* 输入行麦克风钮的图标（A4-16，对照稿 ac-in-btn.mic 的 mic，data-sz=14；
   path 与 agent-ui icons.ts 的 mic 同一枚——任务/日程的 composer 与这里
   是同一张脸，改一处就分叉是稿内联图标那段批评过的事）。 */
function micIcon(size: number): SVGSVGElement {
  const node = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  node.setAttribute("viewBox", "0 0 24 24");
  node.setAttribute("width", String(size));
  node.setAttribute("height", String(size));
  node.setAttribute("fill", "none");
  node.setAttribute("stroke", "currentColor");
  node.setAttribute("stroke-width", "2");
  node.setAttribute("stroke-linecap", "round");
  node.setAttribute("stroke-linejoin", "round");
  node.setAttribute("aria-hidden", "true");
  node.innerHTML = '<rect x="9" y="3" width="6" height="11" rx="3"></rect><path d="M5 11a7 7 0 0 0 14 0M12 18v3"></path>';
  return node;
}

export async function mountNiChatView(root: HTMLElement, options: NiChatViewOptions): Promise<NiChatView> {
  const bufferedEvents: NiChatEvent[] = [];
  let coordinatorRef: NiChatStateCoordinator | undefined;
  let announceEventRef: ((event: NiChatEvent) => void) | undefined;
  let hydrated = false;
  const offAdapter = options.adapter.subscribe((event) => {
    if (!hydrated || !coordinatorRef) bufferedEvents.push(event);
    else {
      const changed = coordinatorRef.apply(event);
      if (changed) announceEventRef?.(event);
    }
  });
  let initialState: NiChatState;
  try {
    initialState = await options.adapter.getSnapshot();
  } catch (cause) {
    offAdapter();
    throw cause;
  }
  /* 视图自己的时钟（与 coordinator 同源注入）：中栏「工作中」分组的到期闹钟用。 */
  const now = options.now ?? Date.now;
  const coordinator = new NiChatStateCoordinator(initialState, { now });
  coordinatorRef = coordinator;
  bufferedEvents.forEach((event) => coordinator.apply(event));
  bufferedEvents.length = 0;
  hydrated = true;
  /* 初始不自动选中任何会话（A4-6，对照稿 acEmpty 的初始未选态）：IM 里自动打开
     会话是隐私/意图问题——稿的明示理由是「不做成『自动打开上一个』——那样 Esc
     关掉对话会立刻被顶回来，退不出去」。只有用户真的点了列表项（或经跨窗导航
     落到点击上）才进入会话，也不持久化「上次会话」。 */
  let selectedConversationId = "";
  let query = "";
  let disposed = false;
  let sendError = "";
  const drafts = new Map<string, string>();
  const interactionDrafts = new Map<string, string>();
  const replyByConversation = new Map<string, ReplyReference>();
  const mentionsByConversation = new Map<string, MentionRef[]>();
  /* 「这句话要带上的东西」（A4-12，对照稿宿主 atts 的「正在写的那一条」归属）：
     按会话隔离——稿是单输入框全局态所以换会话要清，这里各会话各看各的，
     发送成功才清（对照稿 resetDraft 的「发完一条归零」）。 */
  const attachmentsByConversation = new Map<string, ComposerAttachment[]>();
  const mentionPickerOpen = new Set<string>();
  /* 打 @ 弹成员选择（A4-14，对照稿 atStart/atSel）：mentionQueryStart 记光标前
     那个 @ 的下标（-1 = 没有正在写的 @），mentionPickerIndex 是候选里的选中行
     （键盘上下移动、Enter/点击选定）。 */
  let mentionQueryStart = -1;
  let mentionPickerIndex = 0;
  /* 待确认坞（A4-11）：askDockMini 是收缩态的跨重绘记忆（对照稿 .ac-ask 的
     mini——与 jumpVisible 同一模式，重渲染从恢复值重算，稳定区不翻转）；
     askDockPinnedId 记用户 Esc 明确收起的那条（对照稿 askPinned 记引用——
     显式收起后自动展开要让位，否则刚收起、滚动一下又被顶开，Esc 等于没用）。 */
  let askDockMini = false;
  let askDockPinnedId = "";
  /* 「+」能力清单开在哪个会话（A4-13）：与 mentionPickerOpen 同一模式。 */
  const plusMenuOpenIn = new Set<string>();
  const pendingInteractions = new Set<string>();
  let renderScheduled = false;
  /* 「回到最新」胶囊当前显隐（A4-10）：滞回的「已显示」一侧要跨重绘记住，
     否则每次重渲染都从「未显示」一侧重新判一遍，稳定区里会闪。 */
  let jumpVisible = false;

  const frame = element("section", "plugin-main-frame");
  const app = element("section", "main-body ni-chat-app");
  frame.appendChild(app);
  const sidebar = element("aside", "ni-sidebar");
  const sidebarHeader = element("header", "ni-sidebar-header");
  const brand = element("div", "ni-brand");
  const brandMark = element("span", "ni-brand-mark");
  brandMark.textContent = "ni";
  const brandName = element("strong");
  brandName.textContent = "ni.chat";
  brand.append(brandMark, brandName);
  const transport = element("span", "ni-transport-badge");
  transport.textContent = coordinator.current.transport === "mock" ? "协议预览" : "已连接";
  sidebarHeader.append(brand, transport);

  const searchRow = element("div", "ni-search-row");
  const search = element("input", "ni-conversation-search");
  search.type = "search";
  search.placeholder = "搜索 agent";
  search.setAttribute("aria-label", "搜索联系人或会话");
  const addContact = button("ni-add-contact", "+");
  addContact.title = "添加";
  addContact.setAttribute("aria-label", "添加");
  addContact.setAttribute("aria-haspopup", "menu");
  addContact.setAttribute("aria-expanded", "false");
  searchRow.append(search, addContact);

  /* 「+」菜单：条目与分隔线逐字对照设计稿 al-menu。三项各有各的落点：
     add 转交外脑、group/scan 开覆盖式浮层；「（演示）重置为出厂状态」在稿里是
     mockup 的演示开关（本地数据随便改），这里的会话状态来自 adapter 快照、
     没有本地出厂状态可重置，所以渲染出来但保持禁用并说明原因，不做假门。 */
  const addMenu = element("div", "ni-add-menu");
  addMenu.setAttribute("role", "menu");
  addMenu.setAttribute("aria-label", "添加");
  const addMenuItems: Array<{ am: string; label: string }> = [
    { am: "add", label: "添加 Agent" },
    { am: "group", label: "发起群聊" },
    { am: "scan", label: "扫描本机 Agent" },
  ];
  addMenuItems.forEach(({ am, label }) => {
    const item = button("ni-add-menu-item", label);
    item.dataset.am = am;
    item.setAttribute("role", "menuitem");
    addMenu.appendChild(item);
  });
  addMenu.appendChild(element("div", "ni-add-menu-sep"));
  const addMenuReset = button("ni-add-menu-item is-demo", "（演示）重置为出厂状态");
  addMenuReset.dataset.am = "reset";
  addMenuReset.setAttribute("role", "menuitem");
  addMenuReset.disabled = true;
  addMenuReset.title = "演示重置只在独立设计稿里提供；这里的会话由 ni.chat 协议同步，没有本地出厂状态";
  addMenu.appendChild(addMenuReset);
  searchRow.appendChild(addMenu);
  const conversationList = element("div", "ni-conversation-list");
  sidebar.append(sidebarHeader, searchRow, conversationList);
  /* 拖宽手柄（A4-5，对照稿 alResize：贴在列表之后=栏最后一个子元素，稿 al-scroll
     后同位）。title 逐字对稿；稿无键盘链路，role=separator 只提供语义，不设
     tabindex——进了 Tab 序却没有键盘实现比没有更糟。 */
  const sidebarHandle = element("div", "rs-handle");
  sidebarHandle.title = "拖动调整宽度 · 双击复位";
  sidebarHandle.setAttribute("role", "separator");
  sidebarHandle.setAttribute("aria-orientation", "vertical");
  sidebarHandle.setAttribute("aria-label", "会话列表栏宽");
  sidebarHandle.setAttribute("aria-valuemin", String(SIDEBAR_MIN));
  sidebarHandle.setAttribute("aria-valuemax", String(SIDEBAR_PANE_MAX));
  sidebar.appendChild(sidebarHandle);

  const conversationPane = element("main", "ni-conversation-pane");
  const liveRegion = element("div", "ni-sr-live");
  liveRegion.setAttribute("role", "status");
  liveRegion.setAttribute("aria-live", "polite");
  liveRegion.setAttribute("aria-atomic", "true");

  /* —— 发起群聊浮层（对照稿 ngLayer）：先把「这个群是干嘛的、拉谁进来」问清楚，再建。
     不给兜底群名——放一个「新的群聊」过去等于又造出一个没有上下文的容器。 */
  const newGroupOverlay = element("div", "ni-overlay");
  newGroupOverlay.dataset.overlay = "new-group";
  newGroupOverlay.hidden = true;
  const newGroupCard = element("div", "ni-overlay-card");
  newGroupCard.setAttribute("role", "dialog");
  newGroupCard.setAttribute("aria-modal", "true");
  newGroupCard.setAttribute("aria-label", "发起群聊");
  const newGroupTitle = element("div", "ni-overlay-title");
  newGroupTitle.textContent = "发起群聊";
  const newGroupNameInput = element("input", "ni-new-group-name");
  newGroupNameInput.type = "text";
  newGroupNameInput.placeholder = GROUP_NAME_PLACEHOLDER;
  newGroupNameInput.setAttribute("aria-label", "群聊名称");
  const newGroupList = element("div", "ni-overlay-list");
  const newGroupNote = element("p", "ni-overlay-note");
  const newGroupGo = button("ni-pick-go", "建群");
  const newGroupFoot = element("div", "ni-overlay-foot");
  newGroupFoot.textContent = "点选成员 · 填好名字后建群 · Esc 取消";
  newGroupCard.append(newGroupTitle, newGroupNameInput, newGroupList, newGroupNote, newGroupGo, newGroupFoot);
  newGroupOverlay.appendChild(newGroupCard);

  /* —— 扫描本机 Agent 浮层（对照稿 scanLayer）：不确定态，不给百分比也不给
     「已扫描 N 个目录」——编出来的进度比没有进度更伤信任。 */
  const scanOverlay = element("div", "ni-overlay");
  scanOverlay.dataset.overlay = "scan-local";
  scanOverlay.hidden = true;
  const scanCard = element("div", "ni-overlay-card");
  scanCard.setAttribute("role", "dialog");
  scanCard.setAttribute("aria-modal", "true");
  scanCard.setAttribute("aria-label", "扫描本机 Agent");
  scanCard.tabIndex = -1; // 打开时把焦点接进浮层，Esc / 屏幕阅读器都以它为锚
  const scanTitle = element("div", "ni-overlay-title");
  scanTitle.textContent = "扫描本机 Agent";
  const scanBar = element("div", "ni-scan-bar");
  scanBar.appendChild(element("i"));
  const scanList = element("div", "ni-overlay-list");
  const scanNote = element("p", "ni-overlay-note");
  const scanFoot = element("div", "ni-overlay-foot");
  scanFoot.textContent = "正在找这台机器上装了什么…";
  scanCard.append(scanTitle, scanBar, scanList, scanNote, scanFoot);
  scanOverlay.appendChild(scanCard);

  /* —— 拉 agent 进群浮层（对照稿 invLayer）：会话头「更多」的群聊项落点。
     候选是「能被拉进群的 agent 里不在当前群里的」；adapter 没有改参与者
     的协议能力，选完停在诚实的协议边界提示上，不假装加进去了。 */
  const inviteOverlay = element("div", "ni-overlay");
  inviteOverlay.dataset.overlay = "invite";
  inviteOverlay.hidden = true;
  const inviteCard = element("div", "ni-overlay-card");
  inviteCard.setAttribute("role", "dialog");
  inviteCard.setAttribute("aria-modal", "true");
  inviteCard.setAttribute("aria-label", "拉 agent 进群");
  inviteCard.tabIndex = -1;
  const inviteTitle = element("div", "ni-overlay-title");
  const inviteList = element("div", "ni-overlay-list");
  const inviteNote = element("p", "ni-overlay-note");
  const inviteFoot = element("div", "ni-overlay-foot");
  inviteFoot.textContent = "点按添加 · Esc 关闭";
  inviteCard.append(inviteTitle, inviteList, inviteNote, inviteFoot);
  inviteOverlay.appendChild(inviteCard);

  /* —— 点 @ 弹的成员卡（对照稿 memCard）：小浮层，不是抽屉。
     常驻节点挂在会话面板上，renderConversation 全量重绘后重新贴位。 */
  const memberCard = element("div", "ni-member-card");

  /* —— 右侧推挤式抽屉（A4-15，对照稿 ac-drawer：任务锚点 / 群成员两档）：
     推挤不覆盖——宽度 0↔236px 参与 .ni-chat-app 的 flex 布局，主区让位而非
     蒙版盖上来（稿 CSS 原注释：跟 todo 详情的挤压式 Drawer 同一判断——长期
     开着也不该挡内容）。常驻节点挂在会话面板右侧，两档内容开抽屉时现算。 */
  const drawer = element("aside", "ni-drawer");
  const drawerInner = element("div", "ni-drawer-inner");
  /* 抽屉标题与 ✕ 同处 44px 起的紧凑页头（对照稿 .ac-dr-h / .ac-dr-acts）。 */
  const drawerHead = element("div", "ni-drawer-h");
  const drawerTitle = element("span", "ni-drawer-t");
  drawerHead.appendChild(drawerTitle);
  const drawerActs = element("div", "ni-drawer-acts");
  const drawerClose = button("ni-drawer-x", "×");
  drawerClose.type = "button";
  drawerClose.setAttribute("aria-label", "关闭抽屉");
  drawerActs.appendChild(drawerClose);
  const drawerBody = element("div", "ni-drawer-b");
  drawerInner.append(drawerHead, drawerActs, drawerBody);
  drawer.appendChild(drawerInner);
  /* 收起态 width:0 + overflow:hidden 只挡住指针，挡不住 Tab——inert + aria-hidden
     把键盘与读屏一并挡在看不见的控件外（dsh 审查意见），开抽屉时解除。 */
  drawer.inert = true;
  drawer.setAttribute("aria-hidden", "true");

  app.append(sidebar, conversationPane, drawer, newGroupOverlay, scanOverlay, inviteOverlay, liveRegion);
  root.replaceChildren(frame);

  type FocusSnapshot = {
    kind: "composer" | "interaction" | "control";
    id: string;
    selectionStart: number;
    selectionEnd: number;
  };

  function captureFocus(): FocusSnapshot | undefined {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || !conversationPane.contains(active)) return undefined;
    if (active instanceof HTMLTextAreaElement && active.classList.contains("ni-composer-input")) {
      return {
        kind: "composer",
        id: selectedConversationId,
        selectionStart: active.selectionStart,
        selectionEnd: active.selectionEnd,
      };
    }
    const interaction = active.closest<HTMLElement>("[data-interaction-id]");
    if (interaction?.dataset.interactionId) {
      return {
        kind: "interaction",
        id: interaction.dataset.interactionId,
        selectionStart: active instanceof HTMLTextAreaElement ? active.selectionStart : 0,
        selectionEnd: active instanceof HTMLTextAreaElement ? active.selectionEnd : 0,
      };
    }
    if (!active.dataset.focusId) return undefined;
    return { kind: "control", id: active.dataset.focusId, selectionStart: 0, selectionEnd: 0 };
  }

  function restoreFocus(snapshot: FocusSnapshot | undefined): void {
    if (!snapshot || disposed) return;
    let target: HTMLElement | undefined;
    if (snapshot.kind === "composer") {
      target = Array.from(conversationPane.querySelectorAll<HTMLTextAreaElement>(".ni-composer-input"))
        .find((candidate) => candidate.dataset.conversationId === snapshot.id);
    } else if (snapshot.kind === "interaction") {
      const interaction = Array.from(conversationPane.querySelectorAll<HTMLElement>("[data-interaction-id]"))
        .find((candidate) => candidate.dataset.interactionId === snapshot.id);
      target = interaction?.querySelector<HTMLTextAreaElement>(".ni-interaction-text") ?? interaction;
    } else {
      target = Array.from(conversationPane.querySelectorAll<HTMLElement>("[data-focus-id]"))
        .find((candidate) => candidate.dataset.focusId === snapshot.id);
    }
    if (!target) target = conversationPane.querySelector<HTMLTextAreaElement>(".ni-composer-input") ?? undefined;
    if (!target) return;
    target.focus();
    if (target instanceof HTMLTextAreaElement) {
      target.setSelectionRange(
        Math.min(snapshot.selectionStart, target.value.length),
        Math.min(snapshot.selectionEnd, target.value.length),
      );
    }
  }

  announceEventRef = (event) => {
    let announcement = "";
    const state = coordinator.current;
    if (event.type === "message.created" && event.message.conversationId === selectedConversationId) {
      const message = Object.values(state.messagesByConversation)
        .flat()
        .find((candidate) => candidate.id === event.message.id);
      if (message) {
        const sender = state.profiles[message.senderId]?.displayName ?? "未知账号";
        announcement = `新消息，${sender}：${messagePreview(message)}`;
      }
    } else if (event.type === "transient.updated" && event.status.conversationId === selectedConversationId) {
      announcement = TRANSIENT_LABEL[event.status.kind] ?? "会话状态已更新";
    } else if (event.type === "interaction.updated" && event.interaction.conversationId === selectedConversationId) {
      announcement = `问题状态已更新：${interactionStateLabel(event.interaction)}`;
    }
    if (!announcement) return;
    liveRegion.textContent = "";
    queueMicrotask(() => {
      if (!disposed) liveRegion.textContent = announcement;
    });
  };

  function scheduleRenderAll(): void {
    if (renderScheduled || disposed) return;
    renderScheduled = true;
    const focus = captureFocus();
    queueMicrotask(() => {
      renderScheduled = false;
      renderAll();
      restoreFocus(focus);
    });
  }

  /* ===== 中栏状态分组（B6-3，对照稿 renderAgentList 6583-6612）=====
     稿核心主张「翻这页先看谁在等我」：平铺按时间排会把正在等你确认的那条
     淹下去。稿的三组互斥归属映射到协议现有字段，不新造数据：
     - 需要你确认（wait）= needsActionCount > 0；
     - 工作中（busy）= 有活跃 transient 且不是自己（visibleTransientStatus
       已含 capability 与过期判断，thinking/tool_calling/typing 都算正在干活）；
     - 其余落「全部」。wait 优先于 busy（稿 filter 顺序同义）；
     置顶（入口）不进任何组，跟别人隔一条线。空组整组不渲染。 */
  function conversationNeedsConfirmation(conversation: ConversationSummary): boolean {
    return Boolean(conversation.needsActionCount);
  }

  interface ConversationClassification {
    /** 三组互斥归属：0=需要你确认，1=工作中，2=全部。 */
    buckets: ConversationSummary[][];
    /**
     * 与分组**同一次快照**里读到的「工作中」transient 到期时间（epoch ms）。
     * 分类和到期调度必须共用一份：分两次读 TTL 的话，跨界过期会出现
     * 「渲染进了工作中、闹钟却没排」的滞留（codex 审查抓的边界竞态）。
     */
    workingDeadlines: number[];
  }

  function classifyConversations(
    state: NiChatState,
    conversations: ConversationSummary[],
  ): ConversationClassification {
    const buckets: ConversationSummary[][] = [[], [], []];
    const workingDeadlines: number[] = [];
    conversations.forEach((conversation) => {
      if (conversationNeedsConfirmation(conversation)) {
        buckets[0]!.push(conversation);
        return;
      }
      const transient = coordinator.visibleTransientStatus(conversation.id);
      if (transient && transient.profileId !== state.selfProfileId) {
        buckets[1]!.push(conversation);
        const deadline = Date.parse(transient.expiresAt);
        if (Number.isFinite(deadline)) workingDeadlines.push(deadline);
      } else {
        buckets[2]!.push(conversation);
      }
    });
    return { buckets, workingDeadlines };
  }

  function conversationItem(state: NiChatState, conversation: ConversationSummary): HTMLButtonElement {
    const profiles = conversationProfiles(state, conversation);
    const peer = primaryProfile(state, conversation);
    const item = button(`ni-conversation-item${conversation.id === selectedConversationId ? " is-active" : ""}`, "");
    item.dataset.conversationId = conversation.id;
    if (conversation.id === selectedConversationId) item.setAttribute("aria-current", "true");
    item.appendChild(avatar(peer, conversation.type === "group" ? profiles : []));
    const copy = element("span", "ni-conversation-copy");
    const titleRow = element("span", "ni-conversation-title-row");
    const title = element("strong");
    title.textContent = conversationTitle(state, conversation);
    titleRow.appendChild(title);
    if (conversation.type !== "group" && peer) titleRow.appendChild(profileBadge(peer));
    const time = element("time");
    time.dateTime = conversation.lastMessageAt;
    time.textContent = formatClock(conversation.lastMessageAt);
    titleRow.appendChild(time);
    const previewRow = element("span", "ni-conversation-preview-row");
    const preview = element("span", "ni-conversation-preview");
    preview.textContent = conversation.lastMessagePreview;
    previewRow.appendChild(preview);
    if (conversation.needsActionCount) {
      const action = element("span", "ni-needs-action");
      action.textContent = "等你回答";
      previewRow.appendChild(action);
    } else if (conversation.muted) {
      const muted = element("span", "ni-muted");
      muted.textContent = "已静音";
      previewRow.appendChild(muted);
    }
    copy.append(titleRow, previewRow);
    item.appendChild(copy);
    if (conversation.unreadCount > 0) {
      const unread = element("span", "ni-unread");
      unread.textContent = String(conversation.unreadCount);
      item.appendChild(unread);
    }
    item.addEventListener("click", () => enterConversation(conversation));
    return item;
  }

  /* 「工作中」的到期闹钟：visibleTransientStatus 只在重渲染时判过期，之后没人
     再触发重绘的话，到期的那条会一直赖在「工作中」。按最近一个「正在计时」的
     expiresAt 排闹钟，到点补一次批量重绘把它请出去。单次 setTimeout 有
     2^31-1ms 上界：协议不限制 transient TTL，超远期的 expiresAt 直接传会被
     运行时压成 ~1ms 立即触发、重绘后又排同一个远期——变成高频空转。所以
     封顶分段续约：没到点只重排闹钟、不重绘。 */
  const TRANSIENT_ALARM_MAX_DELAY = 2 ** 31 - 1;
  let transientExpiryTimer: ReturnType<typeof setTimeout> | undefined;

  function armTransientExpiry(deadlines: readonly number[]): void {
    if (transientExpiryTimer) clearTimeout(transientExpiryTimer);
    transientExpiryTimer = undefined;
    if (disposed) return;
    const next = deadlines.slice().sort((left, right) => left - right)[0];
    if (next === undefined) return;
    // +1ms：跨过到期线再判，别在边界上抢跑（visibleTransientStatus 是严格 >）。
    const delay = Math.max(next + 1 - now(), 0);
    transientExpiryTimer = setTimeout(() => {
      transientExpiryTimer = undefined;
      if (disposed) return;
      if (next + 1 - now() <= 0) {
        // 真到点：重绘（renderList 会用同一次分类快照重排下一个闹钟）。
        scheduleRenderAll();
      } else {
        // 分段续约：只是撞了 setTimeout 上界，还没到 expiresAt——从当前状态
        // 重读一遍再排，只重排闹钟、不重绘。
        armTransientExpiry(collectWorkingDeadlines(coordinator.current));
      }
    }, Math.min(delay, TRANSIENT_ALARM_MAX_DELAY));
  }

  /* 续约路径专用：按当前状态重新收集「工作中」到期时间（renderList 走分类
     快照，不走这里——两处读的必须是各自那次判断里的同一份 TTL）。 */
  function collectWorkingDeadlines(state: NiChatState): number[] {
    return state.conversations.flatMap((conversation) => {
      if (conversation.pinned || conversationNeedsConfirmation(conversation)) return [];
      const transient = coordinator.visibleTransientStatus(conversation.id);
      return transient && transient.profileId !== state.selfProfileId
        ? [Date.parse(transient.expiresAt)].filter((ms) => Number.isFinite(ms))
        : [];
    });
  }

  function renderList(): void {
    const state = coordinator.current;
    const needle = query.trim().toLocaleLowerCase();
    const visible = state.conversations.filter((conversation) => {
      const profiles = conversationProfiles(state, conversation);
      const haystack = [
        conversationTitle(state, conversation),
        conversation.lastMessagePreview,
        ...profiles.flatMap((profile) => [profile.displayName, profile.username]),
      ].join(" ").toLocaleLowerCase();
      return !needle || haystack.includes(needle);
    }).sort((left, right) => {
      const pinned = Number(Boolean(right.pinned)) - Number(Boolean(left.pinned));
      if (pinned) return pinned;
      const recent = right.lastMessageAt.localeCompare(left.lastMessageAt);
      return recent || left.id.localeCompare(right.id);
    });
    conversationList.replaceChildren();
    if (!visible.length) {
      const empty = element("p", "ni-list-empty");
      empty.textContent = "没有匹配的联系人或会话";
      conversationList.appendChild(empty);
      // 搜索清空了可见列表：没有渲染中的「工作中」项，闹钟按空集清掉即可。
      armTransientExpiry([]);
      return;
    }
    /* 置顶项在分组之上（稿 6368-6372：它是入口，混进「全部」会被后来的挤下去，
       人找入口靠肌肉记忆）；分组按「需要你确认 → 工作中 → 全部」渲染，空组不渲染。 */
    const pinned = visible.filter((conversation) => conversation.pinned);
    const rest = visible.filter((conversation) => !conversation.pinned);
    pinned.forEach((conversation) => {
      conversationList.appendChild(conversationItem(state, conversation));
    });
    if (pinned.length) conversationList.appendChild(element("div", "ni-pin-rule"));
    /* 分类与到期闹钟共用 classifyConversations 的同一次快照：既待确认又在干活的
       按 wait 优先归「需要你确认」（稿 filter 顺序同义）——三组互斥，对用户是
       同一时刻的单一真相，DOM 里只出现一份；闹钟的 deadline 也来自这次判断，
       不会出现「渲染进了工作中、闹钟却没排」的跨界滞留。 */
    const GROUP_KEYS: readonly string[] = ["需要你确认", "工作中", "全部"];
    const { buckets, workingDeadlines } = classifyConversations(state, rest);
    buckets.forEach((items, index) => {
      if (!items.length) return;
      const header = element("div", "ni-conversation-group");
      const label = element("span", `ni-conversation-group-key${index === 0 ? " alert" : ""}`);
      label.textContent = `${GROUP_KEYS[index]} · ${items.length}`;
      header.append(label, element("span", "ni-conversation-group-rule"));
      conversationList.appendChild(header);
      items.forEach((conversation) => {
        conversationList.appendChild(conversationItem(state, conversation));
      });
    });
    armTransientExpiry(workingDeadlines);
  }

  /* Interaction 的回答动作（choice 按钮 / text 开放表单 / unknown 占位）：
     消息流内与待确认坞共用同一份构建（A4-11，对照稿「确认坞在两个宿主之间
     共享的规则只写一份」——opts 按钮与提交口径两处各写迟早一边改了另一边
     没跟上）。提交副作用（pending 防重、错误文案、重绘）也在这里统一。 */
  function buildInteractionActions(interaction: Interaction): HTMLElement {
    const actions = element("div", "ni-interaction-actions");
    if (interaction.schema.kind === "choice") {
      interaction.schema.options.forEach((option) => {
        const choice = button("ni-interaction-option", option.label);
        choice.disabled = pendingInteractions.has(interaction.id);
        choice.addEventListener("click", async () => {
          if (pendingInteractions.has(interaction.id)) return;
          pendingInteractions.add(interaction.id);
          renderConversation();
          try {
            const updated = await options.adapter.answerInteraction({
              interactionId: interaction.id,
              version: interaction.version,
              answer: { optionId: option.id },
            });
            coordinator.apply({ type: "interaction.updated", interaction: updated });
          } catch (cause) {
            sendError = userFacingError(cause, "回答暂时无法提交，请稍后重试");
          } finally {
            pendingInteractions.delete(interaction.id);
            renderConversation();
          }
        });
        actions.appendChild(choice);
      });
    } else if (interaction.schema.kind === "text") {
      const form = element("form", "ni-interaction-open-form");
      const input = element("textarea", "ni-interaction-text");
      input.rows = 2;
      input.placeholder = interaction.schema.placeholder ?? "输入回答";
      input.setAttribute("aria-label", "回答内容");
      input.value = interactionDrafts.get(interaction.id) ?? "";
      input.addEventListener("input", () => interactionDrafts.set(interaction.id, input.value));
      if (interaction.schema.maxLength) input.maxLength = interaction.schema.maxLength;
      const submit = button("ni-interaction-submit", "提交回答");
      submit.type = "submit";
      submit.disabled = pendingInteractions.has(interaction.id);
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const text = input.value.trim();
        if (!text) return;
        if (pendingInteractions.has(interaction.id)) return;
        interactionDrafts.set(interaction.id, input.value);
        pendingInteractions.add(interaction.id);
        renderConversation();
        try {
          const updated = await options.adapter.answerInteraction({
            interactionId: interaction.id,
            version: interaction.version,
            answer: { text },
          });
          interactionDrafts.delete(interaction.id);
          coordinator.apply({ type: "interaction.updated", interaction: updated });
        } catch (cause) {
          sendError = userFacingError(cause, "回答暂时无法提交，请稍后重试");
        } finally {
          pendingInteractions.delete(interaction.id);
          renderConversation();
        }
      });
      form.append(input, submit);
      actions.appendChild(form);
    } else {
      actions.appendChild(unsupportedPart(interaction.schema.originalKind));
    }
    return actions;
  }

  /* 轮到我答的未决 Interaction（A4-11）：只有这类才钉进输入坞——别人要答的
     pending 留在流内只读呈现，不冒充我的待办。同一会话有多条时只钉最早
     一条（对照稿 pendingAsk 的 stream.find：沿消息流顺序取第一条），其余
     留在流内照常可答，不因为「坞只有一个」就把待办藏掉。id 字典序对
     interaction-10 / interaction-2 这类会排错，只做无消息引用时的兜底。 */
  /* 渲染趟内 memo：一次全量重绘里 renderPart（每个 interaction_ref）与
     isDockedOnlyMessage（每条消息）都会问「坞上是哪条」，不缓存的话最坏
     形态（大量纯 interaction 消息）是平方级。缓存的失效点在 renderConversation
     开头——coordinator 的 apply 是突变更新（state 引用不变），拿引用当键
     会脏读；一次渲染趟是同步的，趟内状态不变，以「趟」为生命周期才安全。 */
  let dockInteractionMemo: { conversationId: string; result: Interaction | undefined } | undefined;

  function dockInteractionFor(conversationId: string): Interaction | undefined {
    const state = coordinator.current;
    if (dockInteractionMemo && dockInteractionMemo.conversationId === conversationId) {
      return dockInteractionMemo.result;
    }
    const mine = (interaction: Interaction): boolean =>
      interaction.conversationId === conversationId
      && interaction.state === "pending"
      && interaction.eligibleResponderIds.includes(state.selfProfileId);
    let result: Interaction | undefined;
    const messages = state.messagesByConversation[conversationId] ?? [];
    for (const message of messages) {
      for (const part of message.parts) {
        if (part.kind !== "interaction_ref") continue;
        const interaction = state.interactions[part.interactionId];
        if (interaction && mine(interaction)) { result = interaction; break; }
      }
      if (result) break;
    }
    if (!result) {
      result = Object.values(state.interactions).filter(mine).sort((left, right) => left.id.localeCompare(right.id))[0];
    }
    dockInteractionMemo = { conversationId, result };
    return result;
  }

  /* 「这条就是当前坞上那条」：还要确认它真的有坞可去——system 会话不建
     composer（readonly 分支，坞不存在），别的会话的 interaction_ref 混进
     流里时也不该在这里被藏掉。藏一个没有坞可去的待确认，等于把它从界面
     上删掉。 */
  function isDockedInteraction(interaction: Interaction): boolean {
    if (interaction.conversationId !== selectedConversationId) return false;
    const conversation = coordinator.current.conversations.find((candidate) => candidate.id === selectedConversationId);
    if (!conversation || conversation.type === "system") return false;
    return interaction.id === dockInteractionFor(interaction.conversationId)?.id;
  }

  function renderInteraction(interaction: Interaction): HTMLElement {
    const card = element("section", `ni-interaction is-${interaction.state}`);
    card.dataset.interactionId = interaction.id;
    card.tabIndex = -1;
    const eyebrow = element("div", "ni-interaction-eyebrow");
    eyebrow.textContent = interactionStateLabel(interaction);
    const prompt = element("strong", "ni-interaction-prompt");
    prompt.textContent = interaction.prompt;
    card.append(eyebrow, prompt);
    if (interaction.state === "pending" && interaction.eligibleResponderIds.includes(coordinator.current.selfProfileId)) {
      /* 走到这里的都是「没被挑进坞的那条 pending」（最早的已在坞上）：
       * 仍渲染完整动作，答案口径与坞共用 buildInteractionActions。 */
      card.appendChild(buildInteractionActions(interaction));
    } else if (interaction.answer) {
      const answer = element("p", "ni-interaction-answer");
      const selected = interaction.schema.kind === "choice"
        ? interaction.schema.options.find((option) => option.id === interaction.answer?.optionId)?.label
        : interaction.answer.text;
      answer.textContent = selected ? `你的回答：${selected}` : "回答已由服务端确认";
      card.appendChild(answer);
    }
    return card;
  }

  function renderPart(part: MessagePart): HTMLElement {
    switch (part.kind) {
      case "text": {
        const block = element("div", "ni-part-text");
        const copy = element("span");
        copy.textContent = part.text;
        block.appendChild(copy);
        part.mentions?.forEach((mention) => {
          const profile = coordinator.current.profiles[mention.profileId];
          const node = element("span", `ni-mention${profile ? " is-resolved" : " is-unresolved"}`);
          node.dataset.profileId = mention.profileId;
          node.textContent = `@${profile?.displayName ?? "未知账号"}`;
          /* 对得上人的 @ 才可点（对照稿：对不上的只高亮——点了弹不出东西，
             比不能点更让人困惑）。点它弹的是这个人的成员卡（A4-9）。 */
          if (profile) {
            node.setAttribute("role", "button");
            node.tabIndex = 0;
            node.setAttribute("aria-label", `查看 ${profile.displayName} 的成员卡`);
            node.addEventListener("click", (event) => {
              event.stopPropagation();
              showMemberCard(profile.id, node);
            });
            node.addEventListener("keydown", (event) => {
              if (event.key !== "Enter" && event.key !== " ") return;
              event.preventDefault();
              showMemberCard(profile.id, node);
            });
          }
          block.append(" ", node);
        });
        return block;
      }
      case "thinking": {
        const block = element("div", "ni-part-thinking");
        const details = element("details");
        const summary = element("summary");
        summary.textContent = "公开思考摘要";
        const copy = element("p");
        copy.textContent = part.summary;
        details.append(summary, copy);
        block.appendChild(details);
        return block;
      }
      case "tool_call": {
        const block = element("div", "ni-part-tool-call");
        const label = element("strong");
        label.textContent = part.name;
        const status = element("span");
        status.textContent = part.status === "completed" ? "调用完成" : part.status;
        block.append(label, status);
        if (part.summary) {
          const copy = element("p");
          copy.textContent = part.summary;
          block.appendChild(copy);
        }
        return block;
      }
      case "tool_result": {
        const block = element("div", `ni-part-tool-result is-${part.status}`);
        const label = element("strong");
        label.textContent = `${part.name} · ${part.status === "completed" ? "已完成" : "失败"}`;
        const copy = element("p");
        copy.textContent = part.summary;
        block.append(label, copy);
        return block;
      }
      case "image": {
        const block = element("div", "ni-part-image");
        const thumb = element("span", "ni-media-thumb");
        thumb.textContent = "IMG";
        const copy = element("span");
        copy.textContent = `${part.name} · ${part.alt}`;
        block.append(thumb, copy);
        return block;
      }
      case "audio":
      case "video": {
        const block = element("div", `ni-part-${part.kind}`);
        const icon = element("span", "ni-media-symbol");
        icon.textContent = part.kind === "audio" ? "▶" : "▷";
        const copy = element("span");
        copy.textContent = `${part.name}${part.durationSeconds ? ` · ${part.durationSeconds}s` : ""}`;
        block.append(icon, copy);
        return block;
      }
      case "file": {
        const block = element("div", "ni-part-file");
        const icon = element("span", "ni-file-icon");
        icon.textContent = "DOC";
        const copy = element("span");
        const name = element("strong");
        name.textContent = part.name;
        const meta = element("small");
        meta.textContent = `${part.mimeType} · ${formatBytes(part.sizeBytes)}`;
        copy.append(name, meta);
        block.append(icon, copy);
        return block;
      }
      case "webpage": {
        const block = element("div", "ni-part-webpage");
        const title = element("strong");
        title.textContent = part.title;
        const host = element("small");
        host.textContent = safeHost(part.url);
        block.append(title, host);
        if (part.description) {
          const copy = element("p");
          copy.textContent = part.description;
          block.appendChild(copy);
        }
        return block;
      }
      case "interaction_ref": {
        const interaction = coordinator.current.interactions[part.interactionId];
        if (interaction) {
          /* 未决的确认不在流里渲染——它钉在输入框上方的坞里（A4-11，对照稿
             renderStream 对 k==='ask' 的处理：答完了才落回流里成为记录）。
             流内这个位置留一个不可见锚，保住消息时间线上的空位语义。 */
          if (isDockedInteraction(interaction)) {
            const docked = element("span", "ni-part-ask-docked");
            docked.setAttribute("aria-hidden", "true");
            return docked;
          }
          return renderInteraction(interaction);
        }
        const missing = element("div", "ni-part-unknown");
        missing.textContent = "Interaction 暂不可用";
        return missing;
      }
      case "context_ref": {
        /* 消息流里呈现「这句话带上的东西」（A4-12，对照稿附件与文件卡片
           同语言的浅底小条）：只呈现协议给的标记字段，不补写内容。 */
        const block = element("div", "ni-part-context");
        const symbol = element("span", "ni-context-symbol");
        symbol.textContent = "〰";
        const copy = element("span");
        copy.textContent = `带上的上下文 · ${part.label} · ${part.messageCount} 条消息`;
        block.append(symbol, copy);
        return block;
      }
      case "external_context": {
        /* 跨 App 带进来的现场记录（A3-24）：同一语言的浅底小条，只报呈现名
           （label 里已带来源与字数），长转写不倒进消息流——引用是标记，
           不是正文替身。 */
        const block = element("div", "ni-part-context is-external");
        const symbol = element("span", "ni-context-symbol");
        symbol.textContent = "〰";
        const copy = element("span");
        copy.textContent = `带上的现场记录 · ${part.label}`;
        block.append(symbol, copy);
        return block;
      }
      case "unknown": {
        return unsupportedPart(part.originalKind, part.safeSummary);
      }
      default:
        return unsupportedPart((part as { kind?: unknown }).kind);
    }
  }

  /* 未决确认被钉进坞时，只含这条确认的消息整条不渲染（A4-11，对照稿
     amItem 对未答 ask 返回 ''——气泡有边框底色，留一个 display:none 的锚
     在里面就是一个空壳泡）。混排（text + interaction_ref）仍照常渲染，
     锚占位、正文可见。 */
  function isDockedOnlyMessage(message: Message): boolean {
    if (message.deletedAt || !message.parts.length) return false;
    return message.parts.every((part) => {
      if (part.kind !== "interaction_ref") return false;
      const interaction = coordinator.current.interactions[part.interactionId];
      return Boolean(interaction) && isDockedInteraction(interaction);
    });
  }

  function renderMessage(message: Message): HTMLElement {
    const state = coordinator.current;
    const sender = state.profiles[message.senderId];
    const own = message.senderId === state.selfProfileId;
    const row = element("article", `ni-message${own ? " is-own" : ""}${message.origin === "system" ? " is-system" : ""}`);
    row.dataset.messageId = message.id;
    if (!own) row.appendChild(avatar(sender));
    const body = element("div", "ni-message-body");
    if (!own && sender) {
      const senderRow = element("div", "ni-message-sender");
      const name = element("strong");
      name.textContent = sender.displayName;
      senderRow.appendChild(name);
      senderRow.appendChild(profileBadge(sender));
      body.appendChild(senderRow);
    }
    if (message.replyTo) {
      const reply = element("div", "ni-message-reply");
      const original = (state.messagesByConversation[message.conversationId] ?? [])
        .find((candidate) => candidate.id === message.replyTo?.messageId);
      const originalSender = original ? state.profiles[original.senderId] : undefined;
      reply.textContent = original
        ? `${originalSender?.displayName ?? "未知账号"}：${messagePreview(original)}`
        : "引用的消息不可用";
      body.appendChild(reply);
    }
    const bubble = element("div", "ni-message-bubble");
    if (message.deletedAt) {
      const deleted = element("p", "ni-message-deleted");
      deleted.textContent = "消息已删除";
      bubble.appendChild(deleted);
    } else {
      message.parts.forEach((part) => {
        try {
          bubble.appendChild(renderPart(part));
        } catch (cause) {
          console.debug("[ni.chat] message part render failed", cause);
          bubble.appendChild(unsupportedPart((part as { kind?: unknown }).kind));
        }
      });
    }
    const meta = element("div", "ni-message-meta");
    const time = element("time");
    time.dateTime = message.createdAt;
    time.textContent = formatClock(message.createdAt);
    meta.appendChild(time);
    if (message.revision > 1) {
      const streaming = element("span", "ni-message-revision");
      streaming.textContent = `已更新 · r${message.revision}`;
      meta.appendChild(streaming);
    }
    body.append(bubble, meta);
    const conversation = state.conversations.find((candidate) => candidate.id === message.conversationId);
    if (conversation && conversation.type !== "system") {
      const replyAction = button("ni-message-reply-action", "回复");
      replyAction.setAttribute("aria-label", `回复 ${sender?.displayName ?? "此消息"}`);
      replyAction.addEventListener("click", () => {
        replyByConversation.set(message.conversationId, {
          messageId: message.id,
          senderLabel: sender?.displayName ?? "未知账号",
          preview: messagePreview(message),
        });
        renderConversation();
        queueMicrotask(() => conversationPane.querySelector<HTMLTextAreaElement>(".ni-composer-input")?.focus());
      });
      body.appendChild(replyAction);
    }
    row.appendChild(body);
    return row;
  }

  function renderConversation(): void {
    dockInteractionMemo = undefined; // 新渲染趟：上一趟的坞判定作废（状态可能已变）
    const focus = captureFocus();
    const state = coordinator.current;
    const conversation = state.conversations.find((candidate) => candidate.id === selectedConversationId);
    const previousList = conversationPane.querySelector<HTMLElement>(".ni-message-list");
    const previousConversationId = conversationPane.dataset.conversationId;
    const previousScrollTop = previousList?.scrollTop ?? 0;
    const wasAtBottom = previousList
      ? previousList.scrollHeight - previousList.clientHeight - previousList.scrollTop <= 24
      : true;
    conversationPane.replaceChildren();
    conversationPane.dataset.conversationId = conversation?.id ?? "";
    if (!conversation) {
      /* 未选对话的空白页（A4-6，对照稿 acEmpty）：图标/主文案/键位教学三层，
         教学文案照抄稿——旋钮与 Enter/Tab 是这台硬件上的真实键位，稿在此处
         教一遍确认的两个入口（其余浮层脚注不重复教）。 */
      const empty = element("div", "ni-conversation-empty");
      const emptyIcon = element("span", "ni-conversation-empty-icon");
      emptyIcon.appendChild(messageCircleIcon(34));
      const emptyTitle = element("div", "ni-conversation-empty-title");
      emptyTitle.textContent = "选一个 agent 开始说话";
      const emptyHint = element("div", "ni-conversation-empty-hint");
      const enterKey = element("b");
      enterKey.textContent = "Enter";
      const tabKey = element("b");
      tabKey.textContent = "Tab";
      emptyHint.append("旋钮选，按下或 ", enterKey, " 进去；", tabKey, " 可以直接搜");
      empty.append(emptyIcon, emptyTitle, emptyHint);
      conversationPane.appendChild(empty);
      /* 没有选中会话时错误提示也要有地方落——「点了没反应」正是静默丢失的最差形态 */
      if (sendError) {
        const error = element("p", "ni-client-note");
        error.textContent = sendError;
        conversationPane.appendChild(error);
      }
      queueMicrotask(() => restoreFocus(focus));
      return;
    }
    const profiles = conversationProfiles(state, conversation);
    const peer = primaryProfile(state, conversation);
    const header = element("header", "ni-conversation-header");
    header.appendChild(avatar(peer, conversation.type === "group" ? profiles : []));
    const heading = element("div", "ni-conversation-heading");
    const titleRow = element("div", "ni-conversation-heading-row");
    const title = element("strong", "ni-conversation-title");
    title.textContent = conversationTitle(state, conversation);
    titleRow.appendChild(title);
    if (conversation.type !== "group" && peer) titleRow.appendChild(profileBadge(peer));
    const subtitle = element("div", "ni-conversation-subtitle");
    if (conversation.type === "group") {
      subtitle.textContent = `${profiles.length} 位成员 · 人和 Agent 共用成员与消息模型`;
    } else if (peer) {
      const presence = coordinator.visiblePresence(peer.id);
      subtitle.textContent = presence?.state === "online"
        ? "在线"
        : presence?.lastSeenAt
          ? `上次在线 ${formatClock(presence.lastSeenAt)}`
          : peer.bio ?? `@${peer.username}`;
    }
    const transient = coordinator.visibleTransientStatus(conversation.id);
    if (transient) {
      const status = element("span", "ni-transient-status");
      status.textContent = TRANSIENT_LABEL[transient.kind] ?? "状态已更新";
      subtitle.append(" · ", status);
    }
    heading.append(titleRow, subtitle);
    const members = button("ni-header-action", conversation.type === "group" ? "成员" : "资料");
    members.setAttribute("aria-label", conversation.type === "group" ? "查看群成员" : "查看联系人资料");
    if (conversation.type === "group") {
      /* 成员钮开右侧抽屉的成员档（A4-15，对照稿 acMemBtn → openDrawer('mem')；
       * 单聊的「资料」钮不接抽屉——稿上成员钮仅群聊在场）。@ 点击开的小成员卡
       * （A4-9）与抽屉并存不冲突：钮开抽屉、@ 开小卡，各走各的入口。 */
      members.dataset.drawerMode = "mem";
      members.setAttribute("aria-expanded", String(drawerMode === "mem"));
      members.classList.toggle("is-open", drawerMode === "mem");
      members.addEventListener("click", () => toggleDrawer("mem"));
    }
    /* 任务锚点钮（A4-7，对照稿 acAnchorBtn：位于成员钮与「更多」钮之间）。
       A4-15 抽屉落地后点亮：接右侧抽屉的锚点档（对照稿 acAnchorBtn →
       openDrawer('anchor')），不再禁用占位。 */
    const anchors = button("ni-header-action", "锚点");
    anchors.setAttribute("aria-label", "任务锚点");
    anchors.dataset.drawerMode = "anchor";
    anchors.setAttribute("aria-expanded", String(drawerMode === "anchor"));
    anchors.classList.toggle("is-open", drawerMode === "anchor");
    anchors.addEventListener("click", () => toggleDrawer("anchor"));
    /* 「更多」菜单（A4-8，对照稿 acMore/acMoreBtn）：只装数据里真实存在的字段
       （muted / unreadCount 在摘要里就有，invite 群聊才有），不编「置顶」——
       pinned 表达的是「入口」而不是「重要」，语义不许搅浑。 */
    const more = button("ni-header-action", "•••");
    more.setAttribute("aria-label", "会话设置");
    more.setAttribute("aria-haspopup", "menu");
    more.setAttribute("aria-expanded", String(moreMenuOpenIn === conversation.id));
    more.dataset.focusId = `more:${conversation.id}`;
    const moreMenu = element("div", "ni-more-menu");
    moreMenu.setAttribute("role", "menu");
    moreMenu.setAttribute("aria-label", "会话设置");
    moreMenuItems(conversation).forEach(({ key, label }) => {
      const item = button("ni-more-menu-item", label);
      item.dataset.acm = key;
      item.setAttribute("role", "menuitem");
      moreMenu.appendChild(item);
    });
    if (moreMenuOpenIn === conversation.id) moreMenu.classList.add("open");
    more.addEventListener("click", (event) => {
      event.stopPropagation();
      toggleMoreMenu(conversation);
    });
    moreMenu.addEventListener("click", (event) => {
      event.stopPropagation();
      const target = event.target instanceof HTMLElement ? event.target.closest<HTMLElement>("[data-acm]") : undefined;
      if (!target) return;
      pickMoreMenu(conversation, target.dataset.acm ?? "");
    });
    header.append(heading, members, anchors, more, moreMenu);

    const mockNotice = element("div", "ni-mock-notice");
    mockNotice.textContent = state.transport === "mock"
      ? "协议预览数据 · 真实消息将在 ni-chat Host Broker 接入后启用"
      : "消息由 ni-chat 协议同步";

    const messageList = element("div", "ni-message-list");
    messageList.setAttribute("role", "log");
    messageList.setAttribute("aria-label", `${conversationTitle(state, conversation)}的消息`);
    (state.messagesByConversation[conversation.id] ?? []).forEach((message) => {
      if (isDockedOnlyMessage(message)) return;
      messageList.appendChild(renderMessage(message));
    });

    const composerArea = element("footer", "ni-composer");
    if (conversation.type === "system") {
      const readonly = element("p", "ni-system-readonly");
      readonly.textContent = "系统公告为只读会话";
      composerArea.appendChild(readonly);
    } else {
      /* 输入区三层同属一块（A4-10/12/13，对照稿 ac-foot 的结构注释）：
         附件条 / 输入行住在这条主轴上，「回到最新」与「+」清单两个浮层贴着
         它的顶边（bottom:calc(100% + 8px)）——带了附件、来了引用，输入区长高，
         浮层跟着上移，不用各写各的数字。 */
      const composerMain = element("div", "ni-composer-main");

      /* 「回到最新」胶囊（A4-10，对照稿 acJump：arrow-down + 文案「回到最新」，
         居中贴输入区顶边）。显隐由 syncJump 的滞回驱动（滚动监听在下方挂）。 */
      const jump = button("ni-jump", "");
      jump.type = "button";
      jump.setAttribute("aria-label", "回到最新");
      jump.appendChild(arrowDownIcon(12, 2.2));
      jump.append("回到最新");
      jump.classList.toggle("show", jumpVisible);
      jump.addEventListener("click", () => {
        messageList.scrollTo({ top: messageList.scrollHeight, behavior: "smooth" });
      });
      composerMain.appendChild(jump);

      /* 待确认坞（A4-11，对照稿 ac-ask：钉在输入框正上方，不随消息流滚走）。
       * 数据源是协议里真实的 pending Interaction（轮到我答的最早一条）——
       * 收缩条摘要 + 问题全文 + 回答动作，回答动作与消息流内共用同一份构建。
       * 收缩/展开由滚动的 80/220 滞回驱动（syncAskDock，挂在消息流的 scroll 上）。 */
      const dockInteraction = dockInteractionFor(conversation.id);
      if (dockInteraction) {
        const askDock = element("section", `ni-ask-dock${askDockMini ? " is-mini" : ""}`);
        askDock.dataset.interactionId = dockInteraction.id;
        askDock.tabIndex = -1; // 与流内交互卡同一口径：程序可聚焦、不进 Tab 序
        askDock.setAttribute("aria-label", "待确认");
        const askBar = button("ni-ask-bar", "");
        askBar.type = "button";
        askBar.appendChild(alertCircleIcon(13, 2.2));
        const askBarTitle = element("span", "ni-ask-bar-t");
        /* 稿：'等你确认：' + (brief || 问题前 18 字)。协议没有 brief 字段，
         * 走稿的 fallback 路径；截断只进收缩条，问题全文在展开的 body 里。 */
        askBarTitle.textContent = `等你确认：${dockInteraction.prompt.slice(0, ASK_BRIEF_SLICE)}`;
        askBar.appendChild(askBarTitle);
        /* 稿收缩条上的「Action」键位徽标不画：那是键盘 Action 键的提示，插件
         * WebView 内没有这条键位链路（#345 把「+」清单脚注的旋钮键位换成点选
         * 文案是同一先例）——mini 态点收缩条即展开并回到最新。 */
        askBar.addEventListener("click", () => expandAskDock(messageList));
        const askBody = element("div", "ni-ask-body");
        const askQuestion = element("p", "ni-ask-q");
        askQuestion.textContent = dockInteraction.prompt;
        askBody.append(askQuestion, buildInteractionActions(dockInteraction));
        askDock.append(askBar, askBody);
        composerMain.appendChild(askDock);
      }

      /* 「这句话要带上的东西」附件条（A4-12，对照稿 ac-att：贴着输入框，因为
         它是内容的一部分）。当前附件只有上下文一种（scope 型：一片可调的范围，
         点 chip 本体换档、「换」字标记 + 虚线描边与普通附件区分——形状+文字
         双通道）；图片/文件的 Host 通道未接，不伪造。 */
      const attachments = attachmentsByConversation.get(conversation.id) ?? [];
      if (attachments.length) {
        const attachBar = element("div", "ni-composer-attachments");
        attachBar.setAttribute("aria-label", "这句话要带上的东西");
        attachments.forEach((attachment, index) => {
          if (attachment.kind === "external-context") {
            /* 跨 App 带进来的固定内容（A3-24）：与 scope 型同族但不可换挡——
               引用的是一段固定的转写，不是一片可调的范围；title 给出全文出处。 */
            const chip = element("div", "ni-composer-attachment is-external");
            chip.title = attachment.label;
            const symbol = element("span", "ni-composer-attachment-ic");
            symbol.textContent = "〰";
            const name = element("b");
            name.textContent = attachment.label;
            const remove = button("ni-composer-attachment-x", "×");
            remove.type = "button";
            remove.setAttribute("aria-label", `移除 ${attachment.label}`);
            remove.dataset.focusId = `attachment-remove:${conversation.id}:${index}`;
            remove.addEventListener("click", (event) => {
              event.stopPropagation();
              const list = attachmentsByConversation.get(conversation.id) ?? [];
              attachmentsByConversation.set(conversation.id, list.filter((_, i) => i !== index));
              sendError = "";
              renderConversation();
            });
            chip.append(symbol, name, remove);
            attachBar.appendChild(chip);
            return;
          }
          if (attachment.kind !== "context") return;
          const chip = element("div", "ni-composer-attachment is-scope");
          chip.dataset.attachmentScope = String(attachment.scope);
          chip.title = "点一下换范围";
          chip.setAttribute("role", "button");
          chip.tabIndex = 0;
          chip.dataset.focusId = `attachment:${conversation.id}:${index}`;
          const symbol = element("span", "ni-composer-attachment-ic");
          symbol.textContent = "〰";
          const name = element("b");
          name.textContent = `上下文 · ${attachment.scopeLabel}`;
          const swap = element("span", "ni-composer-attachment-swap");
          swap.textContent = "换";
          const remove = button("ni-composer-attachment-x", "×");
          remove.type = "button";
          remove.setAttribute("aria-label", `移除上下文 ${attachment.scopeLabel}`);
          remove.dataset.focusId = `attachment-remove:${conversation.id}:${index}`;
          remove.addEventListener("click", (event) => {
            event.stopPropagation();
            const list = attachmentsByConversation.get(conversation.id) ?? [];
            attachmentsByConversation.set(conversation.id, list.filter((_, i) => i !== index));
            sendError = "";
            renderConversation();
          });
          chip.addEventListener("click", () => {
            cycleContextScope(conversation.id);
          });
          chip.addEventListener("keydown", (event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            /* × 是内嵌在 chip 里的真按钮：聚焦它按 Enter/Space 时事件冒泡到这里，
               若照单全收会把按钮的原生合成 click 防掉、就地换档——「移除」被偷成
               「换范围」，键盘用户从此没有任何移除附件的路径。只认 chip 自己。 */
            if (event.target !== chip) return;
            event.preventDefault();
            cycleContextScope(conversation.id);
          });
          chip.append(symbol, name, swap, remove);
          attachBar.appendChild(chip);
        });
        composerMain.appendChild(attachBar);
      }

      const reply = replyByConversation.get(conversation.id);
      if (reply) {
        const replyBar = element("div", "ni-composer-reply");
        const replyCopy = element("span");
        replyCopy.textContent = `回复 ${reply.senderLabel}：${reply.preview}`;
        const cancelReply = button("ni-composer-reply-cancel", "×");
        cancelReply.setAttribute("aria-label", "取消回复");
        cancelReply.dataset.focusId = `reply-cancel:${conversation.id}`;
        cancelReply.addEventListener("click", () => {
          replyByConversation.delete(conversation.id);
          renderConversation();
        });
        replyBar.append(replyCopy, cancelReply);
        composerMain.appendChild(replyBar);
      }
      const selectedMentions = mentionsByConversation.get(conversation.id) ?? [];
      if (selectedMentions.length) {
        const chips = element("div", "ni-composer-mentions");
        selectedMentions.forEach((mention) => {
          const chip = button("ni-composer-mention-chip", `@${mention.label} ×`);
          chip.dataset.composerMentionId = mention.profileId;
          chip.dataset.focusId = `mention-chip:${mention.profileId}`;
          chip.setAttribute("aria-label", `移除提及 ${mention.label}`);
          chip.addEventListener("click", () => {
            mentionsByConversation.set(conversation.id, selectedMentions.filter((candidate) => candidate.profileId !== mention.profileId));
            renderConversation();
          });
          chips.appendChild(chip);
        });
        composerMain.appendChild(chips);
      }
      const form = element("form", "ni-composer-form");
      /* 「+」能力清单的入口（A4-13，对照稿 acPlusBtn）：清单里图片/文件停在
         诚实边界、上下文真实闭环——按钮本身解禁，不再是恒禁用的假门。 */
      const attach = button("ni-composer-attach", "+");
      attach.title = "这句话要带上的东西";
      attach.setAttribute("aria-label", "这句话要带上的东西");
      attach.setAttribute("aria-haspopup", "menu");
      attach.setAttribute("aria-expanded", String(plusMenuOpenIn.has(conversation.id)));
      attach.classList.toggle("is-open", plusMenuOpenIn.has(conversation.id));
      attach.dataset.focusId = `plus-toggle:${conversation.id}`;
      attach.addEventListener("click", (event) => {
        event.stopPropagation();
        togglePlusMenu(conversation);
      });
      const input = element("textarea", "ni-composer-input");
      input.rows = 1;
      input.placeholder = `发送消息给 ${conversationTitle(state, conversation)}`;
      input.dataset.conversationId = conversation.id;
      input.setAttribute("aria-label", "消息内容");
      input.value = drafts.get(conversation.id) ?? "";
      /* 打 @ 弹成员选择（A4-14）：@ 的触发就是打字符本身，不再有触发按钮
       * （稿的输入行只有「+」/输入框/麦克风）。 */
      input.addEventListener("input", () => {
        drafts.set(conversation.id, input.value);
        syncMentionTyping(conversation, input);
      });
      input.addEventListener("keydown", (event) => {
        /* 输入法组合中的 Enter/方向键是拼音的确认与翻页：不归 @ 选择器管、
         * 也不该把半截拼音当消息发出去——先整体放行给 IME（Esc 的
         * isComposing 守卫、建群名字框的 Enter 守卫是同一纪律）。 */
        if (event.isComposing) return;
        /* @ 选择器开着时，上下键移候选、Enter 选定（对照稿 atPickMove /
         * atPickChoose——Enter 在这里等于选人，不再把消息发出去）。 */
        if (mentionPickerOpen.has(conversation.id)) {
          if (event.key === "ArrowUp" || event.key === "ArrowDown") {
            event.preventDefault();
            moveMentionPicker(conversation.id, event.key === "ArrowDown" ? 1 : -1);
            return;
          }
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            chooseMention(conversation.id);
            return;
          }
        }
        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          form.requestSubmit();
        }
      });
      /* 输入行麦克风钮（A4-16，对照稿 ac-in-btn.mic：accent 实底、贴输入框
       * 右侧）。链路盘点结论：插件 manifest 没有语音权限（voice.input@1 是
       * 官方 Voice Input 插件的原生能力窄口），Host 侧也没有面向 IM 插件的
       * 听写 API——点了停在诚实边界提示上，不假装在听。 */
      const mic = button("ni-composer-mic", "");
      mic.type = "button";
      mic.title = "语音输入";
      mic.setAttribute("aria-label", "语音输入");
      mic.appendChild(micIcon(14));
      mic.dataset.focusId = `mic:${conversation.id}`;
      mic.addEventListener("click", () => {
        sendError = "语音输入将在插件语音链路接入后开放";
        renderConversation();
      });
      const send = button("ni-composer-send", "发送");
      send.type = "submit";
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const text = input.value.trim();
        if (!text) return;
        send.disabled = true;
        sendError = "";
        /* 附件快照在发送那一刻算（对照稿「今天那部分实时算」的语义）：范围档
           对齐到当时真实历史条数——「最近 20 条」只有 3 条就带 3 条，不虚报。 */
        const historyCount = (coordinator.current.messagesByConversation[conversation.id] ?? []).length;
        const staged = attachmentsByConversation.get(conversation.id) ?? [];
        const attachmentRefs: SentAttachmentRef[] = [
          ...staged
            .filter((attachment): attachment is Extract<ComposerAttachment, { kind: "context" }> => attachment.kind === "context")
            .map((attachment) => ({
              kind: "context" as const,
              scopeLabel: attachment.scopeLabel,
              messageCount: Math.min(CONTEXT_SCOPES[attachment.scope].count, historyCount),
            })),
          /* 跨 App 附件（A3-24）原样快照：label 呈现、text 是引用正文，发送前
             住在条上、发送时随 part 走，不在发送路径上改写内容。 */
          ...staged
            .filter((attachment): attachment is Extract<ComposerAttachment, { kind: "external-context" }> => attachment.kind === "external-context")
            .map((attachment) => ({
              kind: "external-context" as const,
              label: attachment.label,
              text: attachment.text,
            })),
        ];
        try {
          await options.adapter.sendMessage({
            conversationId: conversation.id,
            text,
            replyTo: replyByConversation.get(conversation.id),
            mentions: mentionsByConversation.get(conversation.id),
            attachments: attachmentRefs.length ? attachmentRefs : undefined,
          });
          drafts.set(conversation.id, "");
          replyByConversation.delete(conversation.id);
          mentionsByConversation.delete(conversation.id);
          closeMentionPickerDom();
          /* 消息发出去了：输入语境结束，清单不该还开着 */
          plusMenuOpenIn.delete(conversation.id);
          /* 「正在写的那一条」发出去了：附件随它归零（对照稿 resetDraft 的
             「发完一条后归零」语义）。 */
          attachmentsByConversation.delete(conversation.id);
        } catch (cause) {
          sendError = userFacingError(cause, "消息暂时无法发送，请稍后重试");
        } finally {
          if (!disposed) renderConversation();
        }
      });
      form.append(attach, input, mic, send);
      composerMain.appendChild(form);
      if (mentionPickerOpen.has(conversation.id)) {
        composerMain.appendChild(buildMentionPicker(conversation, input));
      }
      /* 「+」能力清单（A4-13，对照稿 ac-plus：附件与能力同一份清单，向上展开，
         贴输入区顶边）。候选的真实可得性决定行为：图片/文件列出来源逐字对稿、
         选中停在诚实边界；上下文是内存态真实数据，选中进附件条真实闭环。
         会话里一条消息都没有时不列「使用上下文」——没东西可带就不列（对照稿
         ctxSegs 为空不出这行的条件渲染）。 */
      if (plusMenuOpenIn.has(conversation.id)) {
        const plusMenu = element("div", "ni-plus-menu open");
        plusMenu.setAttribute("role", "menu");
        plusMenu.setAttribute("aria-label", "这句话要带上的东西");
        const groupHead = element("div", "ni-plus-group");
        groupHead.textContent = "带上";
        plusMenu.appendChild(groupHead);
        PLUS_FILE_ITEMS.forEach((item) => {
          const row = button("ni-plus-item", "");
          row.dataset.plusItem = item.nm;
          row.setAttribute("role", "menuitem");
          row.dataset.focusId = `plus-pick:${conversation.id}:${item.nm}`;
          row.addEventListener("click", () => {
            plusMenuOpenIn.clear();
            sendError = `${item.nm}将在 Host 文件能力接入后可附带`;
            renderConversation();
          });
          row.append(buildPlusRowCopy(item.ic, item.nm, item.ds));
          plusMenu.appendChild(row);
        });
        const historyCount = (state.messagesByConversation[conversation.id] ?? []).length;
        const currentContext = (attachmentsByConversation.get(conversation.id) ?? [])
          .find((attachment): attachment is Extract<ComposerAttachment, { kind: "context" }> => attachment.kind === "context");
        if (historyCount > 0) {
          const ctxNm = currentContext ? "改上下文范围" : "使用上下文";
          const ctxDs = currentContext
            ? `现在带的是${currentContext.scopeLabel} · 点附件也能换`
            : `让这句话带上本会话最近的来回 · 共 ${historyCount} 条`;
          const ctxRow = button("ni-plus-item", "");
          ctxRow.dataset.plusItem = "context";
          ctxRow.setAttribute("role", "menuitem");
          ctxRow.dataset.focusId = `plus-pick:${conversation.id}:context`;
          ctxRow.addEventListener("click", () => {
            cycleContextScope(conversation.id);
          });
          ctxRow.append(buildPlusRowCopy("〰", ctxNm, ctxDs));
          plusMenu.appendChild(ctxRow);
        }
        const plusFoot = element("div", "ni-plus-foot");
        plusFoot.textContent = "点选带上 · Esc 收起";
        plusMenu.appendChild(plusFoot);
        composerMain.appendChild(plusMenu);
      }
      composerArea.appendChild(composerMain);
    }
    if (sendError) {
      const error = element("p", "ni-client-note");
      error.textContent = sendError;
      composerArea.appendChild(error);
    }
    conversationPane.append(header, mockNotice, messageList, composerArea, memberCard);
    if (previousConversationId === conversation.id && !wasAtBottom) {
      messageList.scrollTop = previousScrollTop;
    } else {
      messageList.scrollTop = messageList.scrollHeight;
    }
    /* 成员卡的收起路径（对照稿 acStream）：点流内非 @ 处、滚动即收。
       scroll 监听挂在程序化 scrollTop 之后——那一跳不是「人往上翻」，别把刚
       弹出的卡收掉。「回到最新」的显隐与待确认坞的收缩在同一个 scroll 里算
       （对照稿 acStream 的 scroll 监听同时喂 syncJump 与 syncAskMini）。 */
    messageList.addEventListener("click", (event) => {
      if (event.target instanceof HTMLElement && event.target.closest(".ni-mention.is-resolved")) return;
      hideMemberCard();
    });
    messageList.addEventListener("scroll", () => {
      hideMemberCard();
      syncJump(messageList);
      syncAskDock(messageList);
    });
    syncJump(messageList);
    syncAskDock(messageList);
    syncMemberCard();
    /* 抽屉开着时随全量重绘刷新内容（presence / 成员变化走事件回声进来）；
     * 换会话路径已先 closeDrawer，这里只会是当前会话的档。 */
    if (drawerMode) renderDrawer();
    queueMicrotask(() => restoreFocus(focus));
  }

  function renderAll(): void {
    if (disposed) return;
    renderList();
    renderConversation();
    if (overlay === "new-group") renderNewGroupList();
    else if (overlay === "scan-local" && !scanning) renderScanList();
    else if (overlay === "invite") renderInviteList();
  }

  /* ===== 「+」菜单与三个新建落点 ===== */
  let addMenuOpen = false;
  let overlay: "" | "new-group" | "scan-local" | "invite" = "";
  let newGroupPicked: string[] = [];
  let scanning = false;
  let scanTimer: ReturnType<typeof setTimeout> | undefined;

  /* ===== 会话头「更多」菜单（A4-8）与 @ 成员卡（A4-9）=====
     两个轻浮层都不带蒙版，关闭路径三件套：Esc（document 级）、点外、换会话。 */
  let moreMenuOpenIn = ""; // 记的是「哪个会话」开着菜单——换会话自然失效
  let memberCardProfileId = ""; // 成员卡当前展示的人；空串 = 收起
  let inviteConversationId = ""; // 「拉 agent 进群」针对哪个群开的

  /* ===== 右侧推挤式抽屉（A4-15，对照稿 ac-drawer：任务锚点 / 群成员两档）=====
     推挤式辅助面板「可以一直开着」（稿 doEsc 注释），所以它不参与点外收，
     收它的路径只有三条：✕、Esc（在会话内层级链里位于成员卡之后、退出对话
     之前——对照稿 doEsc 的 if(drawerMode){closeDrawer();return}）、换会话/
     退出会话（对照稿 openAgent / closeAgent 都调 closeDrawer）。 */
  let drawerMode: "" | "anchor" | "mem" = ""; // 空串 = 收起

  function setOverlayNote(note: HTMLParagraphElement, text: string): void {
    note.textContent = text;
    note.hidden = !text;
  }

  function setAddMenu(open: boolean): void {
    addMenuOpen = open;
    addMenu.classList.toggle("open", open);
    addContact.setAttribute("aria-expanded", String(open));
  }

  /* 两个浮层互斥：后开的把先开的关掉（包括清掉扫描定时器），
     打开浮层时菜单必然收起。 */
  function openOverlay(kind: "new-group" | "scan-local" | "invite"): void {
    setAddMenu(false);
    setMoreMenu("");
    if (overlay === "scan-local" && kind !== "scan-local") {
      clearTimeout(scanTimer);
      scanTimer = undefined;
      scanning = false;
    }
    overlay = kind;
    newGroupOverlay.hidden = kind !== "new-group";
    scanOverlay.hidden = kind !== "scan-local";
    inviteOverlay.hidden = kind !== "invite";
  }

  function closeOverlay(): void {
    if (overlay === "scan-local") {
      clearTimeout(scanTimer);
      scanTimer = undefined;
      scanning = false;
    }
    overlay = "";
    newGroupOverlay.hidden = true;
    scanOverlay.hidden = true;
    inviteOverlay.hidden = true;
  }

  /* add 落点：转交给置顶的外脑会话，预填一句开场——
     「把话问清楚」由一个能对话的对象来做，这里不发独立表单。 */
  function handOffToAddAgent(): void {
    const pinned = coordinator.current.conversations.find((candidate) => candidate.pinned && candidate.type !== "system");
    if (!pinned) {
      sendError = "还没有可以转交的置顶会话，先把外脑会话置顶再从这里转交";
      renderConversation();
      return;
    }
    selectedConversationId = pinned.id;
    sendError = "";
    drafts.set(pinned.id, ADD_HANDOFF_DRAFT);
    renderList();
    renderConversation();
    queueMicrotask(() => conversationPane.querySelector<HTMLTextAreaElement>(".ni-composer-input")?.focus());
  }

  function pickableAgentProfiles(): Profile[] {
    return Object.values(coordinator.current.profiles).filter((profile) => profile.type === "agent");
  }

  function renderNewGroupList(restoreProfileId?: string): void {
    const previousFocus = restoreProfileId
      ?? (document.activeElement instanceof HTMLElement ? document.activeElement.dataset.pickProfileId : undefined);
    newGroupList.replaceChildren();
    const candidates = pickableAgentProfiles();
    if (!candidates.length) {
      const empty = element("p", "ni-overlay-empty");
      empty.textContent = "还没有可拉进群聊的 Agent";
      newGroupList.appendChild(empty);
    }
    candidates.forEach((profile) => {
      const picked = newGroupPicked.includes(profile.id);
      const item = button(`ni-pick-item${picked ? " is-on" : ""}`, "");
      item.dataset.pickProfileId = profile.id;
      item.setAttribute("aria-pressed", String(picked));
      const avatarCell = element("span", "ni-pick-avatar");
      avatarCell.textContent = profile.avatarText;
      const copy = element("span", "ni-pick-copy");
      const title = element("span", "ni-pick-title");
      title.textContent = profile.displayName;
      const sub = element("span", "ni-pick-sub");
      sub.textContent = `@${profile.username}`;
      copy.append(title, sub);
      const check = element("span", "ni-pick-check");
      check.textContent = "✓";
      item.append(avatarCell, copy, check);
      item.addEventListener("click", () => {
        newGroupPicked = picked
          ? newGroupPicked.filter((id) => id !== profile.id)
          : [...newGroupPicked, profile.id];
        renderNewGroupList(profile.id);
      });
      newGroupList.appendChild(item);
    });
    newGroupGo.textContent = newGroupPicked.length ? `建群 · 已选 ${newGroupPicked.length} 人` : "建群";
    if (previousFocus) {
      queueMicrotask(() => newGroupList.querySelector<HTMLButtonElement>(`[data-pick-profile-id="${previousFocus}"]`)?.focus());
    }
  }

  /* 建群提交：名字和成员都不给兜底（对照稿）。表单与校验完整落地；
     adapter 没有「创建会话」的协议能力，校验通过后停在诚实的协议边界提示上。 */
  function submitNewGroup(): void {
    const name = newGroupNameInput.value.trim();
    if (!name) {
      newGroupNameInput.placeholder = GROUP_NAME_REQUIRED_PLACEHOLDER;
      newGroupNameInput.classList.add("shake");
      setTimeout(() => newGroupNameInput.classList.remove("shake"), 400);
      newGroupNameInput.focus();
      return;
    }
    if (!newGroupPicked.length) {
      newGroupNameInput.placeholder = GROUP_MEMBER_REQUIRED_PLACEHOLDER;
      // 问题出在成员侧：焦点引到第一个候选行，而不是留在已经填好的名字框（对照稿 7209-7213）
      newGroupList.querySelector<HTMLButtonElement>(".ni-pick-item")?.focus();
      return;
    }
    setOverlayNote(newGroupNote, "群聊创建将在 ni-chat 协议接入后开放");
  }

  function openNewGroup(): void {
    newGroupPicked = [];
    newGroupNameInput.value = "";
    newGroupNameInput.placeholder = GROUP_NAME_PLACEHOLDER;
    setOverlayNote(newGroupNote, "");
    renderNewGroupList();
    openOverlay("new-group");
    newGroupNameInput.focus();
  }

  function renderScanList(restoreScanId?: string): void {
    const previousFocus = restoreScanId
      ?? (document.activeElement instanceof HTMLElement ? document.activeElement.dataset.scanId : undefined);
    scanList.replaceChildren();
    const knownNames = new Set(pickableAgentProfiles().map((profile) => profile.displayName));
    const addable = SCAN_FOUND.filter((found) => !knownNames.has(found.displayName));
    SCAN_FOUND.forEach((found) => {
      const known = knownNames.has(found.displayName);
      const row = known ? element("div", "ni-pick-item is-off") : button("ni-pick-item", "");
      if (!known) {
        row.dataset.scanId = found.id;
        row.addEventListener("click", () => {
          setOverlayNote(scanNote, "添加本机 Agent 将在 ni-chat 协议接入后开放");
          queueMicrotask(() => scanList.querySelector<HTMLButtonElement>(`[data-scan-id="${found.id}"]`)?.focus());
        });
      }
      const avatarCell = element("span", "ni-pick-avatar");
      avatarCell.textContent = found.avatarText;
      const copy = element("span", "ni-pick-copy");
      const title = element("span", "ni-pick-title");
      title.textContent = found.displayName;
      const sub = element("span", "ni-pick-sub");
      sub.textContent = found.detail;
      copy.append(title, sub);
      const tag = element("span", "ni-pick-tag");
      tag.textContent = known ? "已在列表" : "添加";
      row.append(avatarCell, copy, tag);
      scanList.appendChild(row);
    });
    scanFoot.textContent = addable.length ? "点按添加 · Esc 关闭" : "这台机器上能找到的都已经在列表里了 · Esc 关闭";
    if (previousFocus) {
      queueMicrotask(() => scanList.querySelector<HTMLButtonElement>(`[data-scan-id="${previousFocus}"]`)?.focus());
    }
  }

  /* 不确定态跑 1.5 秒再出结果；期间不给任何数字——人已经关掉时不再往
     看不见的界面里写状态。 */
  function openScanLocal(): void {
    scanning = true;
    setOverlayNote(scanNote, "");
    scanBar.classList.remove("done");
    scanFoot.textContent = "正在找这台机器上装了什么…";
    scanList.replaceChildren();
    openOverlay("scan-local");
    scanCard.focus();
    clearTimeout(scanTimer);
    scanTimer = setTimeout(() => {
      scanTimer = undefined;
      if (overlay !== "scan-local") return;
      scanning = false;
      scanBar.classList.add("done");
      renderScanList();
    }, 1500);
  }

  /* ===== 输入区「+」清单与附件条（A4-12/A4-13）与「回到最新」（A4-10）===== */

  /* 「+」清单的行内容（对照稿 .ac-plus-i 的 ic/nm/ds 三段结构）。 */
  function buildPlusRowCopy(icon: string, name: string, detail: string): DocumentFragment {
    const copy = document.createDocumentFragment();
    const iconCell = element("span", "ni-plus-item-ic");
    iconCell.textContent = icon;
    const textCell = element("span", "ni-plus-item-tx");
    const nameNode = element("span", "ni-plus-item-nm");
    nameNode.textContent = name;
    const detailNode = element("span", "ni-plus-item-ds");
    detailNode.textContent = detail;
    textCell.append(nameNode, detailNode);
    copy.append(iconCell, textCell);
    return copy;
  }

  /* 上下文附件的「开一道口子 / 换范围」（对照稿 plusPick 的 ctx 分支）：
     一条消息只开一道——已带过就是换档（往后转一档），不是再叠一枚；
     没带过就从第一档开。选完清单收起（稿：选完一律收起）。 */
  function cycleContextScope(conversationId: string): void {
    const list = attachmentsByConversation.get(conversationId) ?? [];
    const current = list.find((attachment): attachment is Extract<ComposerAttachment, { kind: "context" }> => attachment.kind === "context");
    if (current) {
      current.scope = (current.scope + 1) % CONTEXT_SCOPES.length;
      current.scopeLabel = CONTEXT_SCOPES[current.scope].label;
    } else {
      attachmentsByConversation.set(conversationId, [
        ...list,
        { kind: "context", scope: 0, scopeLabel: CONTEXT_SCOPES[0].label },
      ]);
    }
    plusMenuOpenIn.clear();
    sendError = "";
    renderConversation();
  }

  /* 只摘「+」清单的可见部分并同步钮态，不整屏重绘（#339 手法：重绘会把
     刚点住的按钮换掉，焦点和 aria 状态全丢）。 */
  function closePlusMenuDom(): void {
    plusMenuOpenIn.clear();
    conversationPane.querySelector(".ni-plus-menu")?.remove();
    syncPlusToggle();
  }

  function syncPlusToggle(): void {
    const toggle = conversationPane.querySelector<HTMLButtonElement>(".ni-composer-attach");
    if (!toggle) return;
    const open = plusMenuOpenIn.size > 0;
    toggle.setAttribute("aria-expanded", String(open));
    toggle.classList.toggle("is-open", open);
  }

  function togglePlusMenu(conversation: ConversationSummary): void {
    if (plusMenuOpenIn.has(conversation.id)) {
      closePlusMenuDom();
      return;
    }
    /* 同级轻浮层互斥（对照稿 12.2a，#339 同款纪律）：@ 选择器、「更多」菜单、
       成员卡先收——两层同场时确认键会分给分支顺序靠前的那层。 */
    closeMentionPickerDom();
    setMoreMenu("");
    hideMemberCard();
    plusMenuOpenIn.clear();
    plusMenuOpenIn.add(conversation.id);
    syncPlusToggle();
    renderConversation();
  }

  /* 「回到最新」显隐（A4-10，对照稿 syncJump）：距底 gap 走 60/140 滞回——
     已显示时 >60 维持、未显示时要越过 140 才出现，边界处的来回微调不闪。
     jumpVisible 是跨重绘的单侧记忆：重渲染从 scroll 恢复值重算，稳定区不翻转。
     布局未就绪（尺寸为 0，比如刚重建还没排版）时不判定——拿 0 当 gap 会把
     记忆清掉，下一帧又要重新越过 140 才出现。 */
  function syncJump(list: HTMLElement): void {
    if (!list.scrollHeight && !list.clientHeight) return;
    const gap = list.scrollHeight - list.clientHeight - list.scrollTop;
    const next = jumpVisible ? gap > JUMP_HYST_LO : gap > JUMP_HYST_HI;
    if (next === jumpVisible) return;
    jumpVisible = next;
    conversationPane.querySelector<HTMLElement>(".ni-jump")?.classList.toggle("show", next);
  }

  /* ===== 待确认坞的收缩/展开（A4-11，对照稿 syncAskMini / expandAsk）===== */

  /* 滚动驱动的收缩滞回：已收缩时 gap>80 维持、未收缩时要越过 220 才收缩。
     用户 Esc 明确收起过的那条要让位（对照稿 askPinned）：自动展开逻辑不跑，
     直到点收缩条主动展开、或换了一条待确认/换会话才解除。 */
  function syncAskDock(list: HTMLElement): void {
    const dock = conversationPane.querySelector<HTMLElement>(".ni-ask-dock");
    if (!dock) return;
    if (askDockPinnedId && askDockPinnedId === dock.dataset.interactionId) return;
    if (!list.scrollHeight && !list.clientHeight) return;
    const gap = list.scrollHeight - list.clientHeight - list.scrollTop;
    const next = askDockMini ? gap > ASK_HYST_LO : gap > ASK_HYST_HI;
    if (next === askDockMini) return;
    askDockMini = next;
    conversationPane.querySelector<HTMLElement>(".ni-ask-dock")?.classList.toggle("is-mini", next);
  }

  /* 主动展开：解除「用户明确收起过」，展开并回到最新。展开会挤压消息流、
     改变可滚动尺寸，等过渡结束再滚，否则滚动目标算的是旧值（对照稿
     expandAsk + backToLatest 的 setTimeout(250)）。 */
  function expandAskDock(list: HTMLElement): void {
    askDockMini = false;
    askDockPinnedId = "";
    conversationPane.querySelector<HTMLElement>(".ni-ask-dock")?.classList.remove("is-mini");
    setTimeout(() => {
      if (!disposed) list.scrollTo({ top: list.scrollHeight, behavior: "smooth" });
    }, 250);
  }

  /* ===== 打 @ 弹的成员选择（A4-14，对照稿 atCands / renderAtPick / atPickChoose）===== */

  /* 候选：群成员排除自己（协议 Profile 都有稳定 id，稿里「排除没有稳定
     id 的成员」在这里不适用）；查询词是 @ 之后到光标的那段。前缀命中排在
     包含命中前面（对照稿：打 cod 时 Codex 该排在「Claude Code」前面——
     第一顺位选错人比多一条候选糟得多）。 */
  function mentionCandidates(conversation: ConversationSummary, inputRef?: HTMLTextAreaElement): Profile[] {
    if (conversation.type !== "group" || mentionQueryStart < 0) return [];
    const state = coordinator.current;
    /* inputRef 由渲染路径显式传入：全量重绘时 composerMain 还没挂回
       conversationPane，从 conversationPane 查会落空（查到空 input 会把
       候选算成空、picker 误显「没有匹配的成员」）。 */
    const input = inputRef ?? conversationPane.querySelector<HTMLTextAreaElement>(".ni-composer-input");
    if (!input) return [];
    const caret = input.selectionStart ?? input.value.length;
    const query = input.value.slice(mentionQueryStart + 1, caret).toLowerCase();
    const members = conversationProfiles(state, conversation)
      .filter((profile) => profile.id !== state.selfProfileId)
      .filter((profile) => profile.displayName.toLowerCase().includes(query));
    return members.filter((profile) => profile.displayName.toLowerCase().startsWith(query))
      .concat(members.filter((profile) => !profile.displayName.toLowerCase().startsWith(query)));
  }

  function buildMentionPicker(conversation: ConversationSummary, inputRef?: HTMLTextAreaElement): HTMLElement {
    const picker = element("div", "ni-mention-picker");
    picker.setAttribute("role", "listbox");
    picker.setAttribute("aria-label", "选择要提及的成员");
    const candidates = mentionCandidates(conversation, inputRef);
    if (!candidates.length) {
      const empty = element("span", "ni-mention-picker-empty");
      empty.textContent = "没有匹配的成员";
      picker.appendChild(empty);
      return picker;
    }
    candidates.forEach((profile, index) => {
      const item = button(`ni-mention-picker-item${index === mentionPickerIndex ? " is-sel" : ""}`, "");
      item.dataset.mentionProfileId = profile.id;
      item.dataset.focusId = `mention-pick:${profile.id}`;
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", String(index === mentionPickerIndex));
      /* 行结构对照稿 .at-it：头像 / 名字 / 右侧的稳定标识。稿的 at-rl 是
         角色描述，协议没有角色字段——username 是成员的稳定标识，用它。 */
      const avatarCell = element("span", "ni-at-av");
      avatarCell.textContent = profile.avatarText;
      const nameCell = element("span", "ni-at-nm");
      nameCell.textContent = profile.displayName;
      const idCell = element("span", "ni-at-rl");
      idCell.textContent = `@${profile.username}`;
      item.append(avatarCell, nameCell, idCell);
      item.addEventListener("click", () => {
        mentionPickerIndex = index;
        chooseMention(conversation.id);
      });
      picker.appendChild(item);
    });
    return picker;
  }

  /* 只换候选列表不整屏重绘：继续输入时输入框不能被重建（会打断连续输入、
     丢光标），picker 内容单独替换（对照稿已开浮层时只 renderAtPick）。 */
  function refreshMentionPickerDom(conversationId: string): void {
    const conversation = coordinator.current.conversations.find((candidate) => candidate.id === conversationId);
    if (!conversation) return;
    conversationPane.querySelector(".ni-mention-picker")?.replaceWith(buildMentionPicker(conversation));
  }

  function closeMentionPickerDom(): void {
    mentionPickerOpen.clear();
    mentionQueryStart = -1;
    conversationPane.querySelector(".ni-mention-picker")?.remove();
  }

  /* 打字时判断「光标此刻是不是正落在一个刚起头的 @ 里」（对照稿 acInput 的
     input 监听）：仅群聊——单聊只有两个人，@ 没有意义；@ 之后到光标之间
     一旦出现空白，这次 @ 就当写完了，浮层收起——否则人写完一句话，浮层
     还赖在屏幕上。 */
  function syncMentionTyping(conversation: ConversationSummary, input: HTMLTextAreaElement): void {
    if (conversation.type !== "group") {
      if (mentionPickerOpen.size) closeMentionPickerDom();
      return;
    }
    const caret = input.selectionStart ?? input.value.length;
    const head = input.value.slice(0, caret);
    const at = head.lastIndexOf("@");
    if (at < 0 || /\s/.test(head.slice(at + 1))) {
      if (mentionPickerOpen.size) closeMentionPickerDom();
      return;
    }
    mentionQueryStart = at;
    if (!mentionPickerOpen.has(conversation.id)) {
      /* 同级轻浮层互斥（对照稿 12.2a，与「+」清单同一纪律）：@ 选择器开，
         「+」清单、「更多」菜单、成员卡先收——两层同场时确认键会分给
         分支顺序靠前的那层。 */
      if (plusMenuOpenIn.size) closePlusMenuDom();
      setMoreMenu("");
      hideMemberCard();
      mentionPickerOpen.clear();
      mentionPickerOpen.add(conversation.id);
      mentionPickerIndex = 0;
      renderConversation();
    } else {
      mentionPickerIndex = 0;
      refreshMentionPickerDom(conversation.id);
    }
  }

  function moveMentionPicker(conversationId: string, delta: number): void {
    const conversation = coordinator.current.conversations.find((candidate) => candidate.id === conversationId);
    if (!conversation) return;
    const count = mentionCandidates(conversation).length;
    if (!count) return;
    mentionPickerIndex = (mentionPickerIndex + delta + count) % count;
    refreshMentionPickerDom(conversationId);
  }

  /* 选中回填（对照稿 atPickChoose）：把「@查询词」整段换成「@名字␣」，光标
     落在名字后；台账走协议的结构化 MentionRef（mentions 随消息独立发送，
     不是稿的文本区间归一化），chips 呈现，已有的不重复加。 */
  function chooseMention(conversationId: string): void {
    const conversation = coordinator.current.conversations.find((candidate) => candidate.id === conversationId);
    if (!conversation) return;
    const input = conversationPane.querySelector<HTMLTextAreaElement>(".ni-composer-input");
    if (!input) return;
    const profile = mentionCandidates(conversation)[mentionPickerIndex];
    if (!profile) return;
    const caret = input.selectionStart ?? input.value.length;
    const start = mentionQueryStart >= 0 ? mentionQueryStart : caret;
    const tag = `@${profile.displayName} `;
    input.value = input.value.slice(0, start) + tag + input.value.slice(caret);
    drafts.set(conversationId, input.value);
    const caretAfter = start + tag.length;
    const current = mentionsByConversation.get(conversationId) ?? [];
    if (!current.some((candidate) => candidate.profileId === profile.id)) {
      mentionsByConversation.set(conversationId, [...current, { profileId: profile.id, label: profile.displayName }]);
    }
    closeMentionPickerDom();
    renderConversation();
    queueMicrotask(() => {
      const next = conversationPane.querySelector<HTMLTextAreaElement>(".ni-composer-input");
      if (!next) return;
      next.focus();
      next.setSelectionRange(caretAfter, caretAfter);
    });
  }

  /* ===== 右侧推挤式抽屉（A4-15）开合与两档渲染 ===== */

  function closeDrawer(): void {
    const closingMode = drawerMode;
    drawerMode = "";
    drawer.classList.remove("open");
    drawer.inert = true;
    drawer.setAttribute("aria-hidden", "true");
    /* 焦点正落在抽屉里（键盘从 ✕ 或抽屉内 Esc 关掉）时还给对应入口钮——
       其余 Esc 分支都还焦，这里对齐；不还的话焦点停在看不见的控件上。 */
    if (closingMode && document.activeElement instanceof HTMLElement && drawer.contains(document.activeElement)) {
      conversationPane.querySelector<HTMLButtonElement>(`.ni-header-action[data-drawer-mode="${closingMode}"]`)?.focus();
    }
    syncDrawerToggles();
  }

  /* toggle 只给顶栏按钮用（对照稿 openDrawer 的 toggle 参数：同档再点收起）；
     程序化打开（未来从消息流点锚点卡）不该把已开的抽屉收回去。 */
  function toggleDrawer(mode: "anchor" | "mem"): void {
    if (drawerMode === mode) {
      closeDrawer();
      return;
    }
    openDrawer(mode);
  }

  function openDrawer(mode: "anchor" | "mem"): void {
    drawerMode = mode;
    renderDrawer();
  }

  /* 入口钮的开态同步（对照稿 acMemBtn/acAnchorBtn 的 .on）：renderConversation
     重建会话头时按钮已按 drawerMode 初始化，这里是开合后不重绘整屏的那条路。 */
  function syncDrawerToggles(): void {
    conversationPane.querySelectorAll<HTMLButtonElement>(".ni-header-action[data-drawer-mode]").forEach((node) => {
      const open = node.dataset.drawerMode === drawerMode;
      node.classList.toggle("is-open", open);
      node.setAttribute("aria-expanded", String(open));
    });
  }

  /* 成员档副行（对照稿 m.role）：participants 记录里查这个人的真实 role，
     查不到退 @username——不编稿上的「总指挥 · 计划入口」那类演示文案。 */
  function participantRoleLabel(conversationId: string, profileId: string): string | undefined {
    const participant = coordinator.current.participants.find(
      (candidate) => candidate.conversationId === conversationId && candidate.profileId === profileId,
    );
    return participant ? PARTICIPANT_ROLE_LABEL[participant.role] : undefined;
  }

  function renderDrawer(): void {
    const state = coordinator.current;
    const conversation = state.conversations.find((candidate) => candidate.id === selectedConversationId);
    if (!drawerMode || !conversation) {
      closeDrawer();
      return;
    }
    drawerBody.replaceChildren();
    if (drawerMode === "anchor") {
      /* 锚点档：稿的数据源是会话 stream 里的 anchor 条目，ni.chat 协议的
       * MessagePart 联合里没有锚点/任务关联类型——按诚实空态呈现（#348
       * 麦克风边界同口径），不编锚点条目、不画搜索框（稿：空列表不出搜索框）。 */
      drawerTitle.textContent = "任务锚点 · 0";
      const empty = element("p", "ni-drawer-empty");
      empty.textContent = "会话关联的任务锚点将在 ni-chat 协议接入后出现";
      drawerBody.appendChild(empty);
    } else {
      /* 成员档：participantIds → profiles 的真实数据（与 #339 成员卡同源），
       * 头像 / 昵称 / participants role / presence 状态点全是协议字段。 */
      const profiles = conversationProfiles(state, conversation);
      drawerTitle.textContent = `群成员 · ${profiles.length}`;
      profiles.forEach((profile) => {
        const row = element("div", "ni-drawer-mem");
        row.dataset.profileId = profile.id;
        const avatarCell = element("span", "ni-drawer-mem-av");
        avatarCell.textContent = profile.avatarText;
        /* presence 状态点（对照稿 .al-st 的位置规格；配色按真实 presence
         * 语义：online 绿 / offline 灰，capability 与 TTL 交给 visiblePresence，
         * 没有就不画，不编状态）。 */
        const presence = coordinator.visiblePresence(profile.id);
        if (presence) {
          const dot = element("i", `ni-drawer-st is-${presence.state}`);
          avatarCell.appendChild(dot);
        }
        const copy = element("div", "ni-drawer-mem-i");
        const name = element("div", "ni-drawer-mem-n");
        name.textContent = profile.displayName;
        const sub = element("div", "ni-drawer-mem-r");
        sub.textContent = participantRoleLabel(conversation.id, profile.id) ?? `@${profile.username}`;
        copy.append(name, sub);
        row.append(avatarCell, copy);
        drawerBody.appendChild(row);
      });
      /* 「拉 agent 进群」（对照稿 .ac-dr-add）：两个入口共用 invite 浮层——
       * 另一处在会话头「更多」菜单（稿 4288 注释）。抽屉不收——覆盖浮层
       * 盖上来，Esc 先关浮层，抽屉还在原处（稿同款层级）。 */
      const add = button("ni-drawer-add", "拉 agent 进群");
      add.type = "button";
      add.addEventListener("click", () => openInvite(conversation));
      drawerBody.appendChild(add);
    }
    drawer.classList.add("open");
    drawer.inert = false;
    drawer.setAttribute("aria-hidden", "false");
    syncDrawerToggles();
  }

  drawerClose.addEventListener("click", () => closeDrawer());

  /* ===== 中栏拖宽手柄（A4-5，对照稿 makeResizer + Host layout.ts 的纪律）=====
     事件模型逐字对稿：pointerdown → setPointerCapture（try/catch 兜 WebView 拒绝）
     → move/up 挂 document（捕获失败也收得到）→ 松手才落盘；lostpointercapture
     兜底复位；双击回默认宽。宽度纪律照搬 Host layout.ts：用户意愿（intentW）与
     显示宽度分离——窗口被拉窄只影响显示值，一个字节都不落盘，拉回去时宽度
     要跟着回来；只有用户动作（拖、双击）才写 localStorage。 */
  let sidebarIntentW = readSidebarW();
  let sidebarPid: number | null = null;
  let sidebarStartX = 0;
  let sidebarStartW = 0;
  let sidebarReflowRaf = 0;

  /* 窄档判断走媒体查询口径（含滚动条的视口宽）——与 CSS 断点同一把尺子；
     innerWidth 不含滚动条，Windows 经典滚动条下两者差十几像素，那区间会出现
     「手柄可见却拖不动」的死区。matchMedia 不可用的极老 WebView 退回 innerWidth。 */
  const sidebarNarrowQuery = typeof window.matchMedia === "function"
    ? window.matchMedia(`(max-width: ${SIDEBAR_NARROW}px)`)
    : null;
  function isSidebarNarrow(): boolean {
    return sidebarNarrowQuery ? sidebarNarrowQuery.matches : window.innerWidth <= SIDEBAR_NARROW;
  }

  function readSidebarW(): number {
    try {
      const value = Number.parseFloat(localStorage.getItem(SIDEBAR_W_KEY) ?? "");
      return Number.isFinite(value) ? value : SIDEBAR_DEF;
    } catch {
      return SIDEBAR_DEF; // localStorage 不可用时只保留内存态（稿 safeNum 同款容错）
    }
  }

  function writeSidebarW(): void {
    try {
      localStorage.setItem(SIDEBAR_W_KEY, String(Math.round(sidebarIntentW)));
    } catch {
      // 存不了就算了，本次运行仍生效
    }
  }

  /* 测试环境量不出布局（clientWidth=0）时按稿的基准窗口 1080 兜底（winW 同款） */
  function appWidth(): number {
    return app.clientWidth || 1080;
  }

  function sidebarMaxWidth(): number {
    return Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_PANE_MAX, appWidth() - (drawerMode ? SIDEBAR_DRAWER_COST : 0) - SIDEBAR_CENTER_MIN));
  }

  /* 唯一写出口（对稿 applyUI）：把意愿夹进「当前容器放得下」的区间画出去。
     persist=false 用于拖拽途中——每帧写 localStorage 就是每秒两百多次同步 I/O。
     窄档下移除变量：宽度交还样式表窄档（238/92px），记忆值只在宽度概念成立
     的区间生效。 */
  function applySidebarW(persist: boolean): void {
    const display = Math.min(Math.max(sidebarIntentW, SIDEBAR_MIN), sidebarMaxWidth());
    if (isSidebarNarrow()) sidebar.style.removeProperty("--ni-sidebar-w");
    else sidebar.style.setProperty("--ni-sidebar-w", `${Math.round(display)}px`);
    sidebarHandle.setAttribute("aria-valuenow", String(Math.round(display)));
    if (persist) writeSidebarW();
  }

  const onSidebarMove = (event: PointerEvent): void => {
    if (sidebarPid === null || event.pointerId !== sidebarPid) return;
    /* 拖拽是用户意愿：夹一次再记，夹的是他拖到的位置。只夹不记的话，从默认宽
       一把拖过头会把越界值当意愿存下来，窗口一变大又「弹」出来。 */
    sidebarIntentW = Math.min(Math.max(sidebarStartW + (event.clientX - sidebarStartX), SIDEBAR_MIN), sidebarMaxWidth());
    applySidebarW(false);
  };

  /* settle=true：松手（用户动作的终点），落一次盘；dispose 复用复位逻辑时
     传 false——视图卸载不是用户意图，不该把拖到一半的值永久写进本地。 */
  const stopSidebarDrag = (event?: PointerEvent, settle = true): void => {
    if (sidebarPid === null || (event && event.pointerId !== sidebarPid)) return;
    /* 先复位 pid / 摘监听 / 摘类，再 release：lostpointercapture 的处理器就是
       stopSidebarDrag 本体，个别 WebView 会同步派发它——门口先短路，重入进来
       是 no-op，不会带着 settle 语义再落一次盘。 */
    const captured = sidebarPid;
    sidebarPid = null;
    document.removeEventListener("pointermove", onSidebarMove);
    document.removeEventListener("pointerup", stopSidebarDrag);
    document.removeEventListener("pointercancel", stopSidebarDrag);
    sidebarHandle.classList.remove("dragging");
    document.body.classList.remove("rs-dragging");
    try {
      sidebarHandle.releasePointerCapture(captured);
    } catch {
      // 捕获早就被系统收走了，这里只是复位，收不回来无所谓
    }
    applySidebarW(settle);
  };

  sidebarHandle.addEventListener("pointerdown", (event) => {
    /* 窄档下宽度由媒体查询钉死，「拖着改宽度」不成立（稿小屏短路同一条判断） */
    if (isSidebarNarrow()) return;
    event.preventDefault(); // 连同 CSS 的 touch-action:none 一起挡掉触控板滚动/选中抖动
    sidebarPid = event.pointerId;
    try {
      sidebarHandle.setPointerCapture(sidebarPid);
    } catch {
      // 部分 WebView 会拒绝捕获；move/up 挂 document，照样收得到
    }
    sidebarStartX = event.clientX;
    sidebarStartW = Math.min(Math.max(sidebarIntentW, SIDEBAR_MIN), sidebarMaxWidth()); // 从屏幕上看到的宽度起拖，第一帧不跳
    document.addEventListener("pointermove", onSidebarMove);
    document.addEventListener("pointerup", stopSidebarDrag);
    document.addEventListener("pointercancel", stopSidebarDrag);
    sidebarHandle.classList.add("dragging");
    document.body.classList.add("rs-dragging"); // 锁死整页光标与选区
  });
  sidebarHandle.addEventListener("lostpointercapture", stopSidebarDrag as EventListener);
  sidebarHandle.addEventListener("dblclick", (event) => {
    if (isSidebarNarrow()) return;
    event.preventDefault();
    sidebarIntentW = SIDEBAR_DEF;
    applySidebarW(true);
  });

  /* 窗口尺寸变了：只重算显示宽度，不落盘——窗口被拉窄不等于用户想要更窄的栏
     （Host layout.ts 踩过的坑；稿 rsRaf 同款 rAF 节流）。抽屉开合同理：它改变
     的是「放得下多少」，不是用户意愿。 */
  const onSidebarReflow = (): void => {
    if (sidebarReflowRaf) return;
    sidebarReflowRaf = requestAnimationFrame(() => {
      sidebarReflowRaf = 0;
      if (!disposed) applySidebarW(false);
    });
  };
  window.addEventListener("resize", onSidebarReflow);
  /* 抽屉开合走同一条 reflow：开抽屉时上限变小，超出的显示宽当场收紧（不落盘） */
  const reflowSidebarOnDrawer = (): void => onSidebarReflow();
  const drawerObserver = new MutationObserver(reflowSidebarOnDrawer);
  drawerObserver.observe(drawer, { attributes: true, attributeFilter: ["class"] });
  applySidebarW(false); // 启动只画不写盘：窗口可能还没定型，量出来的值不该变成永久设置

  /* ===== 会话头「更多」菜单（A4-8，对照稿 acMore）===== */

  function moreMenuItems(conversation: ConversationSummary): Array<{ key: string; label: string }> {
    const items = [
      { key: "mute", label: conversation.muted ? "取消静音" : "静音通知" },
      { key: "unread", label: "标为未读" },
    ];
    if (conversation.type === "group") items.push({ key: "invite", label: "拉 agent 进群" });
    items.push({ key: "close", label: "关闭对话" });
    return items;
  }

  function setMoreMenu(conversationId: string): void {
    moreMenuOpenIn = conversationId;
    const menu = conversationPane.querySelector<HTMLElement>(".ni-more-menu");
    menu?.classList.toggle("open", Boolean(conversationId));
    const toggle = conversationPane.querySelector<HTMLButtonElement>('.ni-header-action[aria-haspopup="menu"]');
    if (toggle) toggle.setAttribute("aria-expanded", String(Boolean(conversationId)));
  }

  function toggleMoreMenu(conversation: ConversationSummary): void {
    if (moreMenuOpenIn === conversation.id) {
      setMoreMenu("");
    } else {
      /* 同级轻浮层互斥（对照稿 12.2a）：@ 选择器与「+」清单先收，两层同场时
       确认键会分给分支顺序靠前的那层。直接摘 picker 的 DOM，不整屏重绘——
       重绘会把刚点住的按钮换掉，焦点和 aria 状态全丢。 */
      closeMentionPickerDom();
      if (plusMenuOpenIn.size) closePlusMenuDom();
      setAddMenu(false);
      hideMemberCard();
      setMoreMenu(conversation.id);
    }
  }

  /* 菜单设置走 adapter 的可选能力：事件回声驱动重绘，不搞第二份本地状态；
     未实现该能力的 adapter 上给诚实边界提示。返回值再 apply 一次是幂等兜底。
     `silent` 只给「进入会话即已读」这条隐式路径用：用户没点任何设置，能力缺失时
     弹「会话设置将在 ni-chat 协议接入后开放」与动作不搭，且徽标清不掉会让它
     每次点进都再弹一次——静默跳过，徽标保留本身就是诚实边界；提示只留给用户
     显式改设置（静音/标未读）的那一下。 */
  async function applyConversationSettings(
    conversation: ConversationSummary,
    patch: { muted?: boolean; unreadCount?: number },
    flags?: { silent?: boolean },
  ): Promise<void> {
    if (!options.adapter.updateConversationSettings) {
      if (!flags?.silent) {
        sendError = "会话设置将在 ni-chat 协议接入后开放";
        renderConversation();
      }
      return;
    }
    try {
      const updated = await options.adapter.updateConversationSettings({ conversationId: conversation.id, ...patch });
      coordinator.apply({ type: "conversation.updated", conversation: updated });
    } catch (cause) {
      sendError = userFacingError(cause, "会话设置暂时无法保存，请稍后重试");
      renderConversation();
    }
  }

  function enterConversation(conversation: ConversationSummary): void {
    if (selectedConversationId !== conversation.id) {
      /* 换会话 = 脚下整个换掉：更多菜单、成员卡、「+」清单、@ 选择器与右侧
         抽屉一起收（对照稿 openAgent 里 closeDrawer + closeAcMore + 换会话
         连栈里那条一起摘；轻浮层与抽屉档都不跨会话存续）。确认坞的收缩/收起
         意图也不跨会话——新会话的待确认从展开态起步（对照稿 askPinned 在换
         对话时解除）。附件按会话隔离，各看各的（对照稿单输入框所以要
         resetDraft，这里不需要）。 */
      setMoreMenu("");
      hideMemberCard();
      plusMenuOpenIn.clear();
      mentionPickerOpen.clear();
      mentionQueryStart = -1;
      askDockMini = false;
      askDockPinnedId = "";
      closeDrawer();
    }
    selectedConversationId = conversation.id;
    sendError = "";
    renderList();
    renderConversation();
    /* 进入会话即已读（对照稿 openAgent 的 a.unread=0）。只在用户真的点进来时
       清零——初始未选态（A4-6）不碰任何会话的未读数。这条是隐式路径：受限
       adapter 上静默跳过（见 applyConversationSettings 的 silent 注释）。 */
    if (conversation.unreadCount > 0) {
      void applyConversationSettings(conversation, { unreadCount: 0 }, { silent: true });
    }
  }

  function closeConversationView(): void {
    selectedConversationId = "";
    moreMenuOpenIn = "";
    memberCardProfileId = "";
    plusMenuOpenIn.clear();
    mentionPickerOpen.clear();
    mentionQueryStart = -1;
    askDockMini = false;
    askDockPinnedId = "";
    /* 退出对话回到空白页，抽屉跟着收（对照稿 closeAgent 的 closeDrawer）。 */
    closeDrawer();
    renderList();
    renderConversation();
  }

  function pickMoreMenu(conversation: ConversationSummary, key: string): void {
    /* 菜单开着期间可能来过 conversation.updated（新消息、别端改了静音），
     翻转方向不能用渲染菜单时的那份快照——实时取，取不到再退回快照。 */
    const fresh = coordinator.current.conversations.find((candidate) => candidate.id === conversation.id) ?? conversation;
    /* 先关自己再办事（对照稿 acMorePick）：invite 会开出第二个覆盖浮层，
       不先关就是两层叠着，确认键办了底下那层的事。 */
    setMoreMenu("");
    if (key === "mute") {
      void applyConversationSettings(fresh, { muted: !fresh.muted });
      return;
    }
    if (key === "unread") {
      /* 标为未读：人明确表示「这条我还要再看」，所以要真的退出会话——
         留在会话里的未读，下一秒就被「进入即已读」清掉，等于按了没反应。 */
      void applyConversationSettings(fresh, { unreadCount: Math.max(1, fresh.unreadCount || 0) });
      closeConversationView();
      return;
    }
    if (key === "invite") {
      openInvite(fresh);
      return;
    }
    if (key === "close") {
      closeConversationView();
      return;
    }
  }

  /* —— 拉 agent 进群（对照稿 invLayer）：候选是「能拉进群的 agent 里
     不在这个群里的」；adapter 没有改参与者的协议能力，选完停在诚实的
     协议边界提示上，不假装加进去了。 */
  function inviteCandidates(conversation: ConversationSummary): Profile[] {
    return pickableAgentProfiles().filter((profile) => !conversation.participantIds.includes(profile.id));
  }

  function renderInviteList(restoreProfileId?: string): void {
    const conversation = coordinator.current.conversations.find((candidate) => candidate.id === inviteConversationId);
    if (!conversation) return;
    const previousFocus = restoreProfileId
      ?? (document.activeElement instanceof HTMLElement ? document.activeElement.dataset.pickProfileId : undefined);
    inviteTitle.textContent = `拉 agent 进「${conversationTitle(coordinator.current, conversation)}」`;
    inviteList.replaceChildren();
    const candidates = inviteCandidates(conversation);
    if (!candidates.length) {
      const empty = element("p", "ni-overlay-empty");
      empty.textContent = "能拉的都已经在群里了";
      inviteList.appendChild(empty);
    }
    candidates.forEach((profile) => {
      const item = button("ni-pick-item", "");
      item.dataset.pickProfileId = profile.id;
      const avatarCell = element("span", "ni-pick-avatar");
      avatarCell.textContent = profile.avatarText;
      const copy = element("span", "ni-pick-copy");
      const title = element("span", "ni-pick-title");
      title.textContent = profile.displayName;
      const sub = element("span", "ni-pick-sub");
      sub.textContent = `@${profile.username}`;
      copy.append(title, sub);
      const tag = element("span", "ni-pick-tag");
      tag.textContent = "添加";
      item.append(avatarCell, copy, tag);
      item.addEventListener("click", () => {
        setOverlayNote(inviteNote, "拉 agent 进群将在 ni-chat 协议接入后开放");
        queueMicrotask(() => inviteList.querySelector<HTMLButtonElement>(`[data-pick-profile-id="${profile.id}"]`)?.focus());
      });
      inviteList.appendChild(item);
    });
    if (previousFocus) {
      queueMicrotask(() => inviteList.querySelector<HTMLButtonElement>(`[data-pick-profile-id="${previousFocus}"]`)?.focus());
    }
  }

  function openInvite(conversation: ConversationSummary): void {
    inviteConversationId = conversation.id;
    setOverlayNote(inviteNote, "");
    renderInviteList();
    openOverlay("invite");
    inviteCard.focus();
  }

  /* ===== 点 @ 弹成员卡（A4-9，对照稿 memCard）：小浮层，不是抽屉 ===== */

  /* 「单独找他」的路真实存在才画：与这个人（且含自己）的单聊会话。 */
  function directConversationWith(profileId: string): ConversationSummary | undefined {
    const state = coordinator.current;
    return state.conversations.find((candidate) =>
      candidate.type === "private"
      && candidate.participantIds.includes(state.selfProfileId)
      && candidate.participantIds.includes(profileId));
  }

  function renderMemberCard(profileId: string): void {
    const profile = coordinator.current.profiles[profileId];
    if (!profile) {
      hideMemberCard();
      return;
    }
    memberCard.replaceChildren();
    const head = element("div", "ni-member-card-h");
    const avatarCell = element("span", "ni-member-card-av");
    avatarCell.textContent = profile.avatarText;
    const who = element("div", "ni-member-card-who");
    const name = element("div", "ni-member-card-nm");
    name.textContent = profile.displayName;
    who.appendChild(name);
    const idRow = element("div", "ni-member-card-rl");
    idRow.append(profileBadge(profile), `@${profile.username}`);
    who.appendChild(idRow);
    head.append(avatarCell, who);
    memberCard.appendChild(head);
    if (profile.bio) {
      const bio = element("div", "ni-member-card-st");
      bio.textContent = profile.bio;
      memberCard.appendChild(bio);
    }
    /* 稿上的「在忙什么」对应这里的 presence：capability 与 TTL 由
       visiblePresence 自己判断，没有就不画，不编状态。 */
    const presence = coordinator.visiblePresence(profile.id);
    if (presence) {
      const status = element("div", "ni-member-card-st");
      status.textContent = presence.state === "online"
        ? "在线"
        : presence.lastSeenAt ? `上次在线 ${formatClock(presence.lastSeenAt)}` : "离线";
      memberCard.appendChild(status);
    }
    if (profile.id !== coordinator.current.selfProfileId) {
      const direct = directConversationWith(profile.id);
      if (direct) {
        const go = button("ni-member-card-go", "单独找他");
        go.dataset.goConversationId = direct.id;
        go.addEventListener("click", () => {
          hideMemberCard();
          enterConversation(direct);
        });
        memberCard.appendChild(go);
      }
    }
  }

  function positionMemberCard(anchor: HTMLElement): void {
    /* 贴着被点的那个 @ 出现（对照稿 showMemCard）：右侧超出会话区就往左靠 */
    const box = conversationPane.getBoundingClientRect();
    const rect = anchor.getBoundingClientRect();
    memberCard.classList.add("show");
    const width = memberCard.offsetWidth || 198; // 测试环境量不出宽度时按 CSS 定值
    memberCard.style.left = `${Math.max(0, Math.min(rect.left - box.left, box.width - width - 12))}px`;
    memberCard.style.top = `${Math.max(0, rect.bottom - box.top + 6)}px`;
  }

  function showMemberCard(profileId: string, anchor: HTMLElement): void {
    if (!coordinator.current.profiles[profileId]) return;
    memberCardProfileId = profileId;
    setMoreMenu(""); // 同级轻浮层互斥：mention 的 click 停了冒泡，菜单要显式收
    renderMemberCard(profileId);
    positionMemberCard(anchor);
  }

  function hideMemberCard(): void {
    memberCardProfileId = "";
    memberCard.classList.remove("show");
  }

  /* 全量重绘后锚点换了节点：重新找同一个人重新贴位；那条消息没了或人没了
     就收——卡不能指着一个看不见的 @ 留在屏幕上。 */
  function syncMemberCard(): void {
    if (!memberCardProfileId) {
      memberCard.classList.remove("show");
      return;
    }
    const anchor = Array.from(conversationPane.querySelectorAll<HTMLElement>(".ni-mention.is-resolved"))
      .find((node) => node.dataset.profileId === memberCardProfileId);
    if (!anchor) {
      hideMemberCard();
      return;
    }
    renderMemberCard(memberCardProfileId);
    positionMemberCard(anchor);
  }

  addContact.addEventListener("click", (event) => {
    event.stopPropagation();
    if (overlay) closeOverlay();
    setMoreMenu(""); // 同级互斥：右栏的「更多」菜单不能和中栏菜单同场
    setAddMenu(!addMenuOpen);
  });

  addMenu.addEventListener("click", (event) => {
    event.stopPropagation();
    const target = event.target instanceof HTMLElement ? event.target.closest<HTMLElement>("[data-am]") : undefined;
    if (!target || target.dataset.am === "reset") return;
    setAddMenu(false);
    if (target.dataset.am === "add") handOffToAddAgent();
    else if (target.dataset.am === "group") openNewGroup();
    else if (target.dataset.am === "scan") openScanLocal();
  });

  /* 点外收不带蒙层的轻浮层（「+」清单、@ 选择器、「更多」菜单、成员卡）：它们没有
     蒙层，用户的直觉就是「点旁边就没了」。触发钮与自身豁免；@ 选择器额外豁免
     输入框（对照稿：!e.target.closest('#atPick,#acInput')——正在打字的每一次
     落键都在输入框里，那不是「点外」）。 */
  const onDocumentClick = (event: Event) => {
    setAddMenu(false);
    const target = event.target instanceof HTMLElement ? event.target : undefined;
    if (plusMenuOpenIn.size && !target?.closest(".ni-plus-menu, .ni-composer-attach, .ni-composer-attachment")) closePlusMenuDom();
    if (mentionPickerOpen.size && !target?.closest(".ni-mention-picker, .ni-composer-input")) closeMentionPickerDom();
    if (moreMenuOpenIn && !target?.closest('.ni-more-menu, .ni-header-action[aria-haspopup="menu"]')) setMoreMenu("");
    if (memberCardProfileId && !target?.closest(".ni-member-card, .ni-mention")) hideMemberCard();
  };
  document.addEventListener("click", onDocumentClick);

  /* Esc 走 document 级：设计稿的 Esc 是全局收栈（ovCloseTop），不依赖焦点
     落在哪——浮层元素上的 keydown 在焦点漂走后就收不到事件了。
     先覆盖浮层、再菜单（中栏「+」、右栏「+」清单、@ 选择器、「更多」）、
     再确认坞的收起、最后成员卡（对照稿：memCard 不进栈，收在栈之后；
     ask 的 collapseAsk 在浮层之后），一层一层退。 */
  const onDocumentKeydown = (event: Event): void => {
    if (disposed || !(event instanceof KeyboardEvent) || event.key !== "Escape") return;
    if (event.isComposing) return; // 输入法组合中的 Esc 是取消拼音，不是关闭浮层
    if (overlay) {
      closeOverlay();
      addContact.focus();
    } else if (addMenuOpen) {
      setAddMenu(false);
      addContact.focus();
    } else if (plusMenuOpenIn.size) {
      closePlusMenuDom();
      conversationPane.querySelector<HTMLButtonElement>(".ni-composer-attach")?.focus();
    } else if (mentionPickerOpen.size) {
      closeMentionPickerDom();
      conversationPane.querySelector<HTMLTextAreaElement>(".ni-composer-input")?.focus();
    } else if (moreMenuOpenIn) {
      setMoreMenu("");
      conversationPane.querySelector<HTMLButtonElement>('.ni-header-action[aria-haspopup="menu"]')?.focus();
    } else if (conversationPane.querySelector(".ni-ask-dock:not(.is-mini)")) {
      /* Esc 对确认坞 = 收起选项面板、待确认状态一点不变——收缩条还挂着、
         问题摘要还在（对照稿 collapseAsk）。稿的 Esc=Say No 需要 opts 里有
         打了 no 标记的「不做」项，协议的 choice options 没有 no 字段——
         不造假代答，只走稿的「只收起」分支；收起后自动展开让位（askPinned）。 */
      const dock = conversationPane.querySelector<HTMLElement>(".ni-ask-dock");
      askDockMini = true;
      askDockPinnedId = dock?.dataset.interactionId ?? "";
      dock?.classList.add("is-mini");
    } else if (memberCardProfileId) {
      hideMemberCard();
    } else if (drawerMode) {
      /* 抽屉在会话内层级链的位置对照稿 doEsc：成员卡/确认坞/半句话之后、
         退出对话之前——Esc 只关抽屉，人还在会话里（稿：抽屉是开着也不碍事
         的辅助面板，最后进入的先退出）。 */
      closeDrawer();
    }
  };
  document.addEventListener("keydown", onDocumentKeydown);

  newGroupNameInput.addEventListener("input", () => {
    if (newGroupNameInput.placeholder !== GROUP_NAME_PLACEHOLDER) newGroupNameInput.placeholder = GROUP_NAME_PLACEHOLDER;
    setOverlayNote(newGroupNote, "");
  });
  newGroupNameInput.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.isComposing) return;
    event.preventDefault();
    submitNewGroup(); // 名字框里 Enter = 直接建（对照稿）
  });
  newGroupGo.addEventListener("click", () => submitNewGroup());

  search.addEventListener("input", () => {
    query = search.value;
    renderList();
  });

  const offCoordinator = coordinator.subscribe(() => scheduleRenderAll());
  renderAll();
  if (options.initialConversation === "pinned") {
    const pinned = coordinator.current.conversations.find((conversation) => conversation.pinned);
    if (pinned) enterConversation(pinned);
  }

  /* 跨 App intent（A3-24「发给 agent」）的落点：内容以附件形态出现在输入侧。
     换挡型上下文有 cycleContextScope，这里只管「放进条上」这一步。 */
  function attachExternalContext(attachment: { label: string; text: string }): boolean {
    if (disposed) return false;
    const conversation =
      coordinator.current.conversations.find((candidate) => candidate.id === selectedConversationId)
        ?? coordinator.current.conversations[0];
    if (!conversation) return false;
    if (selectedConversationId !== conversation.id) {
      enterConversation(conversation);
    } else {
      renderConversation();
    }
    const list = attachmentsByConversation.get(conversation.id) ?? [];
    attachmentsByConversation.set(conversation.id, [
      ...list,
      { kind: "external-context", label: attachment.label, text: attachment.text },
    ]);
    plusMenuOpenIn.clear();
    sendError = "";
    renderConversation();
    return true;
  }

  /* B6-26（稿 10401-10415 tmGoIm 的会话级落地）：按 agent 身份定位会话。
     一对一优先于群——任务详情问的是「这件事的来龙去脉」，私聊就是那条主线；
     群会话只是回退。命中后走 enterConversation（与用户点列表同一跳路径，
     未读清零等行为一致）。 */
  function openConversationByAgent(ref: { agentId?: string; agentName: string }): boolean {
    const state = coordinator.current;
    const selfId = state.selfProfileId;
    /* 只认 agent 身份：入口语义是「去这个 agent 的会话」，人类/系统账号的
       displayName 撞名或 agentId 误传（如 "me"）都不许把人带进错误会话。
       agentId 是精确锚（调用方持有它时不做名称兜底）：ID 与名称指向两个
       不同账号时宁可不开门，也不把人带进「看起来对」的错误会话。 */
    const profile = Object.values(state.profiles).find((candidate) => {
      if (candidate.type !== "agent") return false;
      if (ref.agentId) return candidate.id === ref.agentId;
      return candidate.displayName === ref.agentName || candidate.username === ref.agentName;
    });
    if (!profile) return false;
    const withAgent = state.conversations.filter(
      (conversation) => conversation.participantIds.includes(profile.id),
    );
    const oneOnOne = withAgent.find(
      (conversation) =>
        conversation.type === "private" &&
        conversation.participantIds.includes(selfId) &&
        conversation.participantIds.length === 2,
    );
    const group = withAgent.find(
      (conversation) =>
        conversation.type !== "system" && conversation.participantIds.includes(selfId),
    );
    const target = oneOnOne ?? group;
    if (!target) return false;
    enterConversation(target);
    return true;
  }

  return {
    dispose() {
      disposed = true;
      clearTimeout(scanTimer);
      clearTimeout(transientExpiryTimer);
      /* 手柄拖拽中卸载：复位全局态（body 光标锁、document 监听），不留悬空监听；
         settle=false——卸载不落盘 */
      stopSidebarDrag(undefined, false);
      if (sidebarReflowRaf) cancelAnimationFrame(sidebarReflowRaf);
      window.removeEventListener("resize", onSidebarReflow);
      drawerObserver.disconnect();
      document.removeEventListener("click", onDocumentClick);
      document.removeEventListener("keydown", onDocumentKeydown);
      offAdapter();
      offCoordinator();
      root.replaceChildren();
    },
    attachExternalContext,
    openConversationByAgent,
  };
}
