/**
 * 工具链端到端：build → contract-test → pack。
 *
 * 用 `fixtures/apps/minimal` 而不是 docs 里的 Todo 样例，是为了让这条测试**自足**：
 * 不依赖文档目录的状态，也不会把构建产物写进文档目录。Todo 样例的全链路由 M8 的
 * 打包 E2E 覆盖。
 */

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildApp, type BuildManifestV1 } from "../src/build";
import { runContractTest } from "../src/contract-test";
import { crc32, packApp, readVerifiedEntries, writeZip } from "../src/pack";
import { validateManifestFile } from "../src/validate";

const appDir = fileURLToPath(new URL("../../fixtures/apps/minimal", import.meta.url));
const workDir = mkdtempSync(join(tmpdir(), "reai-pack-"));

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe("build", () => {
  test("最小 App 通过校验并产出 Build Manifest", async () => {
    expect(validateManifestFile(join(appDir, "app.manifest.json"))).toEqual([]);

    const result = await buildApp(appDir);
    const bm = result.buildManifest;

    expect(bm.buildManifestVersion).toBe(1);
    expect(bm.entry).toBe("dist/app.js");
    expect(bm.files.map((f) => f.path)).toContain("dist/app.js");
    expect(bm.files.map((f) => f.path)).toContain("app.manifest.json");
  });

  test("Build Manifest 里的路径按字典序，摘要与磁盘一致", async () => {
    const result = await buildApp(appDir);
    const paths = result.buildManifest.files.map((f) => f.path);
    expect([...paths].sort()).toEqual(paths);

    for (const file of result.buildManifest.files) {
      const bytes = readFileSync(join(appDir, file.path));
      expect(bytes.byteLength).toBe(file.size);
    }
  });

  test("源码入口不存在时给出可操作的错误", async () => {
    await expect(buildApp(join(appDir, "..", "根本不存在"))).rejects.toThrow(/不存在/);
  });
});

describe("contract-test", () => {
  test("最小 App 合同全绿", async () => {
    const result = await runContractTest({ appDirectory: appDir, hostApi: "1.1" });
    expect(result.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`)).toEqual([]);
    expect(result.passed).toBe(true);
  });

  test("套件声明的 Host API 与命令行要求不符时直接失败", async () => {
    await expect(
      runContractTest({ appDirectory: appDir, hostApi: "2.0" }),
    ).rejects.toThrow(/不符/);
  });
});

describe("pack", () => {
  test("同一份源码两次打包字节完全相同", async () => {
    const a = await packApp(appDir, join(workDir, "a.reaiapp"));
    const b = await packApp(appDir, join(workDir, "b.reaiapp"));

    expect(a.archiveDigest).toBe(b.archiveDigest);
    expect(readFileSync(a.outputPath).equals(readFileSync(b.outputPath))).toBe(true);
  });

  test("包里含 Build Manifest 与入口", async () => {
    const result = await packApp(appDir, join(workDir, "c.reaiapp"));
    expect(existsSync(result.outputPath)).toBe(true);

    const archive = readFileSync(result.outputPath);
    expect(archive.includes("build-manifest.json")).toBe(true);
    expect(archive.includes("dist/app.js")).toBe(true);
  });

  test("摘要与磁盘不符时当场拒绝，不把坏包送出去", async () => {
    const { buildManifest } = await buildApp(appDir);
    const tampered: BuildManifestV1 = {
      ...buildManifest,
      files: buildManifest.files.map((f) =>
        f.path === "dist/app.js" ? { ...f, sha256: "0".repeat(64) } : f,
      ),
    };

    expect(() => readVerifiedEntries(appDir, tampered)).toThrow(/内容与 Build Manifest 不符/);
  });

  test("大小与磁盘不符时同样拒绝", async () => {
    const { buildManifest } = await buildApp(appDir);
    const tampered: BuildManifestV1 = {
      ...buildManifest,
      files: buildManifest.files.map((f) =>
        f.path === "dist/app.js" ? { ...f, size: f.size + 1 } : f,
      ),
    };

    expect(() => readVerifiedEntries(appDir, tampered)).toThrow(/大小与 Build Manifest 不符/);
  });
});

describe("zip 归一化", () => {
  test("同样的输入两次打出同样的字节", () => {
    const entries = [
      { path: "b.txt", bytes: Buffer.from("bbb") },
      { path: "a.txt", bytes: Buffer.from("aaa") },
    ];
    expect(writeZip(entries).equals(writeZip(entries))).toBe(true);
  });

  test("时间戳固定为 1980-01-01，打包时间不进包体", () => {
    const once = writeZip([{ path: "a.txt", bytes: Buffer.from("aaa") }]);
    // 本地文件头：偏移 10 是 DOS 时间，12 是 DOS 日期。
    expect(once.readUInt16LE(10)).toBe(0x0000);
    expect(once.readUInt16LE(12)).toBe(0x0021);
  });

  test("CRC32 与已知值一致", () => {
    // "123456789" 的 CRC-32 是标准测试向量 0xCBF43926。
    expect(crc32(Buffer.from("123456789"))).toBe(0xcbf43926);
  });
});
