import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as upstream from "xlsx";
import { unzipSync, zipSync, strFromU8, strToU8 } from "fflate";
import { read } from "../src/generated/sheetjs-reader.mjs";
import { createVoiceSpreadsheetHyperlinkGuard, type VoiceHyperlinkEvent, type VoiceHyperlinkGuard } from "../src/voice-spreadsheet-hyperlink-guard";
import { extractVoiceSpreadsheet, validateVoiceSpreadsheetZip } from "../src/voice-spreadsheet-extraction";
import { patchSheetjsHyperlinkGuard, buildVoiceSheetjsReader } from "../scripts/sheetjs-hyperlink-guard-patch";
const limit = "VOICE_ATTACHMENT_DOCUMENT_LIMIT", invalid = "VOICE_ATTACHMENT_DOCUMENT_INVALID";
let networkAttempts = 0;
globalThis.fetch = (async () => { networkAttempts++; throw new Error("Hyperlink control network access is disabled"); }) as unknown as typeof fetch;
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const fixedDate = new Date("2000-01-01T00:00:00.000Z");
const options = { type: "array", dense: false, cellHTML: false, bookVBA: false, cellFormula: true, cellNF: true, WTF: true } as const;
const smallLimits = { maxRows: 1000, maxColumns: 256, maxCells: 4, maxHyperlinkRangeVisits: 4 };
const reports: Record<string, unknown>[] = [];
function workbook(rows: unknown[][] = [["HYPERLINK_SMALL_CONTROL"]]) {
  const wb = upstream.utils.book_new(); wb.Props = { CreatedDate: fixedDate, ModifiedDate: fixedDate };
  upstream.utils.book_append_sheet(wb, upstream.utils.aoa_to_sheet(rows), "Control"); return wb;
}
const archive = (wb = workbook()) => unzipSync(new Uint8Array(upstream.write(wb, { type: "array", bookType: "xlsx" })));
const zip = (files: Record<string, Uint8Array>) => zipSync(files, { level: 0, mtime: fixedDate });
function appendLinks(files: Record<string, Uint8Array>, links: string, index = 1) {
  const path = `xl/worksheets/sheet${index}.xml`;
  files[path] = strToU8(strFromU8(files[path]!).replace("</worksheet>", `<hyperlinks>${links}</hyperlinks></worksheet>`));
}
function xml(ref: string, attributes = 'location="A1"') {
  const files = archive(); appendLinks(files, `<hyperlink ref="${ref}" ${attributes}/>`); return zip(files);
}
function code(action: () => unknown): string | null {
  try { action(); return null; } catch (cause) { return (cause as { code?: string }).code ?? (cause as Error).message; }
}
function traceGuard(limits = smallLimits) {
  const original = createVoiceSpreadsheetHyperlinkGuard(limits);
  const events: { event: VoiceHyperlinkEvent; keys: string[]; rejected?: string }[] = [];
  const guard: VoiceHyperlinkGuard = Object.assign((sheet: unknown, event: VoiceHyperlinkEvent) => {
    const observation = { event, keys: sheet && typeof sheet === "object" ? Object.keys(sheet).filter(key => !key.startsWith("!")) : [] } as typeof events[number];
    events.push(observation);
    try { original(sheet, event); } catch (cause) { observation.rejected = (cause as { code: string }).code; throw cause; }
  }, { check: original.check });
  return { guard, events };
}
function record(name: string, bytes: Uint8Array, action: () => unknown, expected: string | null, extra: Record<string, unknown> = {}) {
  assert(bytes.length < 30000); const actual = code(action); assert.equal(actual, expected, name);
  reports.push({ name, inputBytes: bytes.length, inputSha256: hash(bytes), code: actual, ...extra });
}

for (const ref of ["A1:A2", "A1000", "IV1", "A1:A2 A1001", "A1&#58;A1001", "A2000:A1"]) {
  const bytes = xml(ref); const parsed = upstream.read(bytes, options);
  record(`XML supported ${ref}`, bytes, () => {
    const guarded = read(bytes, { ...options, voiceHyperlinkRangeGuard: createVoiceSpreadsheetHyperlinkGuard() });
    assert.deepEqual(guarded.Sheets.Control, parsed.Sheets.Control);
    assert(extractVoiceSpreadsheet(bytes, "xlsx").includes("HYPERLINK_SMALL_CONTROL"));
  }, null);
}
for (const ref of ["A1001", "IW1"]) {
  const bytes = xml(ref); const traced = traceGuard();
  record(`XML rejects ${ref} before loop`, bytes, () => read(bytes, { ...options, voiceHyperlinkRangeGuard: traced.guard }), limit);
  assert.equal(traced.events.find(event => event.rejected)?.keys.length, 1);
  reports.at(-1)!.events = traced.events;
  record(`product rejects ${ref}`, bytes, () => extractVoiceSpreadsheet(bytes, "xlsx"), limit);
}
const malformed = xml("A:A");
assert(Object.hasOwn(upstream.read(malformed, options).Sheets.Control!, "A0"));
record("negative decoded row explicitly becomes INVALID", malformed, () => extractVoiceSpreadsheet(malformed, "xlsx"), invalid);
const namespace = archive(); appendLinks(namespace, "<x:hyperlink x:ref='A1:A2' location='A1' tooltip='tiny'/>");
record("namespaced single quoted attributes", zip(namespace), () => extractVoiceSpreadsheet(zip(namespace), "xlsx"), null);
const external = archive(); appendLinks(external, '<hyperlink ref="A1:A2" r:id="rIdOne"/>');
external["xl/worksheets/_rels/sheet1.xml.rels"] = strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdOne" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.invalid/synthetic?x=1&amp;y=2" TargetMode="External"/></Relationships>');
record("external relation is data only", zip(external), () => extractVoiceSpreadsheet(zip(external), "xlsx"), null);
record("missing relation keeps internal fallback", xml("A1:A2", 'r:id="absent" location="Control!A1"'), () => extractVoiceSpreadsheet(xml("A1:A2", 'r:id="absent" location="Control!A1"'), "xlsx"), null);

const repeated = archive(); appendLinks(repeated, Array.from({ length: 100 }, () => '<hyperlink ref="A1:A2" location="A1"/>').join(""));
record("100 repeated small links retain unique cells", zip(repeated), () => {
  const traced = traceGuard(); const wb = read(zip(repeated), { ...options, voiceHyperlinkRangeGuard: traced.guard });
  assert.equal(Object.keys(wb.Sheets.Control!).filter(key => !key.startsWith("!")).length, 2);
  assert.equal(traced.events.filter(event => event.event.kind === "range").length, 100);
}, null);
const actualKeys = Object.keys; const observedSheets = new WeakSet<object>(); let sheetKeyScans = 0;
const efficientGuard = createVoiceSpreadsheetHyperlinkGuard(smallLimits);
const efficientCallback = Object.assign((sheet: unknown, event: VoiceHyperlinkEvent) => {
  if (sheet && typeof sheet === "object") observedSheets.add(sheet);
  efficientGuard(sheet, event);
}, { check: efficientGuard.check });
try {
  Object.keys = ((value: object) => { if (observedSheets.has(value)) sheetKeyScans++; return actualKeys(value); }) as typeof Object.keys;
  read(zip(repeated), { ...options, voiceHyperlinkRangeGuard: efficientCallback });
} finally { Object.keys = actualKeys; }
assert.equal(sheetKeyScans, 2); reports.at(-1)!.actualSheetKeyScans = sheetKeyScans;
const overlap = archive(); appendLinks(overlap, '<hyperlink ref="A1:B1" location="A1"/><hyperlink ref="B1:C1" location="A1"/>');
record("overlapping ranges reserve only new keys", zip(overlap), () => {
  assert.equal(Object.keys(read(zip(overlap), { ...options, voiceHyperlinkRangeGuard: traceGuard().guard }).Sheets.Control!).filter(key => !key.startsWith("!")).length, 3);
}, null);
const sheets = workbook([["FIRST", "SECOND"]]); upstream.utils.book_append_sheet(sheets, upstream.utils.aoa_to_sheet([]), "Empty");
const passSheets = archive(sheets); appendLinks(passSheets, '<hyperlink ref="C1" location="A1"/>'); appendLinks(passSheets, '<hyperlink ref="A1" location="A1"/>', 2);
record("completion replaces contribution; cross-sheet fourth unique cell passes", zip(passSheets), () => read(zip(passSheets), { ...options, voiceHyperlinkRangeGuard: traceGuard().guard }), null);
const failSheets = { ...passSheets }; appendLinks(failSheets, '<hyperlink ref="B1" location="A1"/>', 2);
const cross = traceGuard(); record("cross-sheet fifth cell rejects before assignment", zip(failSheets), () => read(zip(failSheets), { ...options, voiceHyperlinkRangeGuard: cross.guard }), limit);
assert.deepEqual(cross.events.find(event => event.rejected)?.keys, ["A1"]);
reports.at(-1)!.events = cross.events;
const priorPlain = archive(sheets); appendLinks(priorPlain, '<hyperlink ref="A1:C1" location="A1"/>', 2);
record("prior plain sheet contributes to hyperlink budget", zip(priorPlain), () => read(zip(priorPlain), { ...options, voiceHyperlinkRangeGuard: traceGuard().guard }), limit);
const emptyXml = archive(sheets); emptyXml["xl/worksheets/sheet2.xml"] = new Uint8Array();
record("normal and empty XML sheets remain supported", zip(emptyXml), () => {
  const wb = read(zip(emptyXml), { ...options, voiceHyperlinkRangeGuard: createVoiceSpreadsheetHyperlinkGuard() }); assert.equal(wb.Sheets.Empty, "");
  assert(extractVoiceSpreadsheet(zip(emptyXml), "xlsx").includes("FIRST"));
}, null);
record("WTF false cannot swallow LIMIT", xml("A1001"), () => read(xml("A1001"), { ...options, WTF: false, voiceHyperlinkRangeGuard: createVoiceSpreadsheetHyperlinkGuard() }), limit);
const sticky = createVoiceSpreadsheetHyperlinkGuard();
const secondary = Object.assign((sheet: unknown, event: VoiceHyperlinkEvent) => {
  try { sticky(sheet, event); } catch { throw new TypeError("Synthetic secondary reader error"); }
}, { check: sticky.check });
record("sticky LIMIT precedes a secondary internal error", xml("A1001"), () => read(xml("A1001"), { ...options, voiceHyperlinkRangeGuard: secondary }), limit);
assert.throws(() => read(xml("A1"), { ...options } as never), /VOICE_SHEETJS_HYPERLINK_GUARD_REQUIRED/);
assert.throws(() => read(xml("A1"), { ...options, dense: true, voiceHyperlinkRangeGuard: createVoiceSpreadsheetHyperlinkGuard() }), /VOICE_SHEETJS_HYPERLINK_GUARD_REQUIRED/);

type BinRecord = { type: number; start: number; payload: number; end: number };
function binaryRecords(bytes: Uint8Array): BinRecord[] {
  const records: BinRecord[] = [];
  for (let at = 0; at < bytes.length;) {
    const start = at; let type = bytes[at++]!; if (type & 128) type = (type & 127) + ((bytes[at++]! & 127) << 7);
    let length = 0, shift = 0, byte: number;
    do { byte = bytes[at++]!; length += (byte & 127) * 2 ** shift; shift += 7; } while (byte & 128);
    assert(at + length <= bytes.length); records.push({ type, start, payload: at, end: at + length }); at += length;
  }
  return records;
}
function binarySheet(refs: string[], interleaved = false) {
  const wb = workbook([["FIRST"], ["SECOND"]]);
  wb.Sheets.Control!.A1.l = { Target: "#A1" }; wb.Sheets.Control!.A2.l = { Target: "#A1" };
  const binary = unzipSync(new Uint8Array(upstream.write(wb, { type: "array", bookType: "xlsb" }))); const bytes = binary["xl/worksheets/sheet1.bin"]!;
  const records = binaryRecords(bytes), links = records.filter(record => record.type === 0x01ee); assert.equal(links.length, 2);
  for (let index = 0; index < refs.length; index++) {
    const range = upstream.utils.decode_range(refs[index]!); const at = links[index]!.payload; const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (const [offset, value] of [[0, range.s.r], [4, range.e.r], [8, range.s.c], [12, range.e.c]]) view.setUint32(at + offset!, value!, true);
  }
  let worksheet = bytes;
  if (interleaved) {
    const moved = links[0]!; const rowHeaders = records.filter(record => record.type === 0); assert.equal(rowHeaders.length, 2);
    const insert = rowHeaders[1]!.start;
    worksheet = new Uint8Array([...bytes.subarray(0, insert), ...bytes.subarray(moved.start, moved.end), ...bytes.subarray(insert, moved.start), ...bytes.subarray(moved.end)]);
  }
  const files = archive(wb); files["xl/worksheets/sheet1.bin"] = worksheet; delete files["xl/worksheets/sheet1.xml"];
  files["xl/_rels/workbook.xml.rels"] = strToU8(strFromU8(files["xl/_rels/workbook.xml.rels"]!).replace("worksheets/sheet1.xml", "worksheets/sheet1.bin"));
  files["[Content_Types].xml"] = strToU8(strFromU8(files["[Content_Types].xml"]!).replace("/xl/worksheets/sheet1.xml", "/xl/worksheets/sheet1.bin"));
  return zip(files);
}
const binNormal = binarySheet(["A1", "A2"]), binRows = binarySheet(["A1001", "A2"]);
record("real XLSB worksheet dispatch remains supported", binNormal, () => { validateVoiceSpreadsheetZip(binNormal); assert(extractVoiceSpreadsheet(binNormal, "xlsx").includes("FIRST")); }, null);
const binaryTrace = traceGuard(); record("real BrtHLink rejects before expansion", binRows, () => read(binRows, { ...options, voiceHyperlinkRangeGuard: binaryTrace.guard }), limit);
assert.equal(binaryTrace.events.find(event => event.rejected)?.event.kind, "range");
reports.at(-1)!.events = binaryTrace.events;
record("product rejects XLSB hyperlink row", binRows, () => extractVoiceSpreadsheet(binRows, "xlsx"), limit);
const interleaved = binarySheet(["B1", "B2"], true); const interleavedTrace = traceGuard({ ...smallLimits, maxCells: 3 });
record("real interleaved XLSB cells contribute before next link", interleaved, () => read(interleaved, { ...options, voiceHyperlinkRangeGuard: interleavedTrace.guard }), limit);
assert.deepEqual(interleavedTrace.events.find(event => event.rejected)?.keys.sort(), ["A1", "A2", "B1"]);
reports.at(-1)!.events = interleavedTrace.events;

function biff(recordType: number | null, ref = "A1") {
  const wb = workbook(); wb.Sheets.Control!.A1.l = { Target: "#A1", Tooltip: "tiny" };
  const cfb = upstream.CFB.read(new Uint8Array(upstream.write(wb, { type: "array", bookType: "biff8" })), { type: "array" });
  const entry = upstream.CFB.find(cfb, "/Workbook"); const bytes = new Uint8Array(entry.content); let found = 0;
  for (let at = 0; at + 4 <= bytes.length;) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); const type = view.getUint16(at, true), length = view.getUint16(at + 2, true); assert(at + 4 + length <= bytes.length);
    if (type === recordType) {
      found++; const range = upstream.utils.decode_range(ref), payload = at + 4 + (type === 0x0800 ? 2 : 0);
      for (const [offset, value] of [[0, range.s.r], [2, range.e.r], [4, range.s.c], [6, range.e.c]]) view.setUint16(payload + offset!, value!, true);
    }
    at += 4 + length;
  }
  if (recordType !== null) assert.equal(found, 1); entry.content = bytes; entry.size = bytes.length;
  return new Uint8Array(upstream.CFB.write(cfb, { type: "array" }));
}
const biffNormal = biff(null); record("real XLS HLink and Tooltip remain supported", biffNormal, () => assert(extractVoiceSpreadsheet(biffNormal, "xls").includes("HYPERLINK_SMALL_CONTROL")), null);
for (const recordType of [0x01b8, 0x0800]) {
  const bytes = biff(recordType, "A1001"); const traced = traceGuard();
  record(`real BIFF ${recordType} bounds before visit`, bytes, () => read(bytes, { ...options, voiceHyperlinkRangeGuard: traced.guard }), limit);
  assert.equal(traced.events.find(event => event.rejected)?.keys.length, 1);
  reports.at(-1)!.events = traced.events;
  record(`product BIFF ${recordType} LIMIT`, bytes, () => extractVoiceSpreadsheet(bytes, "xls"), limit);
}
const biffArea = biff(0x01b8, "A1:C2"); record("new single-range visit rule applies to existing XLS cells", biffArea, () => read(biffArea, { ...options, voiceHyperlinkRangeGuard: traceGuard().guard }), limit);
assert.equal(Object.keys(upstream.read(biffArea, options).Sheets.Control!).filter(key => !key.startsWith("!")).length, 1);

const source = readFileSync(new URL("../node_modules/xlsx/xlsx.mjs", import.meta.url), "utf8");
const patched = patchSheetjsHyperlinkGuard(source);
assert.equal((patched.match(/else \{ var _vaddr = encode_col\(C\) \+ rr; opts.voiceHyperlinkRangeGuard\(s, \{kind:'cell', address:_vaddr\}\); s\[_vaddr\] = p; \}/g) ?? []).length, 2);
assert.throws(() => patchSheetjsHyperlinkGuard(source + "\n"), /Pinned SheetJS source mismatch/);
const rebuilt = await buildVoiceSheetjsReader(source); const prepared = readFileSync(new URL("../src/generated/sheetjs-reader.mjs", import.meta.url), "utf8");
assert.equal(hash(rebuilt), hash(prepared));
assert.equal(networkAttempts, 0);
console.log(JSON.stringify({ runtime: `Bun ${Bun.version}`, childPid: process.pid, networkAttempts, upstreamSha256: hash(source), patchedSha256: hash(patched), readerSha256: hash(prepared), readerDriftCheck: true, allControlsPassed: true, reports, scope: "Actual pinned reader and product extraction; custom small guard limits are branch controls. No OOM/browser/signed App/SOURCE claim." }));
