import type {
  ConversationSummary,
  Message,
  NiChatEvent,
  NiChatState,
  Presence,
  TransientStatus,
} from "./model";
import {
  normalizeConversationSummary,
  normalizeInteraction,
  normalizeMessage,
  normalizeNiChatState,
  normalizePresence,
  normalizeTransientStatus,
} from "./normalize";

export interface CoordinatorOptions {
  now?: () => number;
}

function cloneState(state: NiChatState): NiChatState {
  return normalizeNiChatState(state);
}

const MAX_PENDING_MESSAGE_UPDATES = 1_000;
const MAX_PENDING_CONVERSATION_EVENTS = 1_000;

type PendingConversationEvent =
  | { type: "message.created"; message: Message }
  | { type: "message.updated"; message: Message };

export class NiChatStateCoordinator {
  private state: NiChatState;
  private readonly pendingUpdates = new Map<string, Message>();
  private pendingConversationEvents: PendingConversationEvent[] = [];
  private readonly listeners = new Set<(state: NiChatState) => void>();
  private readonly now: () => number;

  constructor(initial: NiChatState, options: CoordinatorOptions = {}) {
    this.state = cloneState(initial);
    this.now = options.now ?? Date.now;
  }

  get current(): NiChatState {
    return this.state;
  }

  subscribe(listener: (state: NiChatState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  apply(event: NiChatEvent): boolean {
    let changed = true;
    switch (event.type) {
      case "message.created":
        changed = this.applyCreated(event.message);
        break;
      case "message.updated":
        changed = this.applyUpdated(event.message);
        break;
      case "interaction.updated": {
        const incoming = normalizeInteraction(event.interaction);
        if (!incoming) return false;
        const previous = this.state.interactions[incoming.id];
        if (previous && incoming.version <= previous.version) return false;
        this.state.interactions[incoming.id] = structuredClone(incoming);
        break;
      }
      case "conversation.updated":
        changed = this.upsertConversation(event.conversation);
        break;
      case "presence.updated": {
        const incoming = normalizePresence(event.presence);
        if (!incoming) return false;
        const previous = this.state.presenceByProfile[incoming.profileId];
        if (previous && incoming.revision <= previous.revision) return false;
        this.state.presenceByProfile[incoming.profileId] = structuredClone(incoming);
        break;
      }
      case "transient.updated": {
        const incoming = normalizeTransientStatus(event.status);
        if (!incoming) return false;
        const previous = this.state.transientByConversation[incoming.conversationId];
        if (previous && incoming.revision <= previous.revision) return false;
        this.state.transientByConversation[incoming.conversationId] = structuredClone(incoming);
        break;
      }
    }
    if (changed) this.emit();
    return changed;
  }

  visiblePresence(profileId: string): Presence | undefined {
    if (!this.state.capabilities.includes("presence.public")) return undefined;
    const value = this.state.presenceByProfile[profileId];
    if (!value) return undefined;
    if (value.expiresAt !== undefined) {
      const expiresAt = Date.parse(value.expiresAt);
      if (!Number.isFinite(expiresAt) || expiresAt <= this.now()) return undefined;
    }
    return value;
  }

  visibleTransientStatus(conversationId: string): TransientStatus | undefined {
    if (!this.state.capabilities.includes("status.transient")) return undefined;
    const value = this.state.transientByConversation[conversationId];
    if (!value) return undefined;
    const expiresAt = Date.parse(value.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= this.now()) return undefined;
    return value;
  }

  private applyCreated(rawIncoming: Message): boolean {
    const incoming = normalizeMessage(rawIncoming);
    if (!incoming) return false;
    if (!this.state.conversations.some((conversation) => conversation.id === incoming.conversationId)) {
      this.queueConversationEvent({ type: "message.created", message: incoming });
      return false;
    }
    const list = this.state.messagesByConversation[incoming.conversationId] ?? [];
    const existingIndex = list.findIndex((message) => message.id === incoming.id);
    const pending = this.pendingUpdates.get(incoming.id);
    const winner = pending && pending.revision > incoming.revision ? pending : incoming;
    this.pendingUpdates.delete(incoming.id);
    if (existingIndex < 0) {
      list.push(structuredClone(winner));
      list.sort((left, right) => left.createdAt < right.createdAt ? -1 : left.createdAt > right.createdAt ? 1 : 0);
    } else if (winner.revision > list[existingIndex]!.revision) {
      list[existingIndex] = structuredClone(winner);
    } else {
      return false;
    }
    this.state.messagesByConversation[incoming.conversationId] = list;
    return true;
  }

  private applyUpdated(rawIncoming: Message): boolean {
    const incoming = normalizeMessage(rawIncoming);
    if (!incoming) return false;
    if (!this.state.conversations.some((conversation) => conversation.id === incoming.conversationId)) {
      this.queueConversationEvent({ type: "message.updated", message: incoming });
      return false;
    }
    const list = this.state.messagesByConversation[incoming.conversationId] ?? [];
    const existingIndex = list.findIndex((message) => message.id === incoming.id);
    if (existingIndex < 0) {
      const pending = this.pendingUpdates.get(incoming.id);
      if (!pending || incoming.revision > pending.revision) {
        this.pendingUpdates.set(incoming.id, structuredClone(incoming));
        if (this.pendingUpdates.size > MAX_PENDING_MESSAGE_UPDATES) {
          const oldest = this.pendingUpdates.keys().next().value;
          if (oldest) this.pendingUpdates.delete(oldest);
        }
      }
      return false;
    }
    if (incoming.revision > list[existingIndex]!.revision) {
      list[existingIndex] = structuredClone(incoming);
      this.state.messagesByConversation[incoming.conversationId] = list;
      return true;
    }
    return false;
  }

  private upsertConversation(rawIncoming: ConversationSummary): boolean {
    const incoming = normalizeConversationSummary(rawIncoming);
    if (!incoming) return false;
    const index = this.state.conversations.findIndex((conversation) => conversation.id === incoming.id);
    if (index < 0) {
      this.state.conversations.push(structuredClone(incoming));
      this.replayConversationEvents(incoming.id);
      return true;
    }
    if (incoming.revision <= this.state.conversations[index]!.revision) return false;
    this.state.conversations[index] = structuredClone(incoming);
    return true;
  }

  private queueConversationEvent(event: PendingConversationEvent): void {
    console.debug("[ni.chat] buffered message for unknown conversation", event.message.conversationId);
    this.pendingConversationEvents.push(structuredClone(event));
    if (this.pendingConversationEvents.length > MAX_PENDING_CONVERSATION_EVENTS) {
      this.pendingConversationEvents.shift();
    }
  }

  private replayConversationEvents(conversationId: string): void {
    const matching = this.pendingConversationEvents.filter((event) => event.message.conversationId === conversationId);
    if (!matching.length) return;
    this.pendingConversationEvents = this.pendingConversationEvents
      .filter((event) => event.message.conversationId !== conversationId);
    matching.forEach((event) => {
      if (event.type === "message.created") this.applyCreated(event.message);
      else this.applyUpdated(event.message);
    });
  }

  private emit(): void {
    this.listeners.forEach((listener) => listener(this.state));
  }
}
