import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import * as XLSX from "xlsx";
import { strToU8, unzipSync, zipSync } from "fflate";
import { extractVoiceSpreadsheet, validateVoiceSpreadsheetZip } from "../src/voice-spreadsheet-extraction";
import { readVoiceDocumentAttachment } from "../src/voice-document-extraction";

const invalid = "VOICE_ATTACHMENT_DOCUMENT_INVALID";
const fixedDate = new Date("2000-01-01T00:00:00.000Z");
const workbook = () => {
  const value = XLSX.utils.book_new();
  value.Props = { CreatedDate: fixedDate, ModifiedDate: fixedDate };
  XLSX.utils.book_append_sheet(value, XLSX.utils.aoa_to_sheet([["XLSX_FORMAT_CONTROL"]]), "Control");
  return value;
};
const entries = () => unzipSync(new Uint8Array(XLSX.write(workbook(), { type: "array", bookType: "xlsx" })));
const zip = (files: Record<string, Uint8Array>) => zipSync(files, { level: 0, mtime: fixedDate });
const normal = zip(entries());
const mixedOds = (marker: string, rows = 2) => {
  const files = entries();
  files[marker] = strToU8("<objectdata/>");
  files["styles.xml"] = strToU8('<office:document-styles xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"><office:styles/></office:document-styles>');
  files["content.xml"] = strToU8(`<?xml version="1.0"?><office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"><office:body><office:spreadsheet><table:table table:name="ODS_ROUTE"><table:table-row table:number-rows-repeated="${rows}"><table:table-cell office:value-type="float" office:value="1"><text:p>1</text:p></table:table-cell></table:table-row></table:table></office:spreadsheet></office:body></office:document-content>`);
  return zip(files);
};
const nestedCsv = strToU8("BOM_NESTED_CSV_ROUTE\n1\n");
const mixedBom = () => {
  const files = entries();
  files["\uFEFF[Content_Types].xml"] = files["[Content_Types].xml"]!;
  delete files["[Content_Types].xml"];
  files["Index.zip"] = nestedCsv;
  return zip(files);
};
const mixedNumbers = (marker: string) => zip({ ...entries(), [marker]: new Uint8Array([1]) });
const prefixedZip = () => {
  const prefix = strToU8("<html>INERT_PREFIX</html>");
  const bytes = new Uint8Array(prefix.length + normal.length);
  bytes.set(prefix); bytes.set(normal, prefix.length);
  const view = new DataView(bytes.buffer);
  const original = new DataView(normal.buffer, normal.byteOffset, normal.byteLength);
  let at = original.getUint32(normal.length - 6, true);
  const count = original.getUint16(normal.length - 12, true);
  for (let index = 0; index < count; index++) {
    const target = at + prefix.length;
    view.setUint32(target + 42, original.getUint32(at + 42, true) + prefix.length, true);
    at += 46 + original.getUint16(at + 28, true) + original.getUint16(at + 30, true) + original.getUint16(at + 32, true);
  }
  const end = prefix.length + normal.length - 22;
  view.setUint32(end + 16, original.getUint32(normal.length - 6, true) + prefix.length, true);
  return bytes;
};
const withComment = (fake: boolean) => {
  const comment = fake ? new Uint8Array(20) : strToU8("ordinary ZIP comment");
  if (fake) new DataView(comment.buffer).setUint32(0, 0x06054b50, true); // Inert alternate directory: zero entries/offset.
  const bytes = new Uint8Array(normal.length + comment.length);
  bytes.set(normal); bytes.set(comment, normal.length);
  new DataView(bytes.buffer).setUint16(normal.length - 2, comment.length, true);
  return bytes;
};
const cases = [
  ...["objectdata.xml", "OBJECTDATA.XML", "Root Entry/objectdata.xml"].map(name => ({ name: `ODS ${name}`, bytes: mixedOds(name) })),
  ...["META-INF/manifest.xml", "meta-inf/MANIFEST.XML", "META-INF//manifest.xml"].map(name => ({ name: `ODS ${name}`, bytes: mixedOds(name) })),
  { name: "ODS 1001 repeated rows", bytes: mixedOds("objectdata.xml", 1001) },
  ...["Index/Document.iwa", "INDEX/DOCUMENT.IWA", "Index//Document.iwa", "Root Entry/Index/Document.iwa"].map(name => ({ name: `Numbers ${name}`, bytes: mixedNumbers(name) })),
  { name: "non-ZIP prefix with correct absolute offsets", bytes: prefixedZip() },
  { name: "20-byte fake EOCD in comment", bytes: withComment(true) },
  { name: "case-only workbook alias", bytes: zip({ ...entries(), "XL/WORKBOOK.XML": entries()["xl/workbook.xml"]! }) },
  { name: "double slash workbook alias", bytes: zip({ ...entries(), "xl//workbook.xml": entries()["xl/workbook.xml"]! }) },
  { name: "BOM content-types name with nested CSV", bytes: mixedBom() },
];
console.info(`SPREADSHEET_FORMAT_FIXTURES=${JSON.stringify(Object.fromEntries(cases.map(({ name, bytes }) => [name, { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }])))} `);

test("bounded mixed ODS fixtures exercise the real alternate parser", () => {
  for (const rows of [2, 1001]) {
    const parsed = XLSX.read(mixedOds("objectdata.xml", rows), { type: "array", dense: false, cellHTML: false, bookVBA: false, cellFormula: true, cellNF: true, WTF: true });
    expect(parsed.SheetNames).toEqual(["ODS_ROUTE"]);
    expect(Object.keys(parsed.Sheets.ODS_ROUTE!).filter(address => !address.startsWith("!")).length).toBe(rows);
  }
});

test("bounded BOM fixture exercises the real nested CSV parser", () => {
  const parsed = XLSX.read(mixedBom(), { type: "array", dense: false, cellHTML: false, bookVBA: false, cellFormula: true, cellNF: true, WTF: true });
  expect(parsed.SheetNames).toEqual(["Sheet1"]);
  expect(parsed.Sheets.Sheet1!.A1.v).toBe("BOM_NESTED_CSV_ROUTE");
});

test("XLSX extraction rejects BOM content-types before recursive parsing", () => {
  expect(() => extractVoiceSpreadsheet(mixedBom(), "xlsx")).toThrow(invalid);
});

for (const fixture of cases) test(`XLSX preflight rejects ${fixture.name} before SheetJS`, () => {
  expect(fixture.bytes.length).toBeLessThan(20000);
  expect(() => validateVoiceSpreadsheetZip(fixture.bytes)).toThrow(invalid);
});

for (const rows of [2, 1001]) test(`XLSX extraction rejects mixed ODS ${rows} rows as invalid format`, () => {
  expect(() => extractVoiceSpreadsheet(mixedOds("objectdata.xml", rows), "xlsx")).toThrow(invalid);
});

test("normal XLSX, harmless extra XML, directory records and ordinary ZIP comments remain supported", () => {
  const extra = zip({ ...entries(), "content.xml": strToU8("<inert/>"), "styles.xml": strToU8("<inert/>"), "xl/": new Uint8Array() });
  const withIndex = zip({ ...entries(), "Index.zip": nestedCsv });
  for (const bytes of [normal, extra, withIndex, withComment(false)]) {
    expect(() => validateVoiceSpreadsheetZip(bytes)).not.toThrow();
    const output = JSON.parse(extractVoiceSpreadsheet(bytes, "xlsx"));
    expect(output.sheets[0].name).toBe("Control");
    expect(output.sheets[0].cells[0].value).toBe("XLSX_FORMAT_CONTROL");
  }
});

test("required OOXML paths keep their exact names and do not fold Unicode into ASCII", () => {
  for (const name of ["XL/WORKBOOK.XML", "xl/wor\u212Abook.xml"]) {
    const files = entries(); files[name] = files["xl/workbook.xml"]!; delete files["xl/workbook.xml"];
    expect(() => validateVoiceSpreadsheetZip(zip(files))).toThrow(invalid);
  }
});

test("existing XLS contract still reads the OLE/BIFF8 control", () => {
  const bytes = new Uint8Array(XLSX.write(workbook(), { type: "array", bookType: "biff8" }));
  expect(JSON.parse(extractVoiceSpreadsheet(bytes, "xls")).sheets[0].cells[0].value).toBe("XLSX_FORMAT_CONTROL");
});

for (const fixture of [cases[0]!, cases[7]!, cases[11]!, cases[12]!, cases[15]!]) test(`actual spreadsheet Worker rejects ${fixture.name}`, async () => {
  await expect(readVoiceDocumentAttachment(new File([fixture.bytes], "mixed-format.xlsx"))).rejects.toMatchObject({ code: invalid });
});
