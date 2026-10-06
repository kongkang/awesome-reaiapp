/** Normalized ZIP32 for modern packages. The frozen STORE writer remains unchanged. */
import { inflateRawSync } from "node:zlib";
import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, sep } from "node:path";
import { crc32, loadSupportMatrix, PackError, writeZip } from "@reai/app-cli";
import { isSafePackagePath } from "./paths";
import type { ZipEntry } from "./pack";

export type Compression = "store" | "deflate";
export interface PackOptions { compression?: Compression }
type Limits = ReturnType<typeof loadSupportMatrix>["limits"];

/** Resolve the same CJS codec used by the writer, including installed CLI copies. */
export function resolveDeflateCodec(from: string | URL = import.meta.url) {
  const codecRequire = createRequire(from);
  let metadataPath: string, entryPath: string;
  try {
    metadataPath = realpathSync(codecRequire.resolve("fflate/package.json"));
    entryPath = realpathSync(codecRequire.resolve("fflate"));
  } catch {
    throw new PackError("Deflate requires fflate 0.8.3; dependency missing or inaccessible. Reinstall the pinned CLI dependencies.");
  }
  let metadata: { name?: unknown; version?: unknown };
  try { metadata = JSON.parse(readFileSync(metadataPath, "utf8")); }
  catch { throw new PackError("Deflate requires fflate 0.8.3; invalid package metadata at " + metadataPath); }
  if (!metadata || metadata.name !== "fflate" || metadata.version !== "0.8.3") {
    throw new PackError("Deflate requires fflate 0.8.3; found " + String(metadata?.version)
      + " (package " + String(metadata?.name) + ") at " + metadataPath + ". Reinstall the pinned CLI dependencies.");
  }
  if (!entryPath.startsWith(dirname(metadataPath) + sep)) {
    throw new PackError("Deflate requires fflate 0.8.3; resolved entry is outside its package: " + entryPath);
  }
  return { metadataPath, entryPath, root: dirname(metadataPath), version: "0.8.3" as const };
}

/** Do not make legacy STORE consumers load an encoder they never requested. */
function loadDeflater(): (typeof import("fflate"))["deflateSync"] {
  const { entryPath, root } = resolveDeflateCodec();
  const codecRequire = createRequire(import.meta.url);
  // A reused API must execute the same current bytes that review inputs record.
  for (const key of Object.keys(codecRequire.cache)) {
    if (key === root || key.startsWith(root + sep)) delete codecRequire.cache[key];
  }
  let codec: { deflateSync?: unknown };
  try { codec = codecRequire(entryPath); }
  catch { throw new PackError("Deflate requires fflate 0.8.3; cannot load the pinned entry at " + entryPath); }
  if (typeof codec?.deflateSync !== "function") {
    throw new PackError("Deflate requires fflate 0.8.3; resolved entry has no deflateSync at " + entryPath);
  }
  return codec.deflateSync as (typeof import("fflate"))["deflateSync"];
}

export function parseCompression(value?: string): Compression {
  if (value === undefined || value === "store") return "store";
  if (value === "deflate") return "deflate";
  throw new PackError("--compression must be store or deflate");
}

/** Caller validates resources and sorts paths. Pure JS encoder version/parameters are pinned. */
export function writePackageZip(entries: ZipEntry[], compression: Compression, limits: Limits): Buffer {
  if (parseCompression(compression) === "store") return writeZip(entries);
  const deflateSync = loadDeflater();
  const locals: Buffer[] = [], centrals: Buffer[] = [];
  let offset = 0;
  for (const { path, bytes } of entries) {
    const name = Buffer.from(path, "utf8"), compressed = Buffer.from(deflateSync(bytes, { level: 9, mem: 8 }));
    const useDeflate = compressed.length < bytes.length
      && Math.floor(bytes.length / Math.max(1, compressed.length)) <= limits.packageMaxCompressionRatio;
    const payload = useDeflate ? compressed : bytes, method = useDeflate ? 8 : 0, crc = crc32(bytes);
    const local = Buffer.alloc(30), central = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8); local.writeUInt16LE(0x0021, 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18); local.writeUInt32LE(bytes.length, 22); local.writeUInt16LE(name.length, 26);
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8); central.writeUInt16LE(method, 10); central.writeUInt16LE(0x0021, 14);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(payload.length, 20); central.writeUInt32LE(bytes.length, 24);
    central.writeUInt16LE(name.length, 28); central.writeUInt32LE((0o100644 << 16) >>> 0, 38); central.writeUInt32LE(offset, 42);
    locals.push(local, name, payload); centrals.push(central, name); offset += local.length + name.length + payload.length;
  }
  const directory = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const invalid = (detail: string): never => { throw new PackError(`Invalid package: ${detail}`); };
const limited = (detail: string): never => { throw new PackError(`PACKAGE_LIMIT_EXCEEDED: ${detail}`); };

/** Bounded reader for the normalized STORE/Deflate format emitted by the official tools. */
export function readPackageZip(zip: Buffer, limits: Limits = loadSupportMatrix().limits): Map<string, Uint8Array> {
  if (zip.length > limits.packageZipBytes) limited("archive bytes");
  const end = zip.length - 22;
  if (end < 0 || zip.readUInt32LE(end) !== 0x06054b50 || zip.readUInt16LE(end + 20) !== 0) invalid("directory end");
  const count = zip.readUInt16LE(end + 10), directorySize = zip.readUInt32LE(end + 12), directoryStart = zip.readUInt32LE(end + 16);
  if (zip.readUInt16LE(end + 4) !== 0 || zip.readUInt16LE(end + 6) !== 0
    || zip.readUInt16LE(end + 8) !== count || count === 0 || count === 0xffff
    || directorySize === 0xffffffff || directoryStart === 0xffffffff || directoryStart + directorySize !== end) invalid("directory bounds");
  if (count > limits.packageEntryCount) limited("entry count");

  const files = new Map<string, Uint8Array>(), names = new Set<string>();
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  let at = directoryStart, localAt = 0, total = 0;
  for (let index = 0; index < count; index++) {
    if (at + 46 > end || zip.readUInt32LE(at) !== 0x02014b50) invalid("central header");
    const flags = zip.readUInt16LE(at + 8), method = zip.readUInt16LE(at + 10), crc = zip.readUInt32LE(at + 16);
    const compressedSize = zip.readUInt32LE(at + 20), size = zip.readUInt32LE(at + 24), nameLength = zip.readUInt16LE(at + 28);
    const attributes = zip.readUInt32LE(at + 38), mode = (attributes >>> 16) & 0o170000;
    if (zip.readUInt16LE(at + 6) > 20 || flags !== 0x0800 || ![0, 8].includes(method)
      || zip.readUInt16LE(at + 30) !== 0 || zip.readUInt16LE(at + 32) !== 0 || zip.readUInt16LE(at + 34) !== 0
      || (mode !== 0 && mode !== 0o100000) || (attributes & 0x10) !== 0) invalid("unsupported entry format");
    if (compressedSize === 0xffffffff || size === 0xffffffff || at + 46 + nameLength > end) invalid("entry bounds");
    const nameBytes = zip.subarray(at + 46, at + 46 + nameLength);
    let name: string;
    try { name = decoder.decode(nameBytes); } catch { return invalid("filename UTF-8"); }
    const key = name.toLowerCase().normalize("NFC");
    // Host checks every archive entry for its reserved namespace and encoded separators.
    if (!isSafePackagePath(name) || name.split("/")[0] === "__host"
      || /%(?:2f|2e|5c)/i.test(name) || names.has(key)) invalid("unsafe or duplicate path");
    names.add(key);
    if (name.split("/").length > limits.packagePathDepth) limited("path depth");
    total += size;
    if (size > limits.packageSingleFileBytes || total > limits.packageUncompressedBytes) limited("expanded bytes");
    if (Math.floor(size / Math.max(1, compressedSize)) > limits.packageMaxCompressionRatio) limited("compression ratio");

    if (zip.readUInt32LE(at + 42) !== localAt || localAt + 30 + nameLength > directoryStart
      || zip.readUInt32LE(localAt) !== 0x04034b50 || zip.readUInt16LE(localAt + 4) !== zip.readUInt16LE(at + 6)
      || zip.readUInt16LE(localAt + 6) !== flags || zip.readUInt16LE(localAt + 8) !== method
      || zip.readUInt32LE(localAt + 14) !== crc || zip.readUInt32LE(localAt + 18) !== compressedSize
      || zip.readUInt32LE(localAt + 22) !== size || zip.readUInt16LE(localAt + 26) !== nameLength
      || zip.readUInt16LE(localAt + 28) !== 0
      || !zip.subarray(localAt + 30, localAt + 30 + nameLength).equals(nameBytes)) invalid("local/central mismatch");
    const start = localAt + 30 + nameLength;
    if (start + compressedSize > directoryStart) invalid("payload bounds");
    const payload = zip.subarray(start, start + compressedSize);
    let bytes: Buffer;
    if (method === 0) {
      if (compressedSize !== size) invalid("STORE size mismatch");
      bytes = payload;
    } else {
      let inflated: { buffer: Buffer; engine: { bytesWritten: number } };
      try {
        // Declared output is already bounded by both the single and remaining total budgets.
        inflated = inflateRawSync(payload, { maxOutputLength: Math.max(1, size), info: true }) as unknown as
          { buffer: Buffer; engine: { bytesWritten: number } };
      } catch { return invalid("Deflate stream or output limit"); }
      if (!Buffer.isBuffer(inflated.buffer) || inflated.engine.bytesWritten !== compressedSize) invalid("Deflate trailing input");
      bytes = inflated.buffer;
    }
    if (bytes.length !== size || crc32(bytes) !== crc) invalid("resource size or CRC");
    files.set(name, bytes); localAt = start + compressedSize; at += 46 + nameLength;
  }
  if (at !== end || localAt !== directoryStart || !files.has("app.manifest.json")) invalid("directory coverage or manifest");
  return files;
}
