/** Modern pack staging, retaining the immutable public STORE writer by default. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { BUILD_MANIFEST_NAME, PackError, loadSupportMatrix, type BuildManifestV1 } from "@reai/app-cli";
import { parseCompression, writePackageZip, type Compression, type PackOptions } from "./archive";
import { buildApp } from "./build";
import { safeChild, assertSafeTree, isSafePackagePath } from "./paths";
import { assertSourceReviewArchive, type SourceReviewEvidence } from "./source-review-evidence";
type MatrixLimits = ReturnType<typeof loadSupportMatrix>["limits"];

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
 * 压缩比在 ZIP writer 按实际压缩长度检查；超过 Host 门禁的单项保留 STORE。
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
    if (!isSafePackagePath(entry.path)) findings.push({ code: "PACKAGE_PATH_UNSAFE", pointer, detail: "Unsafe package path" });

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

export async function createArchive(appDirectory: string, requireI18n: boolean, sourceReview?: SourceReviewEvidence, options: PackOptions = {}) {
  const compression = parseCompression(options.compression);
  const root = resolve(appDirectory);
  const built = await buildApp(root, requireI18n, sourceReview);

  const result = archiveFromBuild(root, built.buildManifest, compression);
  assertSourceReviewArchive(sourceReview, result.archive);
  return result;
}

/** Internal archive assembly defaults to canonical STORE. It makes no approval decision. */
export function archiveFromBuild(root: string, buildManifest: BuildManifestV1, compression: Compression = "store") {
  const entries = readVerifiedEntries(root, buildManifest);

  entries.push({
    path: BUILD_MANIFEST_NAME,
    bytes: Buffer.from(`${JSON.stringify(buildManifest, null, 2)}\n`),
  });
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const limits = loadSupportMatrix().limits;
  const findings = checkPackageEntries(entries, limits);

  throwIfViolated(findings);
  const archive = writePackageZip(entries, compression, limits);
  if (archive.byteLength > limits.packageZipBytes) {
    findings.push({
      code: "PACKAGE_LIMIT_EXCEEDED",
      pointer: "package",
      detail: `包文件 ${archive.byteLength} 字节，上限 ${limits.packageZipBytes}`,
    });
  }
  throwIfViolated(findings);

  return {
    archive,
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
    assertSafeTree(root, file.path);
    const bytes = readFileSync(safeChild(root, file.path));
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
