import { VoiceAttachmentContentError, VOICE_ATTACHMENT_MAX_CHARACTERS, VOICE_TEXT_ATTACHMENT_POLICY } from "./voice-attachment-content";
import { VOICE_DOCUMENT_LIMITS, hasVoicePdfHeader } from "./voice-document-policy";
import type { PDFWorker } from "pdfjs-dist";
const fail = (code: "VOICE_ATTACHMENT_DOCUMENT_INVALID" | "VOICE_ATTACHMENT_DOCUMENT_LIMIT" | "VOICE_ATTACHMENT_DOCUMENT_NO_TEXT" | "VOICE_ATTACHMENT_DOCUMENT_ENCRYPTED" | "VOICE_ATTACHMENT_DOCUMENT_UNAVAILABLE"): never => { throw new VoiceAttachmentContentError(code); };
const decodedBudgetMarker = "VOICE_PDF_DECODE_BUDGET_EXCEEDED";
const decodedBudgetPolicy = `voice-pdf-decoded-capacity-v1:${VOICE_DOCUMENT_LIMITS.maxPdfDecodedBytes}`;
const abort = (signal?: AbortSignal) => { if (signal?.aborted) throw new DOMException("Document preparation cancelled", "AbortError"); };
/** Public PDF.js parsing API only: no viewer, scripting manager, rendering, URL or embedded-file execution. */
export async function extractVoicePdfText(bytes: Uint8Array, options: { worker?: PDFWorker; signal?: AbortSignal; assetRoot?: string } = {}): Promise<string> {
  if (!hasVoicePdfHeader(bytes)) fail("VOICE_ATTACHMENT_DOCUMENT_INVALID");
  abort(options.signal);
  const pdf = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const assetRoot = options.assetRoot ?? new URL("../assets/document-extraction/pdfjs/", import.meta.url).href;
  pdf.GlobalWorkerOptions.workerSrc = new URL("../assets/document-extraction/pdfjs/pdf.worker.mjs", import.meta.url).href;
  const worker = options.worker ?? new pdf.PDFWorker();
  let rejectHandshake!: (cause: unknown) => void;
  const handshakeStopped = new Promise<never>((_, reject) => { rejectHandshake = reject; });
  const handshakeAbort = () => rejectHandshake(new DOMException("Document preparation cancelled", "AbortError"));
  const handshakeError = (event: ErrorEvent) => { event.preventDefault(); rejectHandshake(new VoiceAttachmentContentError("VOICE_ATTACHMENT_DOCUMENT_UNAVAILABLE")); };
  let observedPort: Worker | undefined;
  const watchPort = () => {
    // PDF.js's LoopbackPort ignores the event name; only real Workers can carry an error listener.
    if (typeof Worker !== "undefined" && worker.port instanceof Worker && worker.port !== observedPort) {
      observedPort?.removeEventListener("error", handshakeError);
      observedPort = worker.port; observedPort.addEventListener("error", handshakeError);
    }
  };
  options.signal?.addEventListener("abort", handshakeAbort, { once: true });
  watchPort();
  try {
    await Promise.race([handshakeStopped, (async () => {
      abort(options.signal); await worker.promise; watchPort(); abort(options.signal);
      const fakeHandler = (globalThis as typeof globalThis & { pdfjsWorker?: { WorkerMessageHandler?: { voicePdfDecodedBudgetPolicy?: string } } }).pdfjsWorker?.WorkerMessageHandler;
      if (!options.worker && fakeHandler && fakeHandler.voicePdfDecodedBudgetPolicy !== decodedBudgetPolicy) fail("VOICE_ATTACHMENT_DOCUMENT_UNAVAILABLE");
      if (await worker.messageHandler.sendWithPromise("VoicePdfDecodedBudgetPolicy", {} as never) !== decodedBudgetPolicy) fail("VOICE_ATTACHMENT_DOCUMENT_UNAVAILABLE");
      abort(options.signal);
    })()]);
  } catch (cause) {
    if (!options.worker) worker.destroy();
    if (cause instanceof DOMException && cause.name === "AbortError") throw cause;
    return fail("VOICE_ATTACHMENT_DOCUMENT_UNAVAILABLE");
  } finally { options.signal?.removeEventListener("abort", handshakeAbort); observedPort?.removeEventListener("error", handshakeError); }
  const task = pdf.getDocument({ data: bytes, worker, stopAtErrors: true, enableXfa: false, disableFontFace: true, useSystemFonts: false, useWorkerFetch: false, cMapUrl: `${assetRoot}cmaps/`, cMapPacked: true, standardFontDataUrl: `${assetRoot}standard_fonts/`, maxImageSize: 0 });
  // Reject rather than leaving an unsupported password prompt or a hanging task.
  let rejectPassword!: (cause: unknown) => void;
  const password = new Promise<never>((_, reject) => { rejectPassword = reject; });
  task.onPassword = () => rejectPassword(new VoiceAttachmentContentError("VOICE_ATTACHMENT_DOCUMENT_ENCRYPTED"));
  const cancel = () => { void task.destroy().catch(() => {}); };
  options.signal?.addEventListener("abort", cancel, { once: true });
  try {
    const doc = await Promise.race([task.promise, password]);
    abort(options.signal);
    if (doc.numPages > VOICE_DOCUMENT_LIMITS.maxPages) fail("VOICE_ATTACHMENT_DOCUMENT_LIMIT");
    let characters = 0, textBytes = 0; const pages: { page: number; text: string }[] = [];
    for (let index = 1; index <= doc.numPages; index++) {
      abort(options.signal); const page = await doc.getPage(index);
      const reader = page.streamTextContent().getReader(); const chunks: string[] = [];
      try {
        while (true) {
          abort(options.signal); const chunk = await reader.read(); if (chunk.done) break;
          for (const item of chunk.value.items) {
            if (!("str" in item)) continue;
            const text = item.str + (item.hasEOL ? "\n" : " ");
            characters += text.length; textBytes += new TextEncoder().encode(text).byteLength;
            if (characters > VOICE_ATTACHMENT_MAX_CHARACTERS || textBytes > VOICE_TEXT_ATTACHMENT_POLICY.maxTurnBytes) fail("VOICE_ATTACHMENT_DOCUMENT_LIMIT");
            chunks.push(text);
          }
        }
      } finally { void reader.cancel().catch(() => {}); page.cleanup(); }
      pages.push({ page: index, text: chunks.join("").trim() });
    }
    if (!pages.some(page => page.text.trim())) fail("VOICE_ATTACHMENT_DOCUMENT_NO_TEXT");
    return JSON.stringify({ format: "pdf", pages, note: "Extracted text layer only. Page layout may differ; images were not OCRed. Scripts and document actions were not executed." });
  } catch (cause) {
    abort(options.signal);
    if (cause instanceof VoiceAttachmentContentError || cause instanceof DOMException && cause.name === "AbortError") throw cause;
    if (cause instanceof Error && cause.message === decodedBudgetMarker) fail("VOICE_ATTACHMENT_DOCUMENT_LIMIT");
    return fail("VOICE_ATTACHMENT_DOCUMENT_INVALID");
  } finally { options.signal?.removeEventListener("abort", cancel); void task.destroy().catch(() => {}).finally(() => { if (!options.worker) worker.destroy(); }); }
}
