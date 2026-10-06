import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { spawn, execFileSync } from "node:child_process";
import { invalidCfbFixtures } from "./fixtures/voice-integration-cfb-controls";
import * as XLSX from "xlsx";
import { zipSync, unzipSync, strToU8 } from "fflate";
import { readVoiceDocumentAttachment } from "../src/voice-document-extraction";
import { extractVoiceSpreadsheet } from "../src/voice-spreadsheet-extraction";
const invalid = "VOICE_ATTACHMENT_DOCUMENT_INVALID", limit = "VOICE_ATTACHMENT_DOCUMENT_LIMIT";
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`fixtures/integration-final/${name}`, import.meta.url)));
const read = (bytes: Uint8Array, name = "input.xlsx") => readVoiceDocumentAttachment(new File([bytes], name));
for (const [marker, sha] of [
  ["normal", "afa333fd3bad7650daa4390291b2698e43ca32b011ee5322d3b29e1a22724166"],
  ["invalidMarker", "e18eb2cf6ff40058b30ffa856d77f6fbd12bf62ede0bca0068bbd27f3c2a93f3"],
  ["passwordMarker", "f77171ddcd57246685e5637ec931fecd19ad397ac8d8f46ac798e60f94309b0a"],
  ["encryptMarker", "023503a2b0435ef65ba67752743eca46d240329aa30ba7245913bb56e054285b"],
] as const) test(`combined product classifies fixed ${marker} without false encryption`, async () => {
  const bytes = fixture(`xlsx-${marker}.xlsx`); expect(hash(bytes)).toBe(sha);
  if (marker === "normal") expect((await read(bytes)).content).toContain("SYNTHETIC_CONTROL");
  else await expect(read(bytes)).rejects.toMatchObject({ code: invalid });
});

test("combined generated Worker rejects hyperlink expansion before stub assignments", async () => {
  const bytes = fixture("hyperlink-range-1001.xlsx"); expect(bytes.length).toBe(15911);
  const worker = new Worker(new URL("voice-integration-observed-worker.ts", import.meta.url));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await new Promise<any>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Observed product Worker did not return")), 5000);
      worker.onerror = event => reject(new Error(event.message));
      worker.onmessage = event => { if (event.data?.ready) worker.postMessage({ format: "xlsx", bytes }); else resolve(event.data); };
    });
    console.log("INTEGRATION_HYPERLINK", JSON.stringify(result));
    expect(result.code).toBe(limit); expect(result.stubAssignments).toBe(0); expect(result.networkAttempts).toBe(0);
  } finally { clearTimeout(timer); worker.terminate(); }
});

const cfbGuard = new URL("../src/voice-cfb-chains.ts", import.meta.url);
// The old cyclic parser is never a baseline test. Confirm pure rejection before calling the final product.
test.skipIf(!existsSync(cfbGuard))("combined XLS rejects the bounded CFB cycle through the real product Worker", async () => {
  const { validateVoiceCfbChains } = await import(cfbGuard.href);
  for (const fixture of invalidCfbFixtures()) expect(() => validateVoiceCfbChains(fixture.bytes)).toThrow(invalid);
  const child = spawn(process.execPath, [new URL("voice-integration-cfb-child.ts", import.meta.url).pathname], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "", killReason: string | null = null; const samples: number[] = [];
  child.stdout.on("data", data => { stdout += data; }); child.stderr.on("data", data => { stderr += data; });
  const stop = (reason: string) => { if (killReason) return; killReason = reason; try { process.kill(-child.pid!, "SIGKILL"); } catch {} };
  const timer = setTimeout(() => stop("deadline"), 3000);
  const sample = setInterval(() => {
    try { const rss = Number(execFileSync("ps", ["-o", "rss=", "-p", String(child.pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()); samples.push(rss); if (rss > 256 * 1024) stop("rss-watchdog"); } catch {}
  }, 20);
  try {
    const exit = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    console.log("INTEGRATION_CFB", JSON.stringify({ childPid: child.pid, exit, killReason, samples, stdout, stderr }));
    expect(killReason).toBeNull(); expect(exit).toBe(0); expect(JSON.parse(stdout.trim().split("\n").at(-1)!).code).toBe(invalid);
  } finally { clearTimeout(timer); clearInterval(sample); }
}, 5000);

test("combined rejection paths retain ordinary XLS/XLSX values and inert formulas", async () => {
  const sheet = XLSX.utils.aoa_to_sheet([["SYNTHETIC_INTEGRATION", 9001]]); sheet.B1!.f = "1+1";
  const book = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book, sheet, "Control");
  for (const format of ["xlsx", "xls"] as const) {
    const bytes = new Uint8Array(XLSX.write(book, { type: "array", bookType: format === "xls" ? "biff8" : "xlsx" }));
    const output = JSON.parse((await read(bytes, `control.${format}`)).content);
    expect(output.sheets[0].cells.find((cell: any) => cell.address === "B1").value).toBe(9001);
  }
});

test("combined format, CRC and encryption guards coexist with XML error classification", async () => {
  const normal = fixture("xlsx-normal.xlsx");
  for (const extra of ["objectdata.xml", "Index/Document.iwa"]) {
    const entries = unzipSync(normal); entries[extra] = strToU8("SYNTHETIC_ALTERNATE_FORMAT");
    await expect(read(zipSync(entries))).rejects.toMatchObject({ code: invalid });
  }
  const encrypted = normal.slice(), corrupt = normal.slice();
  for (const [bytes, code] of [[encrypted, "VOICE_ATTACHMENT_DOCUMENT_ENCRYPTED"], [corrupt, invalid]] as const) {
    const view = new DataView(bytes.buffer);
    for (let at = 0; at < bytes.length - 4; at++) if (view.getUint32(at, true) === 0x02014b50) {
      if (bytes === encrypted) view.setUint16(at + 8, view.getUint16(at + 8, true) | 1, true);
      else view.setUint32(at + 16, view.getUint32(at + 16, true) ^ 1, true);
      break;
    }
    await expect(read(bytes)).rejects.toMatchObject({ code });
  }
  expect((await read(fixture("xlsx-normal.xlsx"))).content).toContain("SYNTHETIC_CONTROL");
});

test("combined document routing retains UTF-8 BOM CSV", async () => {
  expect((await read(new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("synthetic,7")]), "control.csv")).content).toBe("synthetic,7");
});

test("combined spreadsheet changes preserve the real PDF Worker decoded budget", async () => {
  for (const name of ["ordinary.pdf", "high-whitespace-18mib.pdf"]) {
    const path = new URL(`fixtures/pdf-decoded-budget/${name}`, import.meta.url).pathname;
    const child = Bun.spawn([process.execPath, new URL("pdf-decoded-budget-child.ts", import.meta.url).pathname, path], { env: { ...process.env, PDF_PORT: "yes" }, stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill(), 25000);
    try {
      const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(exit).toBe(0); const result = JSON.parse(stdout.trim().split("\n").at(-1)!);
      expect(result.attempts).toEqual([]); expect(result.nativeCalls).toBe(0); expect(result.portStats).toEqual({ attempts: [], nativeCalls: 0 });
      expect(result.code).toBe(name === "ordinary.pdf" ? null : limit);
      console.log("INTEGRATION_PDF", JSON.stringify({ name, inputSha256: result.inputSha256, workerSha256: result.workerSha256, code: result.code }));
    } finally { clearTimeout(timer); if (child.exitCode === null) { child.kill(); await child.exited; } }
  }
}, 60000);

// These small structures declare encryption. They do not contain decryptable ciphertext.
const workbook = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["CONTROL"]]), "Control");
const normalXls = new Uint8Array(XLSX.write(workbook, { type: "array", bookType: "xls" }));
const cfb = XLSX.CFB.read(normalXls, { type: "array" });
const stream = new Uint8Array(XLSX.CFB.find(cfb, "Workbook").content);
const bofEnd = 4 + new DataView(stream.buffer).getUint16(2, true);
const filePass = new Uint8Array([0x2f, 0, 6, 0, 0, 0, 0x34, 0x12, 0x78, 0x56]);
const changed = new Uint8Array(stream.length + filePass.length);
changed.set(stream.subarray(0, bofEnd)); changed.set(filePass, bofEnd);
changed.set(stream.subarray(bofEnd), bofEnd + filePass.length);
XLSX.CFB.utils.cfb_add(cfb, "Workbook", changed);
const biff8Declaration = new Uint8Array(XLSX.CFB.write(cfb, { type: "array" }));
function cfbDeclaration(info?: Uint8Array) {
  const container = XLSX.CFB.utils.cfb_new();
  if (info) XLSX.CFB.utils.cfb_add(container, "EncryptionInfo", info);
  XLSX.CFB.utils.cfb_add(container, "EncryptedPackage", new Uint8Array([0]));
  return new Uint8Array(XLSX.CFB.write(container, { type: "array" }));
}
const xml = new TextEncoder().encode('<encryption xmlns="http://schemas.microsoft.com/office/2006/encryption"><keyEncryptors></keyEncryptors></encryption>');
const agileInfo = new Uint8Array(8 + xml.length); agileInfo.set([4, 0, 4, 0]); agileInfo.set(xml, 8);
const declarations = [
  { name: "BIFF8 FilePass declaration", bytes: biff8Declaration, message: "File is password-protected", sha256: "066abe7ffae8c9899ff8000074ba8fca841866b424411dcdbf3a0a23456a4c55" },
  { name: "ECMA-376 Extensible declaration", bytes: cfbDeclaration(new Uint8Array([3, 0, 3, 0])), message: "File is password-protected: ECMA-376 Extensible", sha256: "efc7575d45f4a09e89c79c98af06f45b7d3f921381f91842aba847fd26d60b8c" },
  { name: "ECMA-376 Agile declaration", bytes: cfbDeclaration(agileInfo), message: "File is password-protected", sha256: "cfc1695827a277e91801b90f25e084ce4601516e3edcd5cf7dbd9131058c5d4a" },
];
for (const declaration of declarations) test(`combined CFB and password classification retain ${declaration.name}`, async () => {
  expect(hash(declaration.bytes)).toBe(declaration.sha256);
  await expect(read(declaration.bytes, "declaration.xls")).rejects.toMatchObject({ code: "VOICE_ATTACHMENT_DOCUMENT_ENCRYPTED" });
});
test("combined CFB and classification reject missing EncryptionInfo as invalid", async () => {
  await expect(read(cfbDeclaration(), "missing-info.xls")).rejects.toMatchObject({ code: invalid });
});
function biffRange(recordType: number | null, ref = "A1") {
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["SYNTHETIC_BIFF_LINK"]]), "Control");
  wb.Sheets.Control!.A1.l = { Target: "#A1", Tooltip: "tiny" };
  const cfb = XLSX.CFB.read(new Uint8Array(XLSX.write(wb, { type: "array", bookType: "biff8" })), { type: "array" });
  const entry = XLSX.CFB.find(cfb, "/Workbook"); const bytes = new Uint8Array(entry.content); let found = 0;
  for (let at = 0; at + 4 <= bytes.length;) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); const type = view.getUint16(at, true), length = view.getUint16(at + 2, true);
    expect(at + 4 + length).toBeLessThanOrEqual(bytes.length);
    if (type === recordType) {
      found++; const range = XLSX.utils.decode_range(ref), payload = at + 4 + (type === 0x0800 ? 2 : 0);
      for (const [offset, value] of [[0, range.s.r], [2, range.e.r], [4, range.s.c], [6, range.e.c]]) view.setUint16(payload + offset!, value!, true);
    }
    at += 4 + length;
  }
  if (recordType !== null) expect(found).toBe(1); entry.content = bytes; entry.size = bytes.length;
  return new Uint8Array(XLSX.CFB.write(cfb, { type: "array" }));
}
test("combined CFB and hyperlink reader retain ordinary BIFF links", async () => {
  expect((await read(biffRange(null), "normal-link.xls")).content).toContain("SYNTHETIC_BIFF_LINK");
});
for (const recordType of [0x01b8, 0x0800]) test(`combined CFB and BIFF ${recordType} reject a link outside the row limit`, async () => {
  await expect(read(biffRange(recordType, "A1001"), "large-link.xls")).rejects.toMatchObject({ code: limit });
});
