import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import * as XLSX from "xlsx";
import { zipSync, strToU8, unzipSync, strFromU8 } from "fflate";
import { extractVoiceSpreadsheet, validateVoiceSpreadsheetZip } from "../src/voice-spreadsheet-extraction";
import { voiceDocumentFormat, readVoiceDocumentAttachment } from "../src/voice-document-extraction";
import { extractVoicePdfText } from "../src/voice-pdf-extraction";
const book = () => {
  const sheet = XLSX.utils.aoa_to_sheet([["SYNTHETIC_SHEET_MARKER", 7, "中文"], ["formula", 2]]);
  sheet.B2.f = "1+1";
  sheet.B2.v = 9001; // Deliberately differs from evaluating 1+1.
  sheet.A3 = { t: "n", v: 46200, z: "yyyy-mm-dd" };
  sheet["!ref"] = "A1:C3";
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, sheet, "Synthetic");
  return wb;
};
for (const format of ["xlsx", "xls"] as const) test(`${format}: sheet names/cell coordinates/values/formulas survive without evaluation`, () => {
  const bytes = new Uint8Array(XLSX.write(book(), { type: "array", bookType: format === "xls" ? "biff8" : "xlsx" }));
  const content = extractVoiceSpreadsheet(bytes, format);
  expect(content).toContain("SYNTHETIC_SHEET_MARKER");
  expect(content).toContain('"name":"Synthetic"');
  expect(content).toContain('"address":"B2"');
  if (format === "xlsx") expect(content).toContain('"formula":"1+1"');
  expect(content).toContain('"value":9001');
  const date = JSON.parse(content).sheets[0].cells.find((cell: { address: string }) => cell.address === "A3");
  expect(date.numberFormat).toBe("yyyy-mm-dd");
  expect(date.formatted).toMatch(/^\d{4}-\d{2}-\d{2}$/);
});
test("format dispatch accepts PDF/XLSX/XLS MIME or extension and keeps ordinary text route", () => {
  for (const [name, mime, result] of [["synthetic.pdf", "", "pdf"], ["synthetic.xlsx", "", "xlsx"], ["synthetic.xls", "", "xls"], ["opaque", "application/pdf", "pdf"], ["synthetic.txt", "text/plain", "text"]] as const)
    expect(voiceDocumentFormat({ name, type: mime } as File)).toBe(result);
  expect(voiceDocumentFormat({ name: "synthetic.xlsx", type: "application/pdf" })).toBe("xlsx");
  expect(voiceDocumentFormat({ name: "synthetic.xls", type: "application/pdf" })).toBe("xls");
  expect(voiceDocumentFormat({ name: "synthetic.pdf", type: "application/vnd.ms-excel" })).toBe("pdf");
});
test("prepared spreadsheet worker matches the current source graph", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "voice-document-worker-test-"));
  try {
    // A child build has no Bun test-runner module mocks; use the package's exact compiler flags.
    const bundle = join(scratch, "spreadsheet.worker.mjs");
    const proc = Bun.spawn([process.execPath, "build", "src/voice-document-worker.ts", "--outfile", bundle, "--target", "browser", "--format", "esm", "--minify"], { cwd: `${import.meta.dir}/..`, stdout: "pipe", stderr: "pipe" });
    const [exitCode] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    expect(exitCode).toBe(0);
    const hash = (bytes: ArrayBuffer) => createHash("sha256").update(new Uint8Array(bytes)).digest("hex");
    expect(hash(await Bun.file(bundle).arrayBuffer())).toBe(hash(await Bun.file(`${import.meta.dir}/../assets/document-extraction/spreadsheet.worker.mjs`).arrayBuffer()));
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});
test("XLSX invalid/encrypted/oversize expansion fails explicitly before SheetJS", () => {
  expect(() => validateVoiceSpreadsheetZip(new Uint8Array([80,75,3,4]))).toThrow("VOICE_ATTACHMENT_DOCUMENT_INVALID");
  const inflated = zipSync({ "xl/worksheets/sheet1.xml": strToU8("a".repeat(100000)) });
  expect(() => validateVoiceSpreadsheetZip(inflated, { maxInflatedBytes: 1000 })).toThrow("VOICE_ATTACHMENT_DOCUMENT_LIMIT");
  const bytes = new Uint8Array(XLSX.write(book(), { type: "array", bookType: "xlsx" }));
  const encrypted = bytes.slice(); const view = new DataView(encrypted.buffer);
  for (let index = 0; index < encrypted.length - 4; index++) if (view.getUint32(index, true) === 0x02014b50) { view.setUint16(index + 8, view.getUint16(index + 8, true) | 1, true); break; }
  expect(() => validateVoiceSpreadsheetZip(encrypted)).toThrow("VOICE_ATTACHMENT_DOCUMENT_ENCRYPTED");
  const badCrc = bytes.slice(); const badView = new DataView(badCrc.buffer);
  for (let index = 0; index < badCrc.length - 4; index++) if (badView.getUint32(index, true) === 0x02014b50) { badView.setUint32(index + 16, badView.getUint32(index + 16, true) ^ 1, true); break; }
  expect(() => validateVoiceSpreadsheetZip(badCrc)).toThrow("VOICE_ATTACHMENT_DOCUMENT_INVALID");
  const badLocalSize = bytes.slice(); const localView = new DataView(badLocalSize.buffer);
  localView.setUint32(22, 0x7fffffff, true);
  expect(() => validateVoiceSpreadsheetZip(badLocalSize)).toThrow("VOICE_ATTACHMENT_DOCUMENT_INVALID");
});

for (const format of ["xlsx", "xls"] as const) test(`${format} actual worker returns prepared contents for existing text turn`, async () => {
  const bytes = new Uint8Array(XLSX.write(book(), { type: "array", bookType: format === "xls" ? "biff8" : "xlsx" }));
  const result = await readVoiceDocumentAttachment(new File([bytes], `synthetic.${format}`));
  expect(result.content).toContain("SYNTHETIC_SHEET_MARKER");
  expect(result.byteLength).toBe(bytes.byteLength);
  expect(result.name).toBe(`synthetic.${format}`);
});
test("too many spreadsheet cells are rejected, never silently omitted", () => {
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(Array.from({ length: 1001 }, (_, i) => [i])), "Synthetic");
  expect(() => extractVoiceSpreadsheet(new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" })), "xlsx")).toThrow("VOICE_ATTACHMENT_DOCUMENT_LIMIT");
});
test("an understated XLSX dimension cannot hide an out-of-budget cell", () => {
  const sheet = XLSX.utils.aoa_to_sheet([["SYNTHETIC_FIRST_ROW"]]);
  XLSX.utils.sheet_add_aoa(sheet, [["SYNTHETIC_HIDDEN_ROW"]], { origin: "A1002" });
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, sheet, "Synthetic");
  const entries = unzipSync(new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" })));
  const xml = strFromU8(entries["xl/worksheets/sheet1.xml"]!);
  entries["xl/worksheets/sheet1.xml"] = strToU8(xml.replace(/<dimension[^>]*\/>/, '<dimension ref="A1:A1"/>'));
  expect(() => extractVoiceSpreadsheet(zipSync(entries), "xlsx")).toThrow("VOICE_ATTACHMENT_DOCUMENT_LIMIT");
});
test("empty spreadsheet has no fabricated attachment text", () => {
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([]), "Synthetic");
  expect(() => extractVoiceSpreadsheet(new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" })), "xlsx")).toThrow("VOICE_ATTACHMENT_DOCUMENT_NO_TEXT");
});
test("document size and cancellation fail before parsing or worker creation", async () => {
  let reads = 0;
  const file = { name: "synthetic.pdf", type: "application/pdf", size: 5 * 1024 * 1024 + 1, async arrayBuffer() { reads++; return new ArrayBuffer(0); } } as File;
  await expect(readVoiceDocumentAttachment(file)).rejects.toMatchObject({ code: "VOICE_ATTACHMENT_DOCUMENT_TOO_LARGE" });
  expect(reads).toBe(0);
  const controller = new AbortController(); controller.abort();
  await expect(readVoiceDocumentAttachment(file, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
});

/** Complete small PDF, including an inert OpenAction payload for the no-execution assertion. */
function pdfFixture(text: string, pageCount = 1): Uint8Array {
  const stream = text ? `BT /F1 12 Tf 72 720 Td (${text}) Tj ET` : "";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R /OpenAction 6 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /S /JavaScript /JS (globalThis.SYNTHETIC_PDF_EXECUTED = true) >>",
  ];
  for (let index = 1; index < pageCount; index++) objects.push(objects[2]!);
  objects[1] = `<< /Type /Pages /Kids [3 0 R ${Array.from({ length: pageCount - 1 }, (_, index) => `${index + 7} 0 R`).join(" ")}] /Count ${pageCount} >>`;
  let body = "%PDF-1.4\n"; const offsets = [0];
  objects.forEach((object, index) => { offsets.push(body.length); body += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = body.length;
  body += `xref\n0 ${offsets.length}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(body);
}
test("PDF parser extracts text layer; document JavaScript is inert", async () => {
  const content = await extractVoicePdfText(pdfFixture("SYNTHETIC_PDF_MARKER"), { assetRoot: `${import.meta.dir}/../assets/document-extraction/pdfjs/` });
  expect(content).toContain("SYNTHETIC_PDF_MARKER");
  expect(content).toContain('"page":1');
  expect((globalThis as any).SYNTHETIC_PDF_EXECUTED).toBeUndefined();
});
test("PDF page budget rejects the whole document instead of truncating pages", async () => {
  await expect(extractVoicePdfText(pdfFixture("synthetic", 101))).rejects.toMatchObject({ code: "VOICE_ATTACHMENT_DOCUMENT_LIMIT" });
});
test("PDF with no text layer explicitly reports unavailable text, not an empty successful attachment", async () => {
  await expect(extractVoicePdfText(pdfFixture(""))).rejects.toMatchObject({ code: "VOICE_ATTACHMENT_DOCUMENT_NO_TEXT" });
});
test("PDF text-layer parsing tolerates a bounded transfer prefix", async () => {
  const pdf = pdfFixture("SYNTHETIC_PREFIXED_PDF_MARKER");
  const prefix = new TextEncoder().encode("synthetic transfer prefix\n");
  const bytes = new Uint8Array(prefix.length + pdf.length); bytes.set(prefix); bytes.set(pdf, prefix.length);
  expect(await extractVoicePdfText(bytes, { assetRoot: `${import.meta.dir}/../assets/document-extraction/pdfjs/` })).toContain("SYNTHETIC_PREFIXED_PDF_MARKER");
});

for (const interrupted of ["cancel", "timeout"] as const) test(`document worker ${interrupted} terminates its own worker and ignores late results`, async () => {
  const original = globalThis.Worker;
  let instance!: { terminated: number; onmessage: ((event: MessageEvent) => void) | null };
  let timerCallback!: () => void;
  const realTimer = globalThis.setTimeout;
  const timer = spyOn(globalThis, "setTimeout").mockImplementation(((handler: () => void, delay?: number, ...args: unknown[]) => { if (delay === 20000) timerCallback = handler; return realTimer(handler, delay, ...args); }) as typeof setTimeout);
  class SyntheticWorker {
    terminated = 0; onmessage: ((event: MessageEvent) => void) | null = null; onerror = null;
    constructor() { instance = this; }
    postMessage() {}
    terminate() { this.terminated++; }
  }
  globalThis.Worker = SyntheticWorker as unknown as typeof Worker;
  try {
    const controller = new AbortController();
    const pending = readVoiceDocumentAttachment(new File(["synthetic"], "synthetic.xlsx"), { signal: controller.signal });
    // Native promise observation does not block before we deliver cancellation.
    const observed = pending.then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
    for (let tries = 0; !instance && tries < 10; tries++) await new Promise(resolve => realTimer(resolve, 0));
    expect(instance).toBeDefined();
    if (interrupted === "cancel") controller.abort(); else timerCallback();
    expect((await observed).error).toMatchObject(interrupted === "cancel" ? { name: "AbortError" } : { code: "VOICE_ATTACHMENT_DOCUMENT_TIMEOUT" });
    expect(instance.terminated).toBeGreaterThan(0);
    instance.onmessage?.({ data: { content: "SYNTHETIC_LATE_RESULT" } } as MessageEvent);
  } finally { globalThis.Worker = original; timer.mockRestore(); }
});
test("malformed PDF fails before becoming ready", async () => {
  await expect(readVoiceDocumentAttachment(new File(["%PDF-invalid"], "damaged.pdf", { type: "application/pdf" }))).rejects.toMatchObject({ code: "VOICE_ATTACHMENT_DOCUMENT_INVALID" });
});
