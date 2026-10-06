import { BUILTIN_VOICE_COMMANDS } from "./voice-ai-contract";
import { VoiceAttachmentContentError } from "./voice-attachment-content";

/** Scene admission precedes model admission. Reusing Agent/composer is not an
 * attachment permission; translation, polish, summary and unknown scenes close. */
export function voiceSceneAllowsAttachments(featureRef: unknown): boolean {
  return featureRef === "command";
}
export function voiceCommandAllowsAttachments(commandId: unknown): boolean {
  return commandId === BUILTIN_VOICE_COMMANDS.agent;
}
export function attachmentFormatsForVoiceCommand<T>(commandId: unknown, readModelFormats: () => readonly T[]): readonly T[] {
  return voiceCommandAllowsAttachments(commandId) ? readModelFormats() : [];
}
export function requireVoiceTaskAttachmentScene(commandId: unknown): void {
  if (!voiceCommandAllowsAttachments(commandId)) throw new VoiceAttachmentContentError("VOICE_ATTACHMENT_SCENE_UNSUPPORTED");
}

/** A metadata card is not the only evidence of a pending file request. The
 * canonical text envelope ends with one JSON line; inspect it without executing
 * HTML/script content or trusting historical card metadata. */
export function pendingVoiceRequestHasFileAttachments(text: string): boolean {
  const line = text.slice(text.lastIndexOf("\n") + 1);
  if (line.length > 64 * 1024) return true;
  try {
    const value: unknown = JSON.parse(line);
    return value !== null && typeof value === "object" && !Array.isArray(value)
      && Object.prototype.hasOwnProperty.call(value, "attachments")
      && Array.isArray((value as { attachments?: unknown }).attachments)
      && ((value as { attachments: unknown[] }).attachments).length > 0;
  } catch { return false; }
}
