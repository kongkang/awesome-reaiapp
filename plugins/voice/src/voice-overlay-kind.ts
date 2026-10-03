import { BUILTIN_VOICE_COMMANDS, type VoiceCommandId } from "./voice-ai-contract";

/** Display only: command capture and text delivery keep their existing semantics. */
export function commandOverlayKind(commandId: VoiceCommandId): "input" | "translate" | "task" {
  if (commandId === BUILTIN_VOICE_COMMANDS.transcribe) return "input";
  if (commandId === BUILTIN_VOICE_COMMANDS.translate) return "translate";
  return "task";
}
