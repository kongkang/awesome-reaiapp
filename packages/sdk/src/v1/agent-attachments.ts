/** Optional, descriptor-gated Agent attachment input v1. No original paths or URLs. */
export type AgentAttachmentMode = "text" | "pdf-text" | "spreadsheet-text" | "image";
export interface AgentAttachmentSnapshot {
  schemaVersion: 1;
  opaqueBinding: string;
  revision: number;
  inputs: { text: boolean; image: boolean; nativePdf: boolean };
}
export interface AgentAttachmentReaders {
  text: boolean; extractedPdfText: boolean; extractedSpreadsheetText: boolean; images: boolean; nativePdf: false;
}
export type AgentAttachmentAdmission = {
  schemaVersion: 1; state: "ready"; snapshot: AgentAttachmentSnapshot;
  readers: AgentAttachmentReaders;
  transports: { textEnvelope: boolean; imageInput: boolean; nativePdfInput: false };
} | {
  schemaVersion: 1; state: "not-initialized" | "loading" | "unavailable" | "corrupt" | "binding-changed";
  errorCode: string;
};
export interface AgentAttachmentTurnAdmission {
  schemaVersion: 1; opaqueBinding: string; revision: number; modes: AgentAttachmentMode[];
}
export type AgentAttachmentPart = {
  kind: "text"; mode: "text" | "pdf-text" | "spreadsheet-text";
  name: string; mimeType: string; text: string;
} | {
  kind: "image"; name: string; mimeType: "image/png" | "image/jpeg";
  leaseId: string; sha256: string; byteLength: number;
};
export interface AgentAttachmentTurnInput {
  schemaVersion: 1; admission: AgentAttachmentTurnAdmission; parts: AgentAttachmentPart[];
}
export interface AgentAttachmentUploadOwner {
  schemaVersion: 1; sessionId: string; admission: AgentAttachmentTurnAdmission;
}
/** Short-lived Host-owned bytes; no original path or public URL is returned. */
export interface AgentAttachmentUploads {
  start(options: AgentAttachmentUploadOwner & {
    name: string; mimeType: "image/png" | "image/jpeg"; byteLength: number; sha256: string;
  }): Promise<{ schemaVersion: 1; leaseId: string; chunkBytes: number }>;
  chunk(options: AgentAttachmentUploadOwner & { leaseId: string; index: number; base64: string }): Promise<{ schemaVersion: 1; ok: true }>;
  finish(options: AgentAttachmentUploadOwner & { leaseId: string }): Promise<{
    schemaVersion: 1; part: Extract<AgentAttachmentPart, { kind: "image" }>;
  }>;
  cancel(options: AgentAttachmentUploadOwner & { leaseId: string }): Promise<{ schemaVersion: 1; ok: true }>;
}
