import type {
  ConversationSummary,
  Interaction,
  InteractionSchema,
  MentionRef,
  Message,
  MessagePart,
  NiChatCapability,
  NiChatState,
  Participant,
  Presence,
  Profile,
  ReplyReference,
  TransientStatus,
  UnknownPart,
} from "./model";

const EPOCH = "1970-01-01T00:00:00.000Z";

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  const result = string(value)?.trim();
  return result ? result : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function revision(value: unknown): number {
  const result = number(value);
  if (result === undefined) console.debug("[ni.chat] normalized missing or invalid revision");
  return result === undefined ? 0 : Math.max(0, Math.trunc(result));
}

function validDateString(value: unknown): string | undefined {
  const result = string(value);
  if (!result) return undefined;
  const timestamp = Date.parse(result);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}

function replyReference(value: unknown): ReplyReference | undefined {
  const candidate = record(value);
  const messageId = nonEmptyString(candidate?.messageId);
  if (!messageId) return undefined;
  return {
    messageId,
    senderLabel: string(candidate?.senderLabel) ?? "",
    preview: string(candidate?.preview) ?? "",
  };
}

function unknownPart(originalKind: string): UnknownPart {
  return { kind: "unknown", originalKind: originalKind.slice(0, 80) || "unknown" };
}

function mentions(value: unknown): MentionRef[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const safe = value.flatMap((item) => {
    const candidate = record(item);
    const profileId = string(candidate?.profileId);
    const label = string(candidate?.label);
    return profileId && label ? [{ profileId, label }] : [];
  });
  return safe.length ? safe : undefined;
}

export function normalizeMessagePart(value: unknown): MessagePart {
  const candidate = record(value);
  const kind = string(candidate?.kind) ?? "unknown";
  switch (kind) {
    case "text": {
      const text = string(candidate?.text);
      if (text === undefined) return unknownPart(kind);
      const safeMentions = mentions(candidate?.mentions);
      return safeMentions ? { kind, text, mentions: safeMentions } : { kind, text };
    }
    case "thinking": {
      const summary = string(candidate?.summary);
      return summary === undefined ? unknownPart(kind) : { kind, summary };
    }
    case "tool_call": {
      const name = string(candidate?.name);
      const status = string(candidate?.status);
      if (!name || !status || !["pending", "running", "completed", "failed"].includes(status)) return unknownPart(kind);
      const summary = string(candidate?.summary);
      return summary
        ? { kind, name, status: status as "pending" | "running" | "completed" | "failed", summary }
        : { kind, name, status: status as "pending" | "running" | "completed" | "failed" };
    }
    case "tool_result": {
      const name = string(candidate?.name);
      const status = string(candidate?.status);
      const summary = string(candidate?.summary);
      if (!name || !summary || (status !== "completed" && status !== "failed")) return unknownPart(kind);
      return { kind, name, status, summary };
    }
    case "image": {
      const fileId = string(candidate?.fileId);
      const name = string(candidate?.name);
      const alt = string(candidate?.alt);
      return fileId && name && alt ? { kind, fileId, name, alt } : unknownPart(kind);
    }
    case "audio":
    case "video": {
      const fileId = string(candidate?.fileId);
      const name = string(candidate?.name);
      const durationSeconds = number(candidate?.durationSeconds);
      if (!fileId || !name) return unknownPart(kind);
      return durationSeconds === undefined ? { kind, fileId, name } : { kind, fileId, name, durationSeconds };
    }
    case "file": {
      const fileId = string(candidate?.fileId);
      const name = string(candidate?.name);
      const mimeType = string(candidate?.mimeType);
      const sizeBytes = number(candidate?.sizeBytes);
      return fileId && name && mimeType && sizeBytes !== undefined
        ? { kind, fileId, name, mimeType, sizeBytes }
        : unknownPart(kind);
    }
    case "webpage": {
      const url = string(candidate?.url);
      const title = string(candidate?.title);
      const description = string(candidate?.description);
      if (!url || !title) return unknownPart(kind);
      return description ? { kind, url, title, description } : { kind, url, title };
    }
    case "interaction_ref": {
      const interactionId = string(candidate?.interactionId);
      return interactionId ? { kind, interactionId } : unknownPart(kind);
    }
    /* A4-12 的附件标记：Mock 发送链路会产生，外部 adapter 数据里也可能出现。
       归一化直通而不是降级为 unknown——「带上的上下文」降级成「暂不支持」
       会让真实带上的东西在消息流里凭空消失。 */
    case "context_ref": {
      const label = string(candidate?.label);
      const messageCount = number(candidate?.messageCount);
      return label && messageCount !== undefined
        ? { kind, label, messageCount }
        : unknownPart(kind);
    }
    /* A3-24 的跨 App 附件标记：与 context_ref 同一条直通理由——降级成 unknown
       会让「带上的现场记录」在消息流里凭空消失。 */
    case "external_context": {
      const label = string(candidate?.label);
      const text = string(candidate?.text);
      return label && text ? { kind, label, text } : unknownPart(kind);
    }
    case "unknown": {
      const originalKind = string(candidate?.originalKind) ?? "unknown";
      const safeSummary = string(candidate?.safeSummary)?.slice(0, 80);
      return safeSummary ? { kind, originalKind: originalKind.slice(0, 80), safeSummary } : unknownPart(originalKind);
    }
    default:
      return unknownPart(kind);
  }
}

export function normalizeMessage(value: unknown): Message | undefined {
  const message = record(value);
  const id = nonEmptyString(message?.id);
  const conversationId = nonEmptyString(message?.conversationId);
  const senderId = nonEmptyString(message?.senderId);
  if (!message || !id || !conversationId || !senderId) {
    console.debug("[ni.chat] dropped malformed message envelope");
    return undefined;
  }
  const rawParts = Array.isArray(message.parts)
    ? message.parts
    : [];
  const result: Message = {
    id,
    conversationId,
    senderId,
    revision: revision(message.revision),
    origin: message.origin === "system" ? "system" : "profile",
    parts: rawParts.length ? rawParts.map(normalizeMessagePart) : [unknownPart("malformed_message")],
    createdAt: validDateString(message.createdAt) ?? EPOCH,
  };
  const replyTo = replyReference(message.replyTo);
  const editedAt = validDateString(message.editedAt);
  const deletedAt = validDateString(message.deletedAt);
  if (replyTo) result.replyTo = replyTo;
  if (editedAt) result.editedAt = editedAt;
  if (deletedAt) result.deletedAt = deletedAt;
  return result;
}

export function normalizeConversationSummary(value: unknown): ConversationSummary | undefined {
  const conversation = record(value);
  const id = nonEmptyString(conversation?.id);
  if (!conversation || !id) {
    console.debug("[ni.chat] dropped malformed conversation envelope");
    return undefined;
  }
  const participantIds = Array.isArray(conversation.participantIds)
    ? conversation.participantIds.flatMap((profileId) => nonEmptyString(profileId) ?? [])
    : [];
  const type = conversation.type === "group" || conversation.type === "system"
    ? conversation.type
    : "private";
  const result: ConversationSummary = {
    id,
    revision: revision(conversation.revision),
    type,
    participantIds,
    lastMessagePreview: string(conversation.lastMessagePreview) ?? "",
    lastMessageAt: validDateString(conversation.lastMessageAt) ?? EPOCH,
    unreadCount: Math.max(0, Math.trunc(number(conversation.unreadCount) ?? 0)),
  };
  const title = string(conversation.title);
  const needsActionCount = number(conversation.needsActionCount);
  if (title) result.title = title;
  if (needsActionCount !== undefined) result.needsActionCount = Math.max(0, Math.trunc(needsActionCount));
  if (typeof conversation.pinned === "boolean") result.pinned = conversation.pinned;
  if (typeof conversation.muted === "boolean") result.muted = conversation.muted;
  return result;
}

function interactionSchema(value: unknown): InteractionSchema {
  const schema = record(value);
  const kind = string(schema?.kind) ?? "unknown";
  if (kind === "choice") {
    const options = Array.isArray(schema?.options)
      ? schema.options.flatMap((value) => {
        const option = record(value);
        const id = nonEmptyString(option?.id);
        const label = nonEmptyString(option?.label);
        return id ? [{ id, label: label ?? id }] : [];
      })
      : [];
    return { kind, options };
  }
  if (kind === "text") {
    const result: InteractionSchema = { kind };
    const placeholder = string(schema?.placeholder);
    const maxLength = number(schema?.maxLength);
    if (placeholder !== undefined) result.placeholder = placeholder;
    if (maxLength !== undefined && maxLength > 0) result.maxLength = Math.trunc(maxLength);
    return result;
  }
  const originalKind = kind === "unknown"
    ? string(schema?.originalKind) ?? kind
    : kind;
  return { kind: "unknown", originalKind: originalKind.slice(0, 80) };
}

export function normalizeInteraction(value: unknown): Interaction | undefined {
  const interaction = record(value);
  const id = nonEmptyString(interaction?.id);
  const conversationId = nonEmptyString(interaction?.conversationId);
  const state = interaction?.state;
  if (!interaction || !id || !conversationId || !["pending", "answered", "cancelled", "expired"].includes(String(state))) {
    console.debug("[ni.chat] dropped malformed interaction envelope");
    return undefined;
  }
  const eligibleResponderIds = Array.isArray(interaction.eligibleResponderIds)
    ? interaction.eligibleResponderIds.flatMap((profileId) => nonEmptyString(profileId) ?? [])
    : [];
  const result: Interaction = {
    id,
    conversationId,
    state: state as Interaction["state"],
    version: revision(interaction.version),
    prompt: string(interaction.prompt) ?? "需要你的回答",
    schema: interactionSchema(interaction.schema),
    eligibleResponderIds,
  };
  if (interaction.expiresAt !== undefined) result.expiresAt = validDateString(interaction.expiresAt) ?? EPOCH;
  const answer = record(interaction.answer);
  const profileId = nonEmptyString(answer?.profileId);
  const answeredAt = validDateString(answer?.answeredAt);
  if (profileId && answeredAt) {
    result.answer = { profileId, answeredAt };
    const optionId = nonEmptyString(answer?.optionId);
    const text = string(answer?.text);
    if (optionId) result.answer.optionId = optionId;
    if (text !== undefined) result.answer.text = text;
  }
  return result;
}

export function normalizePresence(value: unknown): Presence | undefined {
  const presence = record(value);
  const profileId = nonEmptyString(presence?.profileId);
  if (!presence || !profileId || (presence.state !== "online" && presence.state !== "offline")) {
    console.debug("[ni.chat] dropped malformed presence envelope");
    return undefined;
  }
  const result: Presence = {
    profileId,
    revision: revision(presence.revision),
    state: presence.state,
  };
  if (presence.lastSeenAt !== undefined) result.lastSeenAt = validDateString(presence.lastSeenAt);
  if (presence.expiresAt !== undefined) result.expiresAt = validDateString(presence.expiresAt) ?? EPOCH;
  return result;
}

export function normalizeTransientStatus(value: unknown): TransientStatus | undefined {
  const status = record(value);
  const conversationId = nonEmptyString(status?.conversationId);
  const profileId = nonEmptyString(status?.profileId);
  const kind = status?.kind;
  if (!status || !conversationId || !profileId || !["typing", "thinking", "tool_calling"].includes(String(kind))) {
    console.debug("[ni.chat] dropped malformed transient status envelope");
    return undefined;
  }
  return {
    conversationId,
    profileId,
    revision: revision(status.revision),
    kind: kind as TransientStatus["kind"],
    expiresAt: validDateString(status.expiresAt) ?? EPOCH,
  };
}

function normalizeProfile(value: unknown): Profile | undefined {
  const profile = record(value);
  const id = nonEmptyString(profile?.id);
  if (!profile || !id) return undefined;
  const type = profile.type === "agent" || profile.type === "system" ? profile.type : "user";
  const username = nonEmptyString(profile.username) ?? id;
  const displayName = nonEmptyString(profile.displayName) ?? username;
  const result: Profile = {
    id,
    type,
    username,
    displayName,
    avatarText: nonEmptyString(profile.avatarText)?.slice(0, 4) ?? displayName.slice(0, 1).toLocaleUpperCase() ?? "?",
  };
  const bio = string(profile.bio);
  if (bio !== undefined) result.bio = bio;
  return result;
}

function normalizeParticipant(value: unknown): Participant | undefined {
  const participant = record(value);
  const conversationId = nonEmptyString(participant?.conversationId);
  const profileId = nonEmptyString(participant?.profileId);
  if (!participant || !conversationId || !profileId) return undefined;
  const role = participant.role === "owner" || participant.role === "admin" ? participant.role : "member";
  return {
    conversationId,
    profileId,
    role,
    joinedAt: validDateString(participant.joinedAt) ?? EPOCH,
  };
}

const KNOWN_CAPABILITIES: readonly NiChatCapability[] = [
  "presence.public",
  "status.transient",
  "message.stream",
  "interaction.answer",
];

export function normalizeNiChatState(state: unknown): NiChatState {
  const source = record(state) ?? {};
  const conversations = (Array.isArray(source.conversations) ? source.conversations : [])
    .flatMap((conversation) => normalizeConversationSummary(conversation) ?? []);
  const conversationIds = new Set(conversations.map((conversation) => conversation.id));
  const profiles = Object.fromEntries(
    Object.values(record(source.profiles) ?? {}).flatMap((profile) => {
      const normalized = normalizeProfile(profile);
      return normalized ? [[normalized.id, normalized]] : [];
    }),
  );
  const requestedSelfProfileId = nonEmptyString(source.selfProfileId) ?? "self";
  if (!profiles[requestedSelfProfileId]) {
    profiles[requestedSelfProfileId] = {
      id: requestedSelfProfileId,
      type: "user",
      username: requestedSelfProfileId,
      displayName: "你",
      avatarText: "你",
    };
  }
  const messagesByConversation: Record<string, Message[]> = Object.fromEntries(
    conversations.map((conversation) => [conversation.id, []]),
  );
  Object.values(record(source.messagesByConversation) ?? {}).forEach((list) => {
    if (!Array.isArray(list)) return;
    list.forEach((message) => {
      const normalized = normalizeMessage(message);
      if (!normalized || !conversationIds.has(normalized.conversationId)) return;
      messagesByConversation[normalized.conversationId]!.push(normalized);
    });
  });
  Object.values(messagesByConversation).forEach((messages) => {
    messages.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  });
  const interactions = Object.fromEntries(
    Object.values(record(source.interactions) ?? {}).flatMap((interaction) => {
      const normalized = normalizeInteraction(interaction);
      return normalized && conversationIds.has(normalized.conversationId) ? [[normalized.id, normalized]] : [];
    }),
  );
  const presenceByProfile = Object.fromEntries(
    Object.values(record(source.presenceByProfile) ?? {}).flatMap((presence) => {
      const normalized = normalizePresence(presence);
      return normalized && profiles[normalized.profileId] ? [[normalized.profileId, normalized]] : [];
    }),
  );
  const transientByConversation = Object.fromEntries(
    Object.values(record(source.transientByConversation) ?? {}).flatMap((status) => {
      const normalized = normalizeTransientStatus(status);
      return normalized && conversationIds.has(normalized.conversationId) && profiles[normalized.profileId]
        ? [[normalized.conversationId, normalized]]
        : [];
    }),
  );
  const participants = (Array.isArray(source.participants) ? source.participants : [])
    .flatMap((participant) => normalizeParticipant(participant) ?? [])
    .filter((participant) => conversationIds.has(participant.conversationId) && Boolean(profiles[participant.profileId]));
  const capabilities = (Array.isArray(source.capabilities) ? source.capabilities : [])
    .filter((capability): capability is NiChatCapability => KNOWN_CAPABILITIES.includes(capability as NiChatCapability));
  return {
    selfProfileId: requestedSelfProfileId,
    profiles,
    conversations,
    participants,
    messagesByConversation,
    interactions,
    presenceByProfile,
    transientByConversation,
    capabilities,
    transport: source.transport === "mock" ? "mock" : "host",
  };
}
