import { NiChatStateCoordinator } from "./coordinator";
import type {
  AnswerInteractionInput,
  ConversationSummary,
  Interaction,
  Message,
  MessagePart,
  NiChatAdapter,
  NiChatEvent,
  NiChatState,
  SendMessageInput,
  UpdateConversationSettingsInput,
} from "./model";

function randomId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export class MockNiChatAdapter implements NiChatAdapter {
  private readonly coordinator: NiChatStateCoordinator;
  private readonly listeners = new Set<(event: NiChatEvent) => void>();
  private idle: Promise<void> = Promise.resolve();

  constructor(initial: NiChatState) {
    this.coordinator = new NiChatStateCoordinator(initial);
  }

  async getSnapshot(): Promise<NiChatState> {
    return structuredClone(this.coordinator.current);
  }

  subscribe(listener: (event: NiChatEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  sendMessage(input: SendMessageInput): Promise<Message> {
    return this.enqueue(async () => {
      const text = input.text.trim();
      if (!text) throw new Error("MESSAGE_TEXT_REQUIRED");
      if (!this.coordinator.current.conversations.some((item) => item.id === input.conversationId)) {
        throw new Error("CONVERSATION_NOT_FOUND");
      }
      const createdAt = new Date().toISOString();
      const textPart = input.mentions?.length
        ? { kind: "text" as const, text, mentions: structuredClone(input.mentions) }
        : { kind: "text" as const, text };
      /* 「这句话要带上的东西」（A4-12）：附件标记放在正文之前——引用在前、
         正文在后，与消息流里 reply 的呈现同构。messageCount 由调用方在发送
         那一刻按真实历史算好，这里只转发标记，不编数字。 */
      const attachmentParts: MessagePart[] = [];
      for (const attachment of input.attachments ?? []) {
        if (attachment.kind === "context") {
          attachmentParts.push({
            kind: "context_ref",
            label: attachment.scopeLabel,
            messageCount: attachment.messageCount,
          });
        } else if (attachment.kind === "external-context") {
          attachmentParts.push({ kind: "external_context", label: attachment.label, text: attachment.text });
        }
      }
      const created: Message = {
        id: randomId("message"),
        conversationId: input.conversationId,
        senderId: this.coordinator.current.selfProfileId,
        revision: 1,
        origin: "profile",
        parts: [...attachmentParts, textPart],
        replyTo: input.replyTo,
        createdAt,
      };
      this.publish({ type: "message.created", message: created });
      const conversation = this.coordinator.current.conversations.find((item) => item.id === input.conversationId)!;
      this.publish({
        type: "conversation.updated",
        conversation: { ...conversation, revision: conversation.revision + 1, lastMessagePreview: text, lastMessageAt: createdAt },
      });
      return structuredClone(created);
    });
  }

  answerInteraction(input: AnswerInteractionInput): Promise<Interaction> {
    return this.enqueue(async () => {
      const current = this.coordinator.current.interactions[input.interactionId];
      if (!current) throw new Error("INTERACTION_NOT_FOUND");
      if (current.state !== "pending") throw new Error("INTERACTION_NOT_PENDING");
      if (current.version !== input.version) throw new Error("INTERACTION_VERSION_CONFLICT");
      if (!current.eligibleResponderIds.includes(this.coordinator.current.selfProfileId)) {
        throw new Error("INTERACTION_NOT_ELIGIBLE");
      }
      const next: Interaction = {
        ...current,
        state: "answered",
        version: current.version + 1,
        answer: {
          profileId: this.coordinator.current.selfProfileId,
          optionId: input.answer.optionId,
          text: input.answer.text,
          answeredAt: new Date().toISOString(),
        },
      };
      this.publish({ type: "interaction.updated", interaction: next });
      return structuredClone(next);
    });
  }

  /* 「更多」菜单的本地设置（A4-8）：与 sendMessage 同一条串行队列，
     走 conversation.updated 事件回声，不搞第二份静默状态。 */
  updateConversationSettings(input: UpdateConversationSettingsInput): Promise<ConversationSummary> {
    return this.enqueue(async () => {
      const current = this.coordinator.current.conversations.find((item) => item.id === input.conversationId);
      if (!current) throw new Error("CONVERSATION_NOT_FOUND");
      const next: ConversationSummary = {
        ...current,
        revision: current.revision + 1,
        muted: input.muted ?? current.muted,
        unreadCount: input.unreadCount ?? current.unreadCount,
      };
      this.publish({ type: "conversation.updated", conversation: next });
      return structuredClone(next);
    });
  }

  async whenIdle(): Promise<void> {
    await this.idle;
  }

  /** Injects a protocol event into the explicit mock transport. */
  push(event: NiChatEvent): void {
    this.publish(event);
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.idle.then(operation);
    this.idle = result.then(() => undefined, () => undefined);
    return result;
  }

  private publish(event: NiChatEvent): void {
    this.coordinator.apply(event);
    this.listeners.forEach((listener) => listener(structuredClone(event)));
  }
}

export function createMockNiChatAdapter(initial: NiChatState): MockNiChatAdapter {
  return new MockNiChatAdapter(initial);
}
