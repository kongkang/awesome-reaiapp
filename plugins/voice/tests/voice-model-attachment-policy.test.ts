import { expect, test } from "bun:test";
import { availableVoiceAttachmentModes, parseVoiceAttachmentReaders, parseVoiceModelAttachmentSnapshot, voiceAttachmentModeRejection, type VoiceAttachmentReaders, type VoiceModelAttachmentSnapshot } from "../src/voice-model-attachment-policy";

const snapshot = (inputs = { text: true, image: false, nativePdf: false }): VoiceModelAttachmentSnapshot => ({ schemaVersion: 1, opaqueBinding: "a".repeat(64), revision: 2, inputs });
const all: VoiceAttachmentReaders = { text: true, extractedPdfText: true, extractedSpreadsheetText: true, images: true, nativePdf: true };
test("text model permits enabled extracted PDF/Excel text without native PDF or fictional Excel tag", () => {
  const s = snapshot();
  expect(availableVoiceAttachmentModes(s, s, all)).toEqual(["text", "pdf-text", "spreadsheet-text"]);
  expect(voiceAttachmentModeRejection("pdf-text", s, s, all)).toBeUndefined();
  expect(voiceAttachmentModeRejection("spreadsheet-text", s, s, all)).toBeUndefined();
});
test("confirmed no inputs or uninitialized bindings hide plus because no modes remain", () => {
  const s = snapshot({ text: false, image: false, nativePdf: false });
  expect(availableVoiceAttachmentModes(s, s, all)).toEqual([]);
  expect(availableVoiceAttachmentModes(undefined, undefined, all)).toEqual([]);
});
test("vision/PDF alone cannot be substituted for text or unsupported Agent transport", () => {
  const s = snapshot({ text: false, image: true, nativePdf: true });
  expect(availableVoiceAttachmentModes(s, s, all)).toEqual([]);
  expect(voiceAttachmentModeRejection("image", s, s, all)).toBe("TRANSPORT_UNSUPPORTED");
  expect(voiceAttachmentModeRejection("native-pdf", s, s, all)).toBe("TRANSPORT_UNSUPPORTED");
  expect(voiceAttachmentModeRejection("pdf-text", s, s, all)).toBe("MODEL_UNCONFIRMED");
});
test("native modes have separate positive contracts and must not silently disappear from future transports", () => {
  const s = snapshot({ text: false, image: true, nativePdf: true });
  const transports = { textEnvelope: false, imageInput: true, nativePdfInput: true };
  expect(availableVoiceAttachmentModes(s, s, all, transports)).toEqual(["image", "native-pdf"]);
  expect(voiceAttachmentModeRejection("image", s, s, all, transports)).toBeUndefined();
});
test("reader choices can disable individual formats despite confirmed model support", () => {
  const s = snapshot(); const readers = { ...all, extractedPdfText: false, extractedSpreadsheetText: false };
  expect(availableVoiceAttachmentModes(s, s, readers)).toEqual(["text"]);
  expect(voiceAttachmentModeRejection("pdf-text", s, s, readers)).toBe("READER_DISABLED");
  expect(availableVoiceAttachmentModes(s, s, parseVoiceAttachmentReaders({}))).toEqual([]);
});
test("stale opaque binding or revision rejects prepared cards after model/account/settings change", () => {
  const s = snapshot();
  for (const expected of [{ opaqueBinding: "b".repeat(64), revision: 2 }, { opaqueBinding: s.opaqueBinding, revision: 3 }]) {
    expect(availableVoiceAttachmentModes(s, expected, all)).toEqual([]);
    expect(voiceAttachmentModeRejection("text", s, expected, all)).toBe("MODEL_UNCONFIRMED");
  }
});
test("strict snapshots reject corrupt partial and spoofed capability data", () => {
  const s = snapshot();
  for (const bad of [null, [], {}, { ...s, revision: 0 }, { ...s, revision: Number.MAX_SAFE_INTEGER + 1 }, { ...s, opaqueBinding: "model-name" }, { ...s, provider: "fixture" }, { ...s, schemaVersion: 2 }, { ...s, inputs: { text: 1, image: false, nativePdf: false } }, { ...s, inputs: { ...s.inputs, fileTools: true } }, Object.create(s)]) {
    expect(parseVoiceModelAttachmentSnapshot(bad)).toBeUndefined();
  }
});
test("normalization copies data and never infers enabled readers from truthy or inherited flags", () => {
  expect(parseVoiceAttachmentReaders(Object.create(all))).toEqual({ text: false, extractedPdfText: false, extractedSpreadsheetText: false, images: false, nativePdf: false });
  expect(parseVoiceAttachmentReaders({ text: "true", images: 1, extractedPdfText: true })).toEqual({ text: false, extractedPdfText: true, extractedSpreadsheetText: false, images: false, nativePdf: false });
  const input = snapshot(); const parsed = parseVoiceModelAttachmentSnapshot(input)!; input.inputs.text = false;
  expect(parsed.inputs.text).toBe(true);
});
