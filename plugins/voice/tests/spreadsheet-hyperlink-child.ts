import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { extractVoiceSpreadsheet, validateVoiceSpreadsheetZip } from "../src/voice-spreadsheet-extraction";
import { observeHyperlinkStubs } from "./spreadsheet-hyperlink-observer";
const path = process.argv[2]!;
const mode = process.argv[3] ?? "direct";
const bytes = new Uint8Array(readFileSync(path));
const hash = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
let networkAttempts = 0;
globalThis.fetch = (async () => { networkAttempts++; throw new Error("Hyperlink fixture network access is disabled"); }) as unknown as typeof fetch;
validateVoiceSpreadsheetZip(bytes);
let result: Record<string, unknown>;
if (mode === "worker") {
  const asset = new URL("../assets/document-extraction/spreadsheet.worker.mjs", import.meta.url);
  const assetSha256 = hash(new Uint8Array(readFileSync(asset)));
  const worker = new Worker(new URL("./spreadsheet-hyperlink-observed-worker.ts", import.meta.url));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    result = await new Promise<Record<string, unknown>>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Observed spreadsheet Worker timed out")), 5000);
      worker.onerror = event => reject(new Error(`Observed spreadsheet Worker failed: ${event.message}`));
      worker.onmessage = event => {
        if (event.data?.ready) worker.postMessage({ format: "xlsx", bytes });
        else resolve(event.data);
      };
    });
    if (hash(new Uint8Array(readFileSync(asset))) !== assetSha256) throw new Error("Product Worker changed during extraction");
    result.assetSha256 = assetSha256;
  } finally { clearTimeout(timer); worker.terminate(); }
} else {
  const observer = observeHyperlinkStubs();
  try { result = { content: extractVoiceSpreadsheet(bytes, "xlsx"), code: null }; }
  catch (cause) { result = { code: (cause as { code?: string }).code ?? null, errorName: (cause as Error).name, message: (cause as Error).message }; }
  finally { result!.stubAssignments = observer.assignments; observer.cleanup(); }
}
console.log(JSON.stringify({ runtime: `Bun ${Bun.version}`, childPid: process.pid, mode, inputBytes: bytes.length, inputSha256: hash(bytes), networkAttempts, productExtractor: true, browserOrSignedApp: false, result }));
