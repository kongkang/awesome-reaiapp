import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import * as XLSX from "xlsx";
import { extractVoiceSpreadsheet, validateVoiceSpreadsheetZip } from "../src/voice-spreadsheet-extraction";
import { readVoiceDocumentAttachment } from "../src/voice-document-extraction";

const invalid = "VOICE_ATTACHMENT_DOCUMENT_INVALID";
const encrypted = "VOICE_ATTACHMENT_DOCUMENT_ENCRYPTED";
const options = { type: "array", dense: false, cellHTML: false, bookVBA: false, cellFormula: true, cellNF: true, WTF: true } as const;
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const fixtures = [
  ["normal", "afa333fd3bad7650daa4390291b2698e43ca32b011ee5322d3b29e1a22724166"],
  ["invalidMarker", "e18eb2cf6ff40058b30ffa856d77f6fbd12bf62ede0bca0068bbd27f3c2a93f3"],
  ["passwordMarker", "f77171ddcd57246685e5637ec931fecd19ad397ac8d8f46ac798e60f94309b0a"],
  ["encryptMarker", "023503a2b0435ef65ba67752743eca46d240329aa30ba7245913bb56e054285b"],
] as const;
async function fixture(marker: string, sha256: string) {
  const bytes = new Uint8Array(await Bun.file(new URL(`fixtures/spreadsheet-errors/xlsx-${marker}.xlsx`, import.meta.url)).arrayBuffer());
  expect(hash(bytes)).toBe(sha256);
  return bytes;
}

for (const [marker, sha256] of fixtures) {
  test(`exact XLSX ${marker}: unknown XML is invalid, not encryption`, async () => {
    const bytes = await fixture(marker, sha256);
    expect(() => validateVoiceSpreadsheetZip(bytes)).not.toThrow();
    if (marker === "normal") {
      expect(JSON.parse(extractVoiceSpreadsheet(bytes, "xlsx")).sheets[0].cells[0].value).toBe("SYNTHETIC_CONTROL");
    } else {
      expect(() => XLSX.read(bytes, options)).toThrow(`unrecognized <${marker}/> in workbook`);
      expect(() => extractVoiceSpreadsheet(bytes, "xlsx")).toThrow(invalid);
    }
  });
  test(`official generated Worker classifies exact XLSX ${marker}`, async () => {
    const bytes = await fixture(marker, sha256);
    const result = readVoiceDocumentAttachment(new File([bytes], `${marker}.xlsx`));
    if (marker === "normal") expect(JSON.parse((await result).content).sheets[0].cells[0].value).toBe("SYNTHETIC_CONTROL");
    else await expect(result).rejects.toMatchObject({ code: invalid });
  });
}

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
for (const declaration of declarations) {
  test(`pinned library recognizes ${declaration.name}`, () => {
    expect(hash(declaration.bytes)).toBe(declaration.sha256);
    expect(() => XLSX.read(declaration.bytes, options)).toThrow(declaration.message);
    expect(() => extractVoiceSpreadsheet(declaration.bytes, "xls")).toThrow(encrypted);
    // The declared XLSX ZIP contract continues to reject CFB before parsing.
    expect(() => extractVoiceSpreadsheet(declaration.bytes, "xlsx")).toThrow(invalid);
  });
  test(`official generated Worker preserves ${declaration.name}`, async () => {
    await expect(readVoiceDocumentAttachment(new File([declaration.bytes], "declaration.xls"))).rejects.toMatchObject({ code: encrypted });
  });
}
const missingInfo = cfbDeclaration();
test("missing EncryptionInfo is an invalid declaration, not a password exception", () => {
  expect(hash(missingInfo)).toBe("8aed01f20b0a0b6ddca8370efd25338faa502054273361dab71e23485a800613");
  expect(() => XLSX.read(missingInfo, options)).toThrow("ECMA-376 Encrypted file missing /EncryptionInfo");
  expect(() => extractVoiceSpreadsheet(missingInfo, "xls")).toThrow(invalid);
});
test("official generated Worker rejects missing EncryptionInfo as invalid", async () => {
  await expect(readVoiceDocumentAttachment(new File([missingInfo], "missing-info.xls"))).rejects.toMatchObject({ code: invalid });
});
test("normal OLE/BIFF8 XLS control still extracts", () => {
  expect(JSON.parse(extractVoiceSpreadsheet(normalXls, "xls")).sheets[0].cells[0].value).toBe("CONTROL");
});
test("ZIP encryption flag remains encrypted before parsing and in the official Worker", async () => {
  const bytes = await fixture(...fixtures[0]); const view = new DataView(bytes.buffer);
  for (let at = 0; at < bytes.length - 4; at++) if (view.getUint32(at, true) === 0x02014b50) {
    view.setUint16(at + 8, view.getUint16(at + 8, true) | 1, true); break;
  }
  expect(() => validateVoiceSpreadsheetZip(bytes)).toThrow(encrypted);
  expect(() => extractVoiceSpreadsheet(bytes, "xlsx")).toThrow(encrypted);
  await expect(readVoiceDocumentAttachment(new File([bytes], "zip-flag.xlsx"))).rejects.toMatchObject({ code: encrypted });
});
