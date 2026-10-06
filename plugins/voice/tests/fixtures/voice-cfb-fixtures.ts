/** Small synthetic containers for chain validation. These are not BIFF8 workbooks. */
export function cfbFixture(sectors = 4, sectorSize = 512): Uint8Array {
  const bytes = new Uint8Array((sectors + 1) * sectorSize);
  const view = new DataView(bytes.buffer);
  bytes.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  view.setUint16(24, 0x3e, true); view.setUint16(26, sectorSize === 512 ? 3 : 4, true);
  view.setUint16(28, 0xfffe, true); view.setUint16(30, sectorSize === 512 ? 9 : 12, true); view.setUint16(32, 6, true);
  view.setUint32(40, sectorSize === 4096 ? 1 : 0, true);
  view.setUint32(44, 1, true); view.setInt32(48, 1, true); view.setUint32(56, 4096, true);
  view.setInt32(60, -2, true); view.setInt32(68, -2, true);
  for (let i = 0; i < 109; i++) view.setInt32(76 + i * 4, i === 0 ? 0 : -1, true);
  for (let i = 0; i < sectorSize / 4; i++) view.setInt32(sectorSize + i * 4, -1, true);
  setFat(bytes, 0, -3); setFat(bytes, 1, -2);
  for (let i = 2; i < Math.min(sectors, sectorSize / 4); i++) setFat(bytes, i, -2);
  setDirectory(bytes, 0, 5, -2, 0);
  return bytes;
}
export const sectorSizeOf = (bytes: Uint8Array) => 2 ** new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(30, true);
export function setFat(bytes: Uint8Array, index: number, next: number): void {
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setInt32(sectorSizeOf(bytes) + index * 4, next, true);
}
export function setDirectory(bytes: Uint8Array, entry: number, type: number, start: number, size: number): void {
  const at = sectorSizeOf(bytes) * 2 + entry * 128;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const name = type === 5 ? "Root Entry" : "Workbook";
  [...name + "\0"].forEach((char, i) => view.setUint16(at + i * 2, char.charCodeAt(0), true));
  view.setUint16(at + 64, (name.length + 1) * 2, true); bytes[at + 66] = type; bytes[at + 67] = 1;
  view.setInt32(at + 68, -1, true); view.setInt32(at + 72, -1, true); view.setInt32(at + 76, type === 5 ? 1 : -1, true);
  view.setInt32(at + 116, start, true); view.setInt32(at + 120, size, true);
}
export function invalidCfbFixtures(): { name: string; bytes: Uint8Array }[] {
  const cases: { name: string; bytes: Uint8Array }[] = [];
  const add = (name: string, mutate: (bytes: Uint8Array, view: DataView) => void, sectors = 4) => {
    const bytes = cfbFixture(sectors); mutate(bytes, new DataView(bytes.buffer)); cases.push({ name, bytes });
  };
  add("uncached interior self-cycle", bytes => { setFat(bytes, 2, 3); setFat(bytes, 3, 3); setDirectory(bytes, 1, 2, 3, 4096); });
  add("two-sector cycle", bytes => { setFat(bytes, 2, 3); setFat(bytes, 3, 2); setDirectory(bytes, 1, 2, 3, 4096); });
  add("out-of-range FAT next", bytes => setFat(bytes, 3, 4));
  add("unknown FAT terminal", bytes => setFat(bytes, 3, -5));
  for (const type of [0, 1, 2, 7]) add(`non-root type ${type} outside physical sectors`, bytes => { setDirectory(bytes, 1, type, 8, 4096); setFat(bytes, 8, 8); });
  add("DIFAT self-cycle", (bytes, view) => {
    view.setInt32(68, 2, true); view.setUint32(72, 1, true);
    for (let at = 1536; at < 2048; at += 4) view.setInt32(at, -1, true);
    view.setInt32(2044, 2, true); setFat(bytes, 2, -4);
  });
  add("DIFAT out-of-range", (_bytes, view) => { view.setInt32(68, 8, true); view.setUint32(72, 1, true); });
  add("DIFAT count exceeds physical sectors", (_bytes, view) => { view.setInt32(68, 2, true); view.setUint32(72, 5, true); });
  add("header FAT hole cannot be filled by later slot", (_bytes, view) => { view.setUint32(44, 2, true); view.setInt32(80, -1, true); view.setInt32(84, 2, true); }, 130);
  add("duplicate required FAT page", (_bytes, view) => { view.setUint32(44, 2, true); view.setInt32(80, 0, true); }, 130);
  add("FAT declaration under-covers physical sectors", () => {}, 130);
  for (const first of [-1, -2]) add(`required DIFAT page starts with ${first}`, (bytes, view) => {
    view.setUint32(44, 2, true); view.setInt32(68, 2, true); view.setUint32(72, 1, true);
    for (let at = 1536; at < 2048; at += 4) view.setInt32(at, -1, true);
    view.setInt32(1536, first, true); view.setInt32(1540, 3, true); view.setInt32(2044, -2, true);
    setFat(bytes, 2, -4); setFat(bytes, 3, -3);
  }, 130);
  add("directory points outside physical sectors", (_bytes, view) => view.setInt32(48, 8, true));
  add("directory chain does not end with END", bytes => setFat(bytes, 1, -1));
  for (const role of ["FAT", "DIFAT", "directory"] as const) {
    const bytes = cfbFixture(); const view = new DataView(bytes.buffer);
    if (role === "FAT") view.setInt32(76, 3, true);
    if (role === "DIFAT") { view.setInt32(68, 3, true); view.setUint32(72, 1, true); }
    if (role === "directory") view.setInt32(48, 3, true);
    cases.push({ name: `short final ${role} sector`, bytes: bytes.slice(0, bytes.length - 1) });
  }
  for (const size of [0, 8, 511]) cases.push({ name: `short header ${size}`, bytes: cfbFixture().slice(0, size) });
  add("wrong sector shift", (_bytes, view) => view.setUint16(30, 12, true));
  return cases;
}
