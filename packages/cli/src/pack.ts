/**
 * `reai-app pack` —— 产出归一化的 `.reaiapp`。
 *
 * ## 为什么要自己写 zip 而不调系统的
 *
 * 包身份 `archiveDigest` 是这个文件**精确字节**的 SHA-256。系统 zip 会写入当前时间、
 * 当前 umask、当前平台的路径分隔符，于是同一份源码在两台机器上打出两个不同的摘要——
 * 「这两个包是不是同一个」就永远回答不了。所以三样东西全部固定：
 *
 * - entry 顺序：按路径字典序；
 * - mtime：固定为 1980-01-01（DOS 时间戳的下界）；
 * - mode / external attributes：固定 0644。
 *
 * ## 为什么不压缩
 *
 * deflate 的输出依赖 zlib 版本。zlib 换个版本，同样的输入就可能压出不同的字节，
 * archiveDigest 随之变化——而包内容一个字都没改。存储（method 0）没有这个问题：
 * 输入相同则输出逐字节相同，跨机器、跨年份都成立。代价是包大一些，而首版的 App
 * 包本来就只有几百 KB，用可复现性换这点体积是划算的。
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadSupportMatrix, type MatrixLimits } from "./assets";
import { BUILD_MANIFEST_NAME, buildApp, type BuildManifestV1 } from "./build";

export interface PackResult {
  outputPath: string;
  archiveDigest: string;
  entryCount: number;
  bytes: number;
}

export class PackError extends Error {}

/** pack 预检发现的问题；code 取 Host 安装侧同名稳定错误码。 */
export interface PackFinding {
  code: "PACKAGE_LIMIT_EXCEEDED" | "PACKAGE_PATH_UNSAFE";
  pointer: string;
  detail: string;
}

/**
 * 打包前按 Host 解包限额预检。
 *
 * 语义对齐 `src-tauri/src/apps/install.rs` 的 `unpack_archive`（条目数、路径深度、
 * 单文件、解压总量、大小写/NFC 冲突键），改一侧必须同步另一侧。没有这道预检时，
 * 超限的包在 pack 阶段零警告、装进 Host 才报错——开发者会以为是 Host 坏了。
 *
 * 压缩比那道闸这里不用检查：pack 只写 store（不压缩），比值恒为 1。
 * Rust 侧遇到第一个violation即中止；这里把全部问题一次列完，便于一轮修完。
 */
export function checkPackageEntries(entries: ZipEntry[], limits: MatrixLimits): PackFinding[] {
  const findings: PackFinding[] = [];
  if (entries.length > limits.packageEntryCount) {
    findings.push({
      code: "PACKAGE_LIMIT_EXCEEDED",
      pointer: "package",
      detail: `条目 ${entries.length} 个，上限 ${limits.packageEntryCount}`,
    });
  }

  // 冲突检测键：小写 + NFC 归一，与 install.rs 的 collision_key 同构。
  const seen = new Map<string, string>();
  let totalBytes = 0;

  for (const entry of entries) {
    const pointer = `package[${entry.path}]`;

    const depth = entry.path.split("/").length;
    if (depth > limits.packagePathDepth) {
      findings.push({
        code: "PACKAGE_LIMIT_EXCEEDED",
        pointer,
        detail: `路径深度 ${depth}，上限 ${limits.packagePathDepth}`,
      });
    }

    const key = entry.path.toLowerCase().normalize("NFC");
    const previous = seen.get(key);
    if (previous === undefined) {
      seen.set(key, entry.path);
    } else {
      findings.push({
        code: "PACKAGE_PATH_UNSAFE",
        pointer,
        detail: `与条目 ${JSON.stringify(previous)} 在大小写不敏感/归一化文件系统上同名`,
      });
    }

    if (entry.bytes.byteLength > limits.packageSingleFileBytes) {
      findings.push({
        code: "PACKAGE_LIMIT_EXCEEDED",
        pointer,
        detail: `单文件 ${entry.bytes.byteLength} 字节，超过上限 ${limits.packageSingleFileBytes} 字节`,
      });
    }
    totalBytes += entry.bytes.byteLength;
  }

  if (totalBytes > limits.packageUncompressedBytes) {
    findings.push({
      code: "PACKAGE_LIMIT_EXCEEDED",
      pointer: "package",
      detail: `解压总量 ${totalBytes} 字节，超过上限 ${limits.packageUncompressedBytes} 字节`,
    });
  }
  return findings;
}

function throwIfViolated(findings: PackFinding[]): void {
  if (findings.length === 0) return;
  const lines = findings.map((f) => `  [${f.code}] ${f.pointer}: ${f.detail}`);
  throw new PackError(
    ["包超出 Host 安装限额（host-support-matrix.json limits），安装时会被拒收：", ...lines].join(
      "\n",
    ),
  );
}

/**
 * 打包。
 *
 * **总是先重新构建**再打包，然后拿 Build Manifest 逐条复核磁盘上的文件。
 * 不比对 mtime 判断「要不要重建」：mtime 在 CI、容器、git checkout 之间不可靠，
 * 一次误判就会把旧产物封进包里，而包外面看不出任何异样。
 */
export async function packApp(appDirectory: string, outputPath: string): Promise<PackResult> {
  const root = resolve(appDirectory);
  await buildApp(root);

  const buildManifest = JSON.parse(
    readFileSync(join(root, BUILD_MANIFEST_NAME), "utf8"),
  ) as BuildManifestV1;

  const entries = readVerifiedEntries(root, buildManifest);

  entries.push({
    path: BUILD_MANIFEST_NAME,
    bytes: readFileSync(join(root, BUILD_MANIFEST_NAME)),
  });
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const limits = loadSupportMatrix().limits;
  const findings = checkPackageEntries(entries, limits);

  const archive = writeZip(entries);
  if (archive.byteLength > limits.packageZipBytes) {
    findings.push({
      code: "PACKAGE_LIMIT_EXCEEDED",
      pointer: "package",
      detail: `包文件 ${archive.byteLength} 字节，上限 ${limits.packageZipBytes}`,
    });
  }
  throwIfViolated(findings);

  const output = resolve(outputPath);
  writeFileSync(output, archive);

  return {
    outputPath: output,
    archiveDigest: createHash("sha256").update(archive).digest("hex"),
    entryCount: entries.length,
    bytes: archive.byteLength,
  };
}

export interface ZipEntry {
  path: string;
  bytes: Buffer;
}

/**
 * 按 Build Manifest 逐条读出并复核磁盘上的文件。
 *
 * 清单和产物对不上，说明构建过程里出了事（并发写、磁盘满、中途改文件）。
 * 这时候封包只会把一个"看起来正常、装上去坏掉"的包送出去，所以宁可当场失败。
 */
export function readVerifiedEntries(root: string, buildManifest: BuildManifestV1): ZipEntry[] {
  return buildManifest.files.map((file) => {
    const bytes = readFileSync(join(root, file.path));
    if (bytes.byteLength !== file.size) {
      throw new PackError(
        `${file.path} 大小与 Build Manifest 不符（清单 ${file.size}，磁盘 ${bytes.byteLength}）`,
      );
    }
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (sha256 !== file.sha256) {
      throw new PackError(`${file.path} 内容与 Build Manifest 不符；请重新构建`);
    }
    return { path: file.path, bytes };
  });
}

/** DOS 时间戳的下界：1980-01-01 00:00:00。固定它就消除了「打包时间」这个变量。 */
const DOS_DATE = 0x0021;
const DOS_TIME = 0x0000;
/** 固定权限位 0644（Unix 高 16 位）+ 普通文件标志。 */
const EXTERNAL_ATTRS = (0o100644 << 16) >>> 0;

/** 写一个只用 store 方式的归一化 zip。 */
export function writeZip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.path, "utf8");
    const crc = crc32(entry.bytes);
    const size = entry.bytes.byteLength;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // 本地文件头签名
    local.writeUInt16LE(20, 4); // 解压所需版本 2.0
    local.writeUInt16LE(0x0800, 6); // 通用标志位：文件名为 UTF-8
    local.writeUInt16LE(0, 8); // 压缩方法：store
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(size, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.byteLength, 26);
    local.writeUInt16LE(0, 28); // 无 extra field：它是不确定性的常见来源

    locals.push(local, name, entry.bytes);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); // 中央目录项签名
    central.writeUInt16LE(20, 4); // 创建版本
    central.writeUInt16LE(20, 6); // 解压所需版本
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(size, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.byteLength, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // 起始磁盘号
    central.writeUInt16LE(0, 36); // 内部属性
    central.writeUInt32LE(EXTERNAL_ATTRS, 38);
    central.writeUInt32LE(offset, 42);

    centrals.push(central, name);
    offset += local.byteLength + name.byteLength + size;
  }

  const centralBuffer = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuffer.byteLength, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20); // 无注释

  return Buffer.concat([...locals, centralBuffer, end]);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = (CRC_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
