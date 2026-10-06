import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
const attempts: string[] = []; let nativeCalls = 0;
globalThis.fetch = (async (...args: unknown[]) => { attempts.push(String(args[0])); throw new Error("Test network disabled"); }) as unknown as typeof fetch;
globalThis.XMLHttpRequest = class { constructor() { attempts.push("XMLHttpRequest"); throw new Error("Test network disabled"); } } as unknown as typeof XMLHttpRequest;
if (process.env.PDF_NATIVE === "missing") Object.defineProperty(globalThis, "DecompressionStream", { value: undefined, configurable: true });
else Object.defineProperty(globalThis, "DecompressionStream", { value: class { constructor() { nativeCalls++; throw new Error("Native decompression must not run"); } }, configurable: true });
const pdf = await import("pdfjs-dist/legacy/build/pdf.mjs");
const workerPath = new URL("../assets/document-extraction/pdfjs/pdf.worker.mjs", import.meta.url);
pdf.GlobalWorkerOptions.workerSrc = workerPath.href;
if (process.env.PDF_OLD_WORKER === "yes") { const upstreamWorker = "pdfjs-dist/legacy/build/pdf.worker.mjs"; await import(upstreamWorker); }
const instrumented = process.env.PDF_TEST_WORKER ? await import(process.env.PDF_TEST_WORKER) : undefined;
const budgetEvents: Record<string, unknown>[] = [];
if (instrumented) {
  const reserve = instrumented.VoicePdfDecodedBudget.prototype.reserve;
  instrumented.VoicePdfDecodedBudget.prototype.reserve = function(key: object, slot: string, capacity: number) {
    const before = this.used;
    try { const result = reserve.call(this, key, slot, capacity); if (this.used !== before) budgetEvents.push({ slot, capacity, before, after: this.used, limit: this.limit }); return result; }
    catch (cause) { budgetEvents.push({ slot, capacity, before, after: this.used, limit: this.limit, error: (cause as Error).message }); throw cause; }
  };
  const grow = instrumented.VoicePdfDecodedBudget.prototype.grow;
  instrumented.VoicePdfDecodedBudget.prototype.grow = function(key: object, requested: number, current: number) {
    const before = this.used;
    try { return grow.call(this, key, requested, current); }
    catch (cause) { budgetEvents.push({ slot: "buffer", requested, current, before, after: this.used, limit: this.limit, error: (cause as Error).message }); throw cause; }
  };
}
const { extractVoicePdfText } = await import("../src/voice-pdf-extraction");
const bytes = new Uint8Array(readFileSync(process.argv[2]!));
const inputSha256 = createHash("sha256").update(bytes).digest("hex");
const workerSha256 = createHash("sha256").update(readFileSync(workerPath)).digest("hex");
const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 20000);
const cancelTimer = process.env.PDF_CANCEL_HANDSHAKE === "yes" ? setTimeout(() => controller.abort(), 500) : undefined;
const started = performance.now();
let wrapperTerminations = 0;
if (process.env.PDF_WRAPPER === "yes") {
  const RealWorker = globalThis.Worker;
  globalThis.Worker = class extends RealWorker {
    constructor() { super(new URL("pdf-budget-port-worker.ts", import.meta.url)); }
    terminate() { wrapperTerminations++; return super.terminate(); }
  };
}
const port = process.env.PDF_PORT === "yes" ? new Worker(new URL("pdf-budget-port-worker.ts", import.meta.url)) : undefined;
const worker = port ? new pdf.PDFWorker({ port: port as never }) : undefined;
let portStats: unknown;
let result: Record<string, unknown>;
try {
  if (process.env.PDF_WRAPPER === "yes") {
    const { readVoiceDocumentAttachment } = await import("../src/voice-document-extraction");
    result = { content: (await readVoiceDocumentAttachment(new File([bytes], "synthetic.pdf"))).content, code: null };
  } else result = { content: await extractVoicePdfText(bytes, { signal: controller.signal, worker }), code: null };
}
catch (cause) { const error = cause as Error & { code?: string | number }; result = { code: typeof error.code === "string" ? error.code : error.name, rawCode: error.code, message: error.message }; }
finally { if (worker) { if (process.env.PDF_OLD_PORT !== "yes" && process.env.PDF_SILENT_PORT !== "yes") portStats = await worker.messageHandler.sendWithPromise("VoicePdfTestStats", {} as never); worker.destroy(); } port?.terminate(); clearTimeout(timer); clearTimeout(cancelTimer); }
console.log(JSON.stringify({ ...result, pid: process.pid, inputSha256, workerArtifactSha256: workerSha256, loadedWorkerSha256: process.env.PDF_TEST_WORKER ? createHash("sha256").update(readFileSync(process.env.PDF_TEST_WORKER)).digest("hex") : process.env.PDF_OLD_PORT === "yes" ? createHash("sha256").update(readFileSync(new URL("../node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs", import.meta.url))).digest("hex") : process.env.PDF_SILENT_PORT === "yes" ? null : workerSha256, workerMode: process.env.PDF_TEST_WORKER ? "instrumented" : process.env.PDF_OLD_PORT === "yes" ? "upstream-port" : process.env.PDF_SILENT_PORT === "yes" ? "silent-port" : "product", attempts, nativeMode: process.env.PDF_NATIVE === "missing" ? "absent" : "sentinel", nativeCalls, portStats, elapsedMs: performance.now() - started, wrapperTerminations, budgetEvents, unboundAllocations: instrumented?.voiceBudgetUnboundCount(), bun: Bun.version }));
