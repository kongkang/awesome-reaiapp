/** Model flags, user reader choices and actual Host transports intersect locally. */
export type VoiceAttachmentMode = "text" | "pdf-text" | "spreadsheet-text" | "image" | "native-pdf";
export interface VoiceAttachmentReaders {
  text: boolean;
  extractedPdfText: boolean;
  extractedSpreadsheetText: boolean;
  images: boolean;
  nativePdf: boolean;
}
export interface VoiceModelAttachmentSnapshot {
  schemaVersion: 1;
  opaqueBinding: string;
  revision: number;
  inputs: { text: boolean; image: boolean; nativePdf: boolean };
}
export interface VoiceAttachmentTransports {
  textEnvelope: boolean;
  imageInput: boolean;
  nativePdfInput: boolean;
}
export const CURRENT_VOICE_ATTACHMENT_TRANSPORTS: Readonly<VoiceAttachmentTransports> = Object.freeze({
  textEnvelope: true, imageInput: false, nativePdfInput: false,
});
export const CLOSED_VOICE_ATTACHMENT_READERS: Readonly<VoiceAttachmentReaders> = Object.freeze({
  text: false, extractedPdfText: false, extractedSpreadsheetText: false, images: false, nativePdf: false,
});

const own = (object: object, key: string): boolean => Object.prototype.hasOwnProperty.call(object, key);
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function exactOwnKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => own(value, key));
}

/** Treat corrupt/legacy/partial data as absent, never optimistic capabilities. */
export function parseVoiceModelAttachmentSnapshot(value: unknown): VoiceModelAttachmentSnapshot | undefined {
  if (!record(value) || !exactOwnKeys(value, ["schemaVersion", "opaqueBinding", "revision", "inputs"]) || value.schemaVersion !== 1
    || typeof value.opaqueBinding !== "string" || !/^[a-f0-9]{64}$/.test(value.opaqueBinding)
    || typeof value.revision !== "number" || !Number.isSafeInteger(value.revision) || value.revision <= 0
    || !record(value.inputs) || !exactOwnKeys(value.inputs, ["text", "image", "nativePdf"])
    || [value.inputs.text, value.inputs.image, value.inputs.nativePdf].some(flag => typeof flag !== "boolean")) return undefined;
  return { schemaVersion: 1, opaqueBinding: value.opaqueBinding, revision: value.revision,
    inputs: { text: value.inputs.text as boolean, image: value.inputs.image as boolean, nativePdf: value.inputs.nativePdf as boolean } };
}

/** Reader flags are user choices, not model capabilities or original-file grants. */
export function parseVoiceAttachmentReaders(value: unknown): VoiceAttachmentReaders {
  if (!record(value)) return { ...CLOSED_VOICE_ATTACHMENT_READERS };
  return Object.fromEntries(Object.keys(CLOSED_VOICE_ATTACHMENT_READERS).map(key => [key, own(value, key) && value[key] === true])) as unknown as VoiceAttachmentReaders;
}

export function availableVoiceAttachmentModes(
  snapshot: VoiceModelAttachmentSnapshot | undefined,
  expected: { opaqueBinding: string; revision: number } | undefined,
  readers: VoiceAttachmentReaders,
  transports: Readonly<VoiceAttachmentTransports> = CURRENT_VOICE_ATTACHMENT_TRANSPORTS,
): readonly VoiceAttachmentMode[] {
  // Revalidate even internally typed data, since cached settings arrive as JSON.
  const checked = parseVoiceModelAttachmentSnapshot(snapshot);
  if (!checked || !expected || checked.opaqueBinding !== expected.opaqueBinding || checked.revision !== expected.revision) return [];
  const flags = parseVoiceAttachmentReaders(readers);
  const modes: VoiceAttachmentMode[] = [];
  if (checked.inputs.text && transports.textEnvelope === true) {
    if (flags.text) modes.push("text");
    if (flags.extractedPdfText) modes.push("pdf-text");
    if (flags.extractedSpreadsheetText) modes.push("spreadsheet-text");
  }
  if (checked.inputs.image && flags.images && transports.imageInput === true) modes.push("image");
  if (checked.inputs.nativePdf && flags.nativePdf && transports.nativePdfInput === true) modes.push("native-pdf");
  return modes;
}

export type VoiceAttachmentModeRejection = "MODEL_UNCONFIRMED" | "READER_DISABLED" | "TRANSPORT_UNSUPPORTED";
export function voiceAttachmentModeRejection(mode: VoiceAttachmentMode,
  snapshot: VoiceModelAttachmentSnapshot | undefined,
  expected: { opaqueBinding: string; revision: number } | undefined,
  readers: VoiceAttachmentReaders,
  transports: Readonly<VoiceAttachmentTransports> = CURRENT_VOICE_ATTACHMENT_TRANSPORTS,
): VoiceAttachmentModeRejection | undefined {
  const checked = parseVoiceModelAttachmentSnapshot(snapshot);
  if (!checked || !expected || checked.opaqueBinding !== expected.opaqueBinding || checked.revision !== expected.revision) return "MODEL_UNCONFIRMED";
  const flag: keyof VoiceAttachmentReaders = mode === "pdf-text" ? "extractedPdfText" : mode === "spreadsheet-text" ? "extractedSpreadsheetText" : mode === "native-pdf" ? "nativePdf" : mode === "image" ? "images" : "text";
  const flags = parseVoiceAttachmentReaders(readers);
  if (!flags[flag]) return "READER_DISABLED";
  const input = mode === "native-pdf" ? checked.inputs.nativePdf : mode === "image" ? checked.inputs.image : checked.inputs.text;
  if (!input) return "MODEL_UNCONFIRMED";
  const transport = mode === "native-pdf" ? transports.nativePdfInput : mode === "image" ? transports.imageInput : transports.textEnvelope;
  return transport === true ? undefined : "TRANSPORT_UNSUPPORTED";
}
