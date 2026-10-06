import { expect, test } from "bun:test";
import { deflateRawSync } from "node:zlib";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { loadSupportMatrix, writeZip } from "@reai/app-cli";
import { packedFiles } from "../src/index";
import { readPackageZip, writePackageZip } from "../src/archive";

interface Entry { path: string; bytes: Buffer; deflate?: boolean; payload?: Buffer }
const entries: Entry[] = [
  { path: "app.manifest.json", bytes: Buffer.from('{"name":"fixture"}'), deflate: true },
  { path: "assets/content.txt", bytes: Buffer.from(Array.from({ length: 100 }, (_, i) => `line ${i}: deterministic package resources\n`).join("")), deflate: true },
  { path: "assets/empty", bytes: Buffer.alloc(0), deflate: true },
  { path: "assets/raw", bytes: Buffer.from([0, 1, 255]) },
];

/** Independent native encoder makes reader tests independent of the modern encoder. */
function fixture(input = entries): Buffer {
  const locals: Buffer[] = [], centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of input) {
    const stored = writeZip([entry]), originalCentral = stored.readUInt32LE(stored.length - 6);
    const nameLength = stored.readUInt16LE(26), local = Buffer.from(stored.subarray(0, 30 + nameLength));
    const central = Buffer.from(stored.subarray(originalCentral, stored.length - 22));
    const payload = entry.payload ?? (entry.deflate ? deflateRawSync(entry.bytes) : entry.bytes);
    local.writeUInt16LE(entry.deflate ? 8 : 0, 8); local.writeUInt32LE(payload.length, 18);
    central.writeUInt16LE(entry.deflate ? 8 : 0, 10); central.writeUInt32LE(payload.length, 20); central.writeUInt32LE(offset, 42);
    locals.push(local, payload); centrals.push(central); offset += local.length + payload.length;
  }
  const directory = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(input.length, 8); end.writeUInt16LE(input.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
function firstCentral(zip: Buffer) { return zip.readUInt32LE(zip.length - 6); }
function stored() { return fixture(entries.map(entry => ({ ...entry, deflate: false }))); }
function mutate(edit: (zip: Buffer, central: number) => void, base = stored()) {
  const zip = Buffer.from(base); edit(zip, firstCentral(zip)); return zip;
}

test("STORE and independent Deflate, mixed and empty entries restore all original bytes", () => {
  for (const zip of [stored(), fixture()]) {
    const files = packedFiles(zip);
    expect([...files.keys()]).toEqual(entries.map(entry => entry.path));
    for (const entry of entries) expect(Buffer.from(files.get(entry.path)!)).toEqual(entry.bytes);
  }
});

test("CRC is verified against actual payload, including matching but false header CRCs", () => {
  expect(() => packedFiles(mutate(zip => { zip[30 + zip.readUInt16LE(26)]! ^= 1; }))).toThrow();
  expect(() => packedFiles(mutate((zip, central) => { zip.writeUInt32LE(123, 14); zip.writeUInt32LE(123, central + 16); }))).toThrow();
});

test("local and central metadata must agree", () => {
  for (const [offset, width] of [[8, 2], [10, 2], [16, 4], [20, 4], [24, 4], [42, 4]]) {
    expect(() => packedFiles(mutate((zip, central) => {
      const at = central + offset!;
      if (width === 2) zip.writeUInt16LE(zip.readUInt16LE(at) ^ 1, at);
      else zip.writeUInt32LE(zip.readUInt32LE(at) ^ 1, at);
    }))).toThrow();
  }
  expect(() => packedFiles(mutate((zip, central) => { zip[central + 46]! ^= 1; }))).toThrow();
});

test("unsafe paths, exact/case/NFC duplicates and BOM disguised manifest are rejected", () => {
  for (const path of ["../escape", "/root", "a\\b", "a//b", "a/./b", "C:drive", "nul\u0000", "\uFEFFapp.manifest.json"]) {
    const input = path.startsWith("\uFEFF") ? [{ path, bytes: Buffer.from("{}") }] : [entries[0]!, { path, bytes: Buffer.alloc(0) }];
    expect(() => packedFiles(fixture(input))).toThrow();
  }
  for (const pair of [["a", "a"], ["A", "a"], ["café", "cafe\u0301"]]) {
    expect(() => packedFiles(fixture([entries[0]!, ...pair.map(path => ({ path, bytes: Buffer.alloc(0) }))]))).toThrow();
  }
  expect(() => packedFiles(mutate((zip, central) => { zip.fill(0xff, central + 46, central + 47); }))).toThrow();
});

test("Host reserved namespace and encoded separators are rejected before resource decoding", () => {
  for (const deflate of [false, true]) {
    for (const path of ["__host", "__host/app.js", "assets/a%2fb", "assets/a%2Fb", "assets/%2e", "assets/%2E", "assets/a%5cb", "assets/a%5Cb"]) {
      expect(() => packedFiles(fixture([entries[0]!, { path, bytes: Buffer.from("resource"), deflate }]))).toThrow("unsafe");
    }
    for (const path of ["assets/a%20b", "assets/__host/app.js", "__hostname/app.js"]) {
      expect(packedFiles(fixture([entries[0]!, { path, bytes: Buffer.from("resource"), deflate }])).has(path)).toBe(true);
    }
  }
});

test("encryption, descriptors, unknown methods, ZIP64, multidisk and symlinks fail closed", () => {
  for (const flags of [0x0801, 0x0808]) expect(() => packedFiles(mutate((zip, central) => {
    zip.writeUInt16LE(flags, 6); zip.writeUInt16LE(flags, central + 8);
  }))).toThrow();
  expect(() => packedFiles(mutate((zip, central) => { zip.writeUInt16LE(12, 8); zip.writeUInt16LE(12, central + 10); }))).toThrow();
  expect(() => packedFiles(mutate((zip, central) => { zip.writeUInt16LE(45, 4); zip.writeUInt16LE(45, central + 6); }))).toThrow();
  expect(() => packedFiles(mutate(zip => { zip.writeUInt16LE(1, zip.length - 18); }))).toThrow();
  for (const mode of [0o120777, 0o040755, 0o020644]) expect(() => packedFiles(mutate((zip, central) => {
    zip.writeUInt16LE(0x0314, central + 4); zip.writeUInt32LE((mode << 16) >>> 0, central + 38);
  }))).toThrow();
});

test("directory truncation, count/size/offset mismatch, comment and trailing bytes fail closed", () => {
  const zip = stored();
  for (const length of [1, 21, 25]) expect(() => packedFiles(zip.subarray(0, zip.length - length))).toThrow();
  for (const offset of [8, 10, 12, 16, 20]) expect(() => packedFiles(mutate(data => { data[data.length - 22 + offset]! ^= 1; }))).toThrow();
  expect(() => packedFiles(Buffer.concat([zip, Buffer.from([0])]))).toThrow();
});

test("Deflate output is bounded by declared size before allocation; malformed streams fail", () => {
  const zip = fixture([{ path: "app.manifest.json", bytes: Buffer.alloc(4096, 65), deflate: true }]);
  for (const declared of [0, 1, 4095, 4097]) expect(() => packedFiles(mutate((data, central) => {
    data.writeUInt32LE(declared, 22); data.writeUInt32LE(declared, central + 24);
  }, zip))).toThrow();
  expect(() => packedFiles(mutate(data => { data[30 + data.readUInt16LE(26)] = 0xff; }, fixture()))).toThrow();
});

test("STORE compressed and expanded sizes must match", () => {
  expect(() => packedFiles(mutate((zip, central) => { zip.writeUInt32LE(1, 22); zip.writeUInt32LE(1, central + 24); }))).toThrow();
});

test("limits cover archive/count/depth/single/total/ratio before decoding", () => {
  const limits = loadSupportMatrix().limits, zip = stored();
  for (const changed of [
    { packageZipBytes: zip.length - 1 }, { packageEntryCount: entries.length - 1 },
    { packagePathDepth: 1 }, { packageSingleFileBytes: 100 }, { packageUncompressedBytes: 100 },
  ]) expect(() => readPackageZip(zip, { ...limits, ...changed })).toThrow("PACKAGE_LIMIT_EXCEEDED");
  expect(() => readPackageZip(fixture(), { ...limits, packageMaxCompressionRatio: 1 })).toThrow("compression ratio");
  expect(readPackageZip(zip, { ...limits, packageZipBytes: zip.length, packageEntryCount: entries.length })).toEqual(packedFiles(zip));
});

test("valid Deflate cannot hide trailing compressed data or a truncated stream", () => {
  const bytes = Buffer.from("a valid bounded resource"), compressed = deflateRawSync(bytes);
  for (const payload of [Buffer.concat([compressed, Buffer.from([0])]), compressed.subarray(0, compressed.length - 1)]) {
    expect(() => packedFiles(fixture([{ path: "app.manifest.json", bytes, deflate: true, payload }]))).toThrow();
  }
});

test("hidden, reordered or overlapping local records cannot escape directory coverage", () => {
  const zip = stored(), central = firstCentral(zip), end = zip.length - 22;
  const gap = Buffer.concat([Buffer.from([0]), zip.subarray(0, central), zip.subarray(central)]);
  gap.writeUInt32LE(central + 1, gap.length - 6);
  for (let at = central + 1; at < end + 1;) {
    gap.writeUInt32LE(gap.readUInt32LE(at + 42) + 1, at + 42); at += 46 + gap.readUInt16LE(at + 28);
  }
  expect(() => packedFiles(gap)).toThrow();
  const secondCentral = central + 46 + zip.readUInt16LE(central + 28);
  expect(() => packedFiles(mutate(data => { data.writeUInt32LE(0, secondCentral + 42); }))).toThrow();
});

test("fixed modern encoder is deterministic; unhelpful or excessive compression uses STORE", () => {
  const limits = loadSupportMatrix().limits;
  const input = [...entries.map(({ path, bytes }) => ({ path, bytes })), { path: "assets/repetitive", bytes: Buffer.alloc(10000, 65) }];
  const first = writePackageZip(input, "deflate", limits), second = writePackageZip(input, "deflate", limits);
  expect(first).toEqual(second);
  expect(writePackageZip(input, "store", limits)).toEqual(writeZip(input));
  expect(packedFiles(first)).toEqual(packedFiles(writeZip(input)));
  const methods = new Map<string, number>();
  for (let at = firstCentral(first); at < first.length - 22;) {
    const length = first.readUInt16LE(at + 28);
    methods.set(first.subarray(at + 46, at + 46 + length).toString("utf8"), first.readUInt16LE(at + 10)); at += 46 + length;
  }
  expect(methods.get("assets/content.txt")).toBe(8);
  expect(methods.get("assets/empty")).toBe(0);
  expect(methods.get("assets/raw")).toBe(0);
  expect(methods.get("assets/repetitive")).toBe(0);
  expect(createHash("sha256").update(first).digest("hex")).toBe("be099fd1ca49c1b7cf9df9e6a2663c8fd8da5250a00eca5530508f00e3c31745");
});

test("CLI rejects empty/duplicate/misplaced compression and empty explicit SOURCE input", () => {
  const cli = join(import.meta.dir, "../src/cli.ts");
  for (const args of [
    ["pack", "unused", "--out", "out.reaiapp", "--compression", ""],
    ["pack", "unused", "--out", "out.reaiapp", "--compression", "deflate", "--compression", "store"],
    ["validate", "unused", "--compression", "deflate"],
    ["build", "unused", "--compression", "deflate"],
    ["pack", "unused", "--out", "out.reaiapp", "--source-review", ""],
    ["validate", "unused", "--source-review", ""],
    ["build", "unused", "--source-review", ""],
    ["pack", "unused", "--out", ""],
    ["pack", "unused", "--out", "out.reaiapp", "--compression=deflate"],
  ]) {
    const result = Bun.spawnSync([process.execPath, cli, ...args]);
    expect(result.exitCode).toBe(1); expect(result.stderr.toString()).toContain("reai-app-i18n");
  }
});
