export type ProfileType = "user" | "agent" | "system";

export interface Profile {
  id: string;
  type: ProfileType;
  username: string;
  displayName: string;
  avatarText: string;
  bio?: string;
}

export type ConversationType = "private" | "group" | "system";

export interface ConversationSummary {
  id: string;
  revision: number;
  type: ConversationType;
  participantIds: string[];
  title?: string;
  lastMessagePreview: string;
  lastMessageAt: string;
  unreadCount: number;
  needsActionCount?: number;
  pinned?: boolean;
  muted?: boolean;
}

export interface Participant {
  conversationId: string;
  profileId: string;
  role: "owner" | "admin" | "member";
  joinedAt: string;
}

export interface MentionRef {
  profileId: string;
  label: string;
}

export interface TextPart {
  kind: "text";
  text: string;
  mentions?: MentionRef[];
}

export interface ThinkingPart {
  kind: "thinking";
  summary: string;
}

export interface ToolCallPart {
  kind: "tool_call";
  name: string;
  status: "pending" | "running" | "completed" | "failed";
  summary?: string;
}

export interface ToolResultPart {
  kind: "tool_result";
  name: string;
  status: "completed" | "failed";
  summary: string;
}

export interface ImagePart {
  kind: "image";
  fileId: string;
  name: string;
  alt: string;
}

export interface AudioPart {
  kind: "audio";
  fileId: string;
  name: string;
  durationSeconds?: number;
}

export interface VideoPart {
  kind: "video";
  fileId: string;
  name: string;
  durationSeconds?: number;
}

export interface FilePart {
  kind: "file";
  fileId: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
}

export interface WebpagePart {
  kind: "webpage";
  url: string;
  title: string;
  description?: string;
}

export interface InteractionRefPart {
  kind: "interaction_ref";
  interactionId: string;
}

export interface UnknownPart {
  kind: "unknown";
  originalKind: string;
  safeSummary?: string;
}

/** 随消息带上的上下文标记（A4-12）：Mock 协议预览模型的扩展——真实 Host 协议
 *  接入后由 Host 决定附件 part 的最终形态，客户端只负责如实呈现。 */
export interface ContextRefPart {
  kind: "context_ref";
  /** 档位名，如「最近 5 条」 */
  label: string;
  /** 实际覆盖的消息条数（发送那一刻算，不写死） */
  messageCount: number;
}

/** 跨 App 带进来的一段外部上下文（A3-24）：Mock 协议预览模型的扩展，与
 *  ContextRefPart 同族——真实 Host 协议接入后由 Host 决定附件 part 的终态。 */
export interface ExternalContextPart {
  kind: "external_context";
  /** 呈现名（如「现场记录 14:03 · 84 字」） */
  label: string;
  /** 引用正文（发送那一刻的内容快照） */
  text: string;
}

export type MessagePart =
  | TextPart
  | ThinkingPart
  | ToolCallPart
  | ToolResultPart
  | ImagePart
  | AudioPart
  | VideoPart
  | FilePart
  | WebpagePart
  | InteractionRefPart
  | ContextRefPart
  | ExternalContextPart
  | UnknownPart;

export interface ReplyReference {
  messageId: string;
  senderLabel: string;
  preview: string;
}

export interface Message {
  id: string;
  conversationId: string;
  senderId: string;
  revision: number;
  origin: "profile" | "system";
  parts: MessagePart[];
  replyTo?: ReplyReference;
  createdAt: string;
  editedAt?: string;
  deletedAt?: string;
}

export interface ChoiceInteractionSchema {
  kind: "choice";
  options: Array<{ id: string; label: string }>;
}

export interface TextInteractionSchema {
  kind: "text";
  placeholder?: string;
  maxLength?: number;
}

export interface UnknownInteractionSchema {
  kind: "unknown";
  originalKind: string;
}

export type InteractionSchema = ChoiceInteractionSchema | TextInteractionSchema | UnknownInteractionSchema;

export type InteractionState = "pending" | "answered" | "cancelled" | "expired";

export interface Interaction {
  id: string;
  conversationId: string;
  state: InteractionState;
  version: number;
  prompt: string;
  schema: InteractionSchema;
  eligibleResponderIds: string[];
  expiresAt?: string;
  answer?: { profileId: string; optionId?: string; text?: string; answeredAt: string };
}

export interface Presence {
  profileId: string;
  revision: number;
  state: "online" | "offline";
  lastSeenAt?: string;
  expiresAt?: string;
}

export type TransientStatusKind = "typing" | "thinking" | "tool_calling";

export interface TransientStatus {
  conversationId: string;
  profileId: string;
  revision: number;
  kind: TransientStatusKind;
  expiresAt: string;
}

export type NiChatCapability =
  | "presence.public"
  | "status.transient"
  | "message.stream"
  | "interaction.answer";

export interface NiChatState {
  selfProfileId: string;
  profiles: Record<string, Profile>;
  conversations: ConversationSummary[];
  participants: Participant[];
  messagesByConversation: Record<string, Message[]>;
  interactions: Record<string, Interaction>;
  presenceByProfile: Record<string, Presence>;
  transientByConversation: Record<string, TransientStatus>;
  capabilities: NiChatCapability[];
  transport: "mock" | "host";
}

export type NiChatEvent =
  | { type: "message.created"; message: Message }
  | { type: "message.updated"; message: Message }
  | { type: "interaction.updated"; interaction: Interaction }
  | { type: "conversation.updated"; conversation: ConversationSummary }
  | { type: "presence.updated"; presence: Presence }
  | { type: "transient.updated"; status: TransientStatus };

/* 「这句话要带上的东西」（A4-12，对照稿 ac-att）：composer 的附件属于
   「正在写的那一条」，发送前住在附件条上、发送时随消息带上。当前唯一真实
   可得的类型是本会话上下文——数据就在客户端内存态，选中→发送→呈现全链路
   真实；图片/文件的 Host 通道未接，不伪造附件，只在「+」清单上给诚实边界。 */
export interface ContextAttachment {
  kind: "context";
  /** 上下文档位（点 chip 循环换挡用），对应 view 侧 CONTEXT_SCOPES 的下标 */
  scope: number;
  /** 档位名，如「最近 5 条」 */
  scopeLabel: string;
}

/** 跨 App 带进来的一段外部上下文（A3-24「发给 agent」）：来源不是本会话历史，
    而是另一个 App 的一段内容（当前唯一来源是 Voice 的现场记录）。chip 不换档，
    只能留着或移除——它引用的是一段固定的内容，不是一片可调的范围。 */
export interface ExternalContextAttachment {
  kind: "external-context";
  /** 呈现名，如「现场记录 14:03–14:41 · 84 字」（Voice 侧按段时间区间 + 字数生成） */
  label: string;
  /** 内容本体（Voice 侧的转写文本）。发送前住在附件条上，发送后随引用 part 走。 */
  text: string;
}

export type ComposerAttachment = ContextAttachment | ExternalContextAttachment;

/** 发送那一刻的附件快照：messageCount 由调用方按当时真实历史条数算好，
    adapter 只转发标记，不编数字。 */
export interface SentContextRef {
  kind: "context";
  scopeLabel: string;
  messageCount: number;
}

/** 外部上下文（A3-24）的发送快照：label 呈现、text 是引用正文。 */
export interface SentExternalContextRef {
  kind: "external-context";
  label: string;
  text: string;
}

export type SentAttachmentRef = SentContextRef | SentExternalContextRef;

export interface SendMessageInput {
  conversationId: string;
  text: string;
  replyTo?: ReplyReference;
  mentions?: MentionRef[];
  /** 这句话要带上的东西（A4-12）：随消息发送的附件标记 */
  attachments?: SentAttachmentRef[];
}

export interface AnswerInteractionInput {
  interactionId: string;
  version: number;
  answer: { optionId?: string; text?: string };
}

/* 会话头「更多」菜单的本地设置（A4-8）：muted / unreadCount 在摘要里已有字段，
   这里只是把「用户在菜单上改了」送回状态源。可选能力：Host Broker 接入前
   只有 Mock transport 实现，未实现的 adapter 上菜单给诚实边界提示。 */
export interface UpdateConversationSettingsInput {
  conversationId: string;
  muted?: boolean;
  unreadCount?: number;
}

export interface NiChatAdapter {
  getSnapshot(): Promise<NiChatState>;
  subscribe(listener: (event: NiChatEvent) => void): () => void;
  sendMessage(input: SendMessageInput): Promise<Message>;
  answerInteraction(input: AnswerInteractionInput): Promise<Interaction>;
  updateConversationSettings?(input: UpdateConversationSettingsInput): Promise<ConversationSummary>;
}
