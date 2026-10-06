import { deflateSync, brotliCompressSync } from "node:zlib";
export const PDF_BUDGET_MARKER = "SYNTHETIC_BRIEF_MARKER";
const text = Buffer.from(`BT /F1 12 Tf 72 720 Td (${PDF_BUDGET_MARKER}) Tj ET\n`);
const font = Buffer.from(`<< /Type /Font /Subtype /Type3 /FontBBox [0 0 600 1000] /FontMatrix [0.001 0 0 0.001 0 0] /FirstChar 32 /LastChar 95 /Widths [${Array(64).fill(600).join(" ")}] /Encoding /WinAnsiEncoding /CharProcs << ${[...new Set(PDF_BUDGET_MARKER.replaceAll("_", ""))].sort().map(name => `/${name} 6 0 R`).join(" ")} /underscore 6 0 R >> /Resources << >> >>`);
const glyph = Buffer.from("600 0 d0\n");
const stream = (bytes: Uint8Array, attributes = "") => Buffer.concat([Buffer.from(`<< /Length ${bytes.length} ${attributes} >>\nstream\n`), bytes, Buffer.from("\nendstream")]);
function encode(bytes: Buffer, filter: string) {
  if (filter === "FlateDecode") return deflateSync(bytes, { level: 9 });
  if (filter === "BrotliDecode") return brotliCompressSync(bytes);
  if (filter === "ASCIIHexDecode") return Buffer.from(bytes.toString("hex") + ">");
  if (filter === "ASCII85Decode") {
    let result = "";
    for (let offset = 0; offset < bytes.length; offset += 4) {
      const count = Math.min(4, bytes.length - offset); let word = 0;
      for (let index = 0; index < 4; index++) word = word * 256 + (bytes[offset + index] ?? 0);
      if (count === 4 && word === 0) { result += "z"; continue; }
      const chars = Array(5); for (let index = 4; index >= 0; index--) { chars[index] = String.fromCharCode(33 + word % 85); word = Math.floor(word / 85); }
      result += chars.slice(0, count + 1).join("");
    }
    return Buffer.from(result + "~>");
  }
  if (filter === "RunLengthDecode") {
    const result: number[] = []; for (let offset = 0; offset < bytes.length; offset += 128) { const chunk = bytes.subarray(offset, offset + 128); result.push(chunk.length - 1, ...chunk); } result.push(128); return Buffer.from(result);
  }
  if (filter === "LZWDecode") {
    // Clear between bytes: a valid fixed-width 9-bit stream, with no fixture dictionary ambiguity.
    const codes = [256]; for (const byte of bytes) codes.push(byte, 256); codes.push(257);
    let word = 0, bits = 0; const output: number[] = [];
    for (const code of codes) { word = word * 512 + code; bits += 9; while (bits >= 8) { bits -= 8; output.push(word >>> bits & 255); word &= (1 << bits) - 1; } }
    if (bits) output.push(word << (8 - bits)); return Buffer.from(output);
  }
  return bytes;
}
export function pdfBudgetFixture(options: { filter?: string; padding?: number; pages?: number; multi?: boolean; predictor?: "png" | "tiff"; toUnicodePadding?: number; image?: boolean; objectStream?: boolean; objectPadding?: number; xrefWide?: boolean } = {}): Buffer {
  const filter = options.filter ?? "FlateDecode", pages = options.pages ?? 1;
  const objects = new Map<number, Buffer>(); let decodedTotal = glyph.length;
  objects.set(1, Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"));
  objects.set(4, font); objects.set(6, stream(glyph));
  let next = 7; const pageRefs: number[] = [];
  for (let index = 0; index < pages; index++) {
    const page = index === 0 ? 3 : next++; pageRefs.push(page);
    const contentIds: number[] = [];
    for (let part = 0; part < (options.multi ? 2 : 1); part++) {
      const id = index === 0 && part === 0 ? 5 : next++; contentIds.push(id);
      let decoded = Buffer.concat([Buffer.alloc(options.padding ?? 0, 32), text]);
      if (options.image) decoded = Buffer.concat([decoded, Buffer.from("q /Im0 Do Q\n")]);
      decodedTotal += decoded.length;
      let params = "";
      if (options.predictor === "png") { params = `/DecodeParms << /Predictor 12 /Columns ${decoded.length} >>`; decoded = Buffer.concat([Buffer.from([0]), decoded]); decodedTotal++; }
      if (options.predictor === "tiff") { params = `/DecodeParms << /Predictor 2 /Columns ${decoded.length} >>`; const delta = Buffer.from(decoded); for (let i = decoded.length - 1; i > 0; i--) delta[i] = decoded[i]! - decoded[i - 1]!; decoded = delta; }
      objects.set(id, stream(encode(decoded, filter), `/Filter /${filter} ${params}`));
    }
    const imageId = options.image ? next++ : 0;
    if (imageId) { const image = Buffer.from([255,216,255,217]); decodedTotal += image.length; objects.set(imageId, stream(image, "/Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /DCTDecode")); }
    objects.set(page, Buffer.from(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> ${imageId ? `/XObject << /Im0 ${imageId} 0 R >>` : ""} >> /Contents ${contentIds.length === 1 ? `${contentIds[0]} 0 R` : `[${contentIds.map(id => `${id} 0 R`).join(" ")}]`} >>`));
  }
  objects.set(2, Buffer.from(`<< /Type /Pages /Kids [${pageRefs.map(id => `${id} 0 R`).join(" ")}] /Count ${pages} >>`));
  if (options.toUnicodePadding !== undefined) {
    const id = next++; const cmap = Buffer.concat([Buffer.alloc(options.toUnicodePadding, 32), Buffer.from("/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CIDSystemInfo << /Registry (Synthetic) /Ordering (Synthetic) /Supplement 0 >> def /CMapName /Synthetic def /CMapType 2 def 1 begincodespacerange <20> <5f> endcodespacerange 1 beginbfrange <20> <5f> <0020> endbfrange endcmap CMapName currentdict /CMap defineresource pop end end")]);
    decodedTotal += cmap.length; objects.set(id, stream(encode(cmap, "FlateDecode"), "/Filter /FlateDecode")); objects.set(4, Buffer.from(font.toString().replace("/Resources << >>", `/ToUnicode ${id} 0 R /Resources << >>`)));
  }
  let objectId = 0;
  if (options.objectStream) {
    objectId = next++; const header = Buffer.from(`4 ${options.objectPadding ?? 0}\n`), payload = Buffer.concat([header, Buffer.alloc(options.objectPadding ?? 0, 32), objects.get(4)!]);
    decodedTotal += payload.length; objects.delete(4); objects.set(objectId, stream(encode(payload, "FlateDecode"), `/Type /ObjStm /N 1 /First ${header.length} /Filter /FlateDecode`));
  }
  const useXrefStream = options.objectStream || options.xrefWide;
  const buffers = [Buffer.from("%PDF-1.7\n")]; const offsets = new Map<number, number>(); let length = buffers[0]!.length;
  for (const [id, object] of [...objects.entries()].sort((a,b) => a[0]-b[0])) { offsets.set(id, length); const bytes = Buffer.concat([Buffer.from(`${id} 0 obj\n`), object, Buffer.from("\nendobj\n")]); buffers.push(bytes); length += bytes.length; }
  const xref = length;
  if (useXrefStream) {
    const xrefId = next++, count = options.xrefWide ? 4 : next, rowBytes = options.xrefWide ? 5000005 : 7;
    const entries = Buffer.alloc(count * rowBytes);
    for (let id = 0; id < count; id++) {
      const offset = id * rowBytes; entries[offset] = id === 0 ? 0 : id === 4 && objectId ? 2 : 1;
      entries.writeUInt32BE(id === 4 && objectId ? objectId : id === xrefId ? xref : offsets.get(id) ?? 0, offset + 1);
      if (!options.xrefWide) entries.writeUInt16BE(id === 0 ? 65535 : 0, offset + 5);
    }
    decodedTotal += entries.length;
    const object = stream(encode(entries, "FlateDecode"), `/Type /XRef /Size ${next} /Root 1 0 R /Index [0 ${count}] /W [1 4 ${rowBytes - 5}] /Filter /FlateDecode`);
    buffers.push(Buffer.concat([Buffer.from(`${xrefId} 0 obj\n`), object, Buffer.from(`\nendobj\nstartxref\n${xref}\n%%EOF\n`)]));
  } else {
    const count = next; const table = Array.from({ length: count }, (_, id) => id === 0 || !offsets.has(id) ? "0000000000 65535 f \n" : `${String(offsets.get(id)).padStart(10,"0")} 00000 n \n`).join("");
    buffers.push(Buffer.from(`xref\n0 ${count}\n${table}trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`));
  }
  if (decodedTotal > 20 * 1024 * 1024) throw new Error(`Fixture exceeds decoded ceiling: ${decodedTotal}`);
  const result = Buffer.concat(buffers); if (result.length > 5 * 1024 * 1024) throw new Error("Fixture exceeds input ceiling"); return result;
}
