import { buildVoiceAttachmentText, readVoiceTextAttachment, VoiceAttachmentContentError, VOICE_TEXT_ATTACHMENT_POLICY, type VoiceAttachmentContentCode, type VoiceTextAttachment } from "./voice-attachment-content";
import { VOICE_DOCUMENT_LIMITS, hasVoicePdfHeader } from "./voice-document-policy";
export function voiceDocumentFormat(file: Pick<File, "name" | "type">): "text" | "pdf" | "xlsx" | "xls" {
  const mime = file.type.toLowerCase().split(";", 1)[0]!.trim(), extension = file.name.split(".").at(-1)?.toLowerCase();
  if (extension === "pdf" || extension === "xlsx" || extension === "xls") return extension;
  if (extension === "pdf" || mime === "application/pdf") return "pdf";
  if (extension === "xlsx" || mime === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") return "xlsx";
  if (extension === "xls" || mime === "application/vnd.ms-excel") return "xls";
  return "text";
}
const abort = (signal?: AbortSignal) => { if (signal?.aborted) throw new DOMException("Document preparation cancelled", "AbortError"); };
const documentCodes = new Set<VoiceAttachmentContentCode>(["VOICE_ATTACHMENT_DOCUMENT_INVALID", "VOICE_ATTACHMENT_DOCUMENT_LIMIT", "VOICE_ATTACHMENT_DOCUMENT_NO_TEXT", "VOICE_ATTACHMENT_DOCUMENT_ENCRYPTED"]);
export async function readVoiceDocumentAttachment(file: File, options: { signal?: AbortSignal } = {}): Promise<VoiceTextAttachment> {
  abort(options.signal);
  const format = voiceDocumentFormat(file);
  if (format === "text") return readVoiceTextAttachment(file, { ...VOICE_TEXT_ATTACHMENT_POLICY, signal: options.signal });
  // Reuse the name and envelope contract before allocating or reading bytes.
  buildVoiceAttachmentText("", [{ name: file.name, mimeType: file.type, content: "", byteLength: file.size }], VOICE_TEXT_ATTACHMENT_POLICY);
  if (!file.size) throw new VoiceAttachmentContentError("VOICE_ATTACHMENT_EMPTY");
  if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > VOICE_DOCUMENT_LIMITS.maxFileBytes) throw new VoiceAttachmentContentError("VOICE_ATTACHMENT_DOCUMENT_TOO_LARGE");
  let bytes: Uint8Array;
  try { bytes = new Uint8Array(await file.arrayBuffer()); }
  catch { abort(options.signal); throw new VoiceAttachmentContentError("VOICE_ATTACHMENT_READ_FAILED"); }
  abort(options.signal);
  if (bytes.byteLength !== file.size) throw new VoiceAttachmentContentError("VOICE_ATTACHMENT_READ_FAILED");
  if (format === "pdf" && !hasVoicePdfHeader(bytes)) throw new VoiceAttachmentContentError("VOICE_ATTACHMENT_DOCUMENT_INVALID");
  if (typeof Worker === "undefined") throw new VoiceAttachmentContentError("VOICE_ATTACHMENT_DOCUMENT_UNAVAILABLE");
  let port: Worker | undefined; let cleanup = () => {};
  const job = new AbortController();
  try {
    let rejectInterrupted!: (cause: unknown) => void;
    const interrupted = new Promise<never>((_, reject) => { rejectInterrupted = reject; });
    const onAbort = () => { rejectInterrupted(new DOMException("Document preparation cancelled", "AbortError")); job.abort(); port?.terminate(); };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => { rejectInterrupted(new VoiceAttachmentContentError("VOICE_ATTACHMENT_DOCUMENT_TIMEOUT")); job.abort(); port?.terminate(); }, VOICE_DOCUMENT_LIMITS.timeoutMs);
    cleanup = () => { job.abort(); clearTimeout(timer); options.signal?.removeEventListener("abort", onAbort); port?.terminate(); };
    const content = await Promise.race([interrupted, (async () => {
      if (format === "pdf") {
        const pdf = await import("pdfjs-dist/legacy/build/pdf.mjs"); abort(job.signal);
        port = new Worker(new URL("../assets/document-extraction/pdfjs/pdf.worker.mjs", import.meta.url), { type: "module" });
        const worker = new pdf.PDFWorker({ port: port as never }); // PDF.js's generated port type is erroneously null-only.
        try { const { extractVoicePdfText } = await import("./voice-pdf-extraction"); return await extractVoicePdfText(bytes, { worker, signal: job.signal }); }
        finally { worker.destroy(); }
      }
      port = new Worker(new URL("../assets/document-extraction/spreadsheet.worker.mjs", import.meta.url), { type: "module" });
      return await new Promise<string>((resolve, reject) => {
        port!.onerror = () => reject(new VoiceAttachmentContentError("VOICE_ATTACHMENT_DOCUMENT_UNAVAILABLE"));
        port!.onmessage = event => {
          const message = event.data;
          if (message && typeof message.content === "string") resolve(message.content);
          else reject(new VoiceAttachmentContentError(documentCodes.has(message?.code) ? message.code : "VOICE_ATTACHMENT_DOCUMENT_INVALID"));
        };
        port!.postMessage({ format, bytes }, [bytes.buffer]);
      });
    })()]);
    abort(options.signal);
    const result = { name: file.name, mimeType: file.type || (format === "pdf" ? "application/pdf" : format === "xls" ? "application/vnd.ms-excel" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"), byteLength: file.size, content };
    buildVoiceAttachmentText("", [result], VOICE_TEXT_ATTACHMENT_POLICY);
    return result;
  } catch (cause) {
    if (cause instanceof VoiceAttachmentContentError || cause instanceof DOMException && cause.name === "AbortError") throw cause;
    throw new VoiceAttachmentContentError("VOICE_ATTACHMENT_DOCUMENT_UNAVAILABLE");
  } finally { cleanup(); }
}
