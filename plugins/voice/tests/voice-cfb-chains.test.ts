import { expect, test } from "bun:test";
import * as XLSX from "xlsx";
import { validateVoiceCfbChains } from "../src/voice-cfb-chains";
import { extractVoiceSpreadsheet } from "../src/voice-spreadsheet-extraction";
import { cfbFixture, invalidCfbFixtures, setDirectory, setFat } from "./fixtures/voice-cfb-fixtures";

const invalid = "VOICE_ATTACHMENT_DOCUMENT_INVALID";
for (const fixture of invalidCfbFixtures()) test(`CFB rejects ${fixture.name} before parsing`, () => {
  expect(() => validateVoiceCfbChains(fixture.bytes)).toThrow(invalid);
});
test("CFB accepts completed acyclic shared tails without claiming a valid workbook", () => {
  const bytes = cfbFixture(5); setFat(bytes, 2, 4); setFat(bytes, 3, 4); setFat(bytes, 4, -2);
  expect(() => validateVoiceCfbChains(bytes)).not.toThrow();
});
test("CFB accepts unused directory entries, standard terminals and version 3/4 structures", () => {
  for (const size of [512, 4096]) {
    const bytes = cfbFixture(4, size); setDirectory(bytes, 1, 0, -1, 0);
    setFat(bytes, 2, -1); setFat(bytes, 3, -4);
    expect(() => validateVoiceCfbChains(bytes)).not.toThrow();
  }
});
test("CFB permits a final short data sector but not short metadata", () => {
  expect(() => validateVoiceCfbChains(cfbFixture().slice(0, -1))).not.toThrow();
});
test("CFB accepts a complete required FAT page after the header page boundary", () => {
  const bytes = cfbFixture(130); const view = new DataView(bytes.buffer);
  view.setUint32(44, 2, true); view.setInt32(80, 2, true);
  for (let i = 0; i < 128; i++) view.setInt32(1536 + i * 4, -1, true);
  setFat(bytes, 2, -3);
  expect(() => validateVoiceCfbChains(bytes)).not.toThrow();
});
test("CFB appends a required DIFAT page at the same position as SheetJS", () => {
  const bytes = cfbFixture(130); const view = new DataView(bytes.buffer);
  view.setUint32(44, 2, true); view.setInt32(68, 2, true); view.setUint32(72, 1, true);
  for (let at = 1536; at < 2048; at += 4) view.setInt32(at, -1, true);
  view.setInt32(1536, 3, true); view.setInt32(2044, -2, true);
  for (let at = 2048; at < 2560; at += 4) view.setInt32(at, -1, true);
  setFat(bytes, 2, -4); setFat(bytes, 3, -3);
  expect(() => validateVoiceCfbChains(bytes)).not.toThrow();
});
export function biff8Control(rows: number): Uint8Array {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(Array.from({ length: rows }, (_, i) => [`CFB_CONTROL_${i}`, i])), "Control");
  return new Uint8Array(XLSX.write(workbook, { type: "array", bookType: "biff8" }));
}
for (const rows of [1, 80]) test(`real BIFF8 ${rows} rows retain extraction`, () => {
  const bytes = biff8Control(rows);
  expect(() => validateVoiceCfbChains(bytes)).not.toThrow();
  const output = JSON.parse(extractVoiceSpreadsheet(bytes, "xls"));
  expect(output.sheets[0].cells).toHaveLength(rows * 2);
  expect(output.sheets[0].cells[0].value).toBe("CFB_CONTROL_0");
});
for (const variant of ["writer byte order 0xffff", "absent DIFAT starts with FREE", "additional allocated FAT page"] as const) test(`CFB retains upstream-compatible ${variant}`, () => {
  let bytes = biff8Control(1);
  if (variant === "additional allocated FAT page") {
    const original = bytes;
    bytes = new Uint8Array(original.length + 512); bytes.set(original);
    const view = new DataView(bytes.buffer), newSector = original.length / 512 - 1;
    const firstFat = view.getInt32(76, true);
    for (let at = original.length; at < bytes.length; at += 4) view.setInt32(at, -1, true);
    view.setInt32((firstFat + 1) * 512 + newSector * 4, -3, true);
    view.setUint32(44, 2, true); view.setInt32(80, newSector, true);
  } else {
    const view = new DataView(bytes.buffer);
    if (variant === "writer byte order 0xffff") view.setUint16(28, 0xffff, true);
    else view.setInt32(68, -1, true);
  }
  // These are small acyclic normal workbooks, not the unsafe old cyclic regression.
  expect(XLSX.read(bytes, { type: "array", WTF: true }).Sheets.Control!.A1.v).toBe("CFB_CONTROL_0");
  expect(() => validateVoiceCfbChains(bytes)).not.toThrow();
  expect(JSON.parse(extractVoiceSpreadsheet(bytes, "xls")).sheets[0].cells[0].value).toBe("CFB_CONTROL_0");
});
