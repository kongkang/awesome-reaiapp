import { VoiceAttachmentContentError } from "./voice-attachment-content";
import { availableVoiceAttachmentModes, type VoiceAttachmentReaders, type VoiceModelAttachmentSnapshot, type VoiceAttachmentTransports } from "./voice-model-attachment-policy";

/** Parser formats, not backend/model capability tag names. */
export type VoiceAttachmentFormat = "text" | "pdf" | "xlsx" | "xls" | "image";

/** Only the descriptor-gated Host local snapshot can admit a format.
 * Parser availability and model names never imply model input support. */
export interface VoiceAttachmentAdmissionContext {
  snapshot: VoiceModelAttachmentSnapshot | undefined;
  expected: { opaqueBinding: string; revision: number } | undefined;
  readers: VoiceAttachmentReaders;
  transports?: VoiceAttachmentTransports;
}
export function confirmedVoiceAttachmentFormats(context?: VoiceAttachmentAdmissionContext): readonly VoiceAttachmentFormat[] {
  // Every Voice attachment turn also carries a text question; match the Host guard.
  if (!context || context.snapshot?.inputs?.text !== true) return [];
  const modes = availableVoiceAttachmentModes(context.snapshot, context.expected, context.readers, context.transports);
  const formats: VoiceAttachmentFormat[] = [];
  if (modes.includes("text")) formats.push("text");
  if (modes.includes("pdf-text")) formats.push("pdf");
  if (modes.includes("spreadsheet-text")) formats.push("xlsx", "xls");
  if (modes.includes("image")) formats.push("image");
  return formats;
}

export function voiceAttachmentFormat(file: { name: string; type: string }): VoiceAttachmentFormat | undefined {
  const mime = file.type.toLowerCase().split(";", 1)[0]!.trim();
  const extension = file.name.split(".").at(-1)?.toLowerCase();
  if (extension === "pdf" || extension === "xlsx" || extension === "xls") return extension;
  if (mime === "application/pdf") return "pdf";
  if (mime === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") return "xlsx";
  if (mime === "application/vnd.ms-excel") return "xls";
  if (["image/png", "image/jpeg"].includes(mime) || extension && ["png", "jpg", "jpeg"].includes(extension)) return "image";
  if (/^(?:image|audio|video)\//.test(mime) || extension && ["png", "jpg", "jpeg", "webp", "gif", "heic", "svg", "doc", "docx", "ppt", "pptx", "xlsm", "zip"].includes(extension)) return undefined;
  return "text";
}

export function requireVoiceAttachmentAdmission(file: { name: string; type: string }, formats: readonly VoiceAttachmentFormat[]): void {
  const format = voiceAttachmentFormat(file);
  if (!format || !formats.includes(format)) throw new VoiceAttachmentContentError("VOICE_ATTACHMENT_MODEL_UNCONFIRMED");
}
