import {
  createMockNiChatAdapter,
  createMockNiChatState,
  mountNiChatView,
  type NiChatAdapter,
  type NiChatState,
  type NiChatView,
} from "@reai/ni-chat-ui";

export type AgentsImView = NiChatView;

export interface AgentsImViewOptions {
  adapter?: NiChatAdapter;
  now?: () => number;
}

/**
 * 官方 surface 的协议预览数据使用设计稿里的产品身份；底层 adapter、消息与
 * Interaction 合同保持不变。真实 Broker 接入后这个函数会随 Mock 一起删除。
 */
export function createAgentsImPreviewState(): NiChatState {
  const state = structuredClone(createMockNiChatState());
  const wainao = state.profiles["agent-coder"];
  if (wainao) {
    wainao.displayName = "外脑";
    wainao.username = "wainao";
    wainao.avatarText = "🧠";
    wainao.bio = "拿不准找谁的时候，找它";
  }
  const mail = state.profiles["human-alice"];
  if (mail) {
    mail.type = "agent";
    mail.displayName = "邮箱助手";
    mail.username = "mail-assistant";
    mail.avatarText = "✉️";
    mail.bio = "云端 · 邮件";
  }
  const system = state.profiles["system-ni"];
  if (system) {
    system.displayName = "每日简报";
    system.username = "daily-briefing";
    system.avatarText = "☀️";
  }

  for (const conversation of state.conversations) {
    if (conversation.id === "human-agent") {
      conversation.lastMessagePreview = "要加新的 agent，或者一件事不知道派给谁，直接跟我说。";
      conversation.unreadCount = 0;
      conversation.needsActionCount = 0;
    } else if (conversation.id === "human-human") {
      conversation.lastMessagePreview = "我起草了回复，要发吗？";
      conversation.unreadCount = 2;
      conversation.needsActionCount = 1;
    } else if (conversation.id === "mixed-group") {
      conversation.title = "AI Board 01 发布小组";
      conversation.lastMessagePreview = "Codex：那两个 warning 我改完提交";
    } else if (conversation.id === "agent-agent") {
      conversation.title = "研究协作";
    } else if (conversation.id === "system-news") {
      conversation.title = "每日简报";
      conversation.lastMessagePreview = "今天有 3 件值得留意的事";
    }
  }
  return state;
}

/**
 * ni.chat 的 surface 只依赖 adapter 合同。Phase 0 使用明确标识的 Mock adapter；
 * 后续 Host Broker 接入时替换 adapter，不在 WebView 中运行任何 Agent 或外部网络协议。
 */
export async function mountAgentsImView(root: HTMLElement, options: AgentsImViewOptions = {}): Promise<AgentsImView> {
  const adapter = options.adapter ?? createMockNiChatAdapter(createAgentsImPreviewState());
  const view = await mountNiChatView(root, { adapter, now: options.now, initialConversation: "pinned" });
  const marker = document.createElement("span");
  marker.className = "tbc-option-tag ni-chat-tbc";
  marker.dataset.tbcId = "tbc.agents-im-broker";
  marker.textContent = "TBC";
  marker.title = "会话、消息与状态当前由 Mock adapter 驱动";
  marker.setAttribute("aria-label", "TBC：会话、消息与状态当前由 Mock adapter 驱动");
  root.appendChild(marker);
  return view;
}

/** `attach-context@1.0`（A3-24「发给 agent」）的 intent 负载形状。 */
export interface AttachContextIntent {
  label: string;
  text: string;
}

/**
 * 识别并收窄「发给 agent」投来的 intent。Host 侧的 payload 校验目前只做
 * 「必须是对象」（intents.rs 登记的已知边界），字段级把关在这里补上：
 * 少 label 或 text 的负载宁可忽略，也不把一段残缺内容放进输入侧。
 */
export function isAttachContextIntent(intent: unknown): intent is AttachContextIntent {
  if (!intent || typeof intent !== "object") return false;
  const candidate = intent as { label?: unknown; text?: unknown };
  return typeof candidate.label === "string" && candidate.label.length > 0
    && typeof candidate.text === "string" && candidate.text.length > 0;
}

/** `open-conversation@1.0`（B6-26「在 IM 里看上下文」）的 intent 负载形状。 */
export interface OpenConversationIntent {
  agentName: string;
  agentId?: string;
}

/** 同一收窄口径：agentName 必填非空，agentId 可选——残缺负载宁可忽略也不乱跳。 */
export function isOpenConversationIntent(intent: unknown): intent is OpenConversationIntent {
  if (!intent || typeof intent !== "object") return false;
  const candidate = intent as { agentName?: unknown; agentId?: unknown };
  if (typeof candidate.agentName !== "string" || candidate.agentName.length === 0) return false;
  if (candidate.agentId !== undefined && typeof candidate.agentId !== "string") return false;
  return true;
}
