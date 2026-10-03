import { describe, expect, test } from "bun:test";
import { loadSupportMatrix, type MatrixLimits } from "../src/assets";
import { checkPackageEntries, type ZipEntry } from "../src/pack";

/**
 * pack 预检与 Host 解包限额（install.rs unpack_archive）的对齐测试。
 *
 * 这里守的是「CLI pack 放行的包，Host 装得进去」：任何一侧改限额语义，
 * 先在这里红一次，防止回到「pack 零警告、装机才拒收」的旧状态。
 */

const entry = (path: string, size = 8): ZipEntry => ({ path, bytes: Buffer.alloc(size, 1) });

/** 缩小数值便于触发；比例关系与真实矩阵一致（单文件 < 总量 < zip）。 */
const tinyLimits = (): MatrixLimits => ({
  ...loadSupportMatrix().limits,
  packageEntryCount: 3,
  packagePathDepth: 3,
  packageSingleFileBytes: 100,
  packageUncompressedBytes: 200,
});

describe("pack 限额预检", () => {
  test("正常小包在真实矩阵限额下零发现", () => {
    const findings = checkPackageEntries(
      [entry("app.manifest.json"), entry("dist/app.js"), entry("assets/icon.png")],
      loadSupportMatrix().limits,
    );
    expect(findings).toEqual([]);
  });

  test("条目数超限", () => {
    const entries = [entry("a"), entry("b"), entry("c"), entry("d")];
    const findings = checkPackageEntries(entries, tinyLimits());
    expect(findings.map((f) => f.code)).toContain("PACKAGE_LIMIT_EXCEEDED");
    expect(findings.some((f) => f.detail.includes("条目 4 个"))).toBe(true);
  });

  test("路径深度超限", () => {
    const findings = checkPackageEntries([entry("a/b/c/d.txt")], tinyLimits());
    expect(findings.some((f) => f.detail.includes("路径深度 4"))).toBe(true);
  });

  test("大小写冲突（Icon.png vs icon.png）按 PACKAGE_PATH_UNSAFE 拒", () => {
    const findings = checkPackageEntries(
      [entry("assets/Icon.png"), entry("assets/icon.png")],
      tinyLimits(),
    );
    expect(findings.map((f) => f.code)).toContain("PACKAGE_PATH_UNSAFE");
  });

  test("NFC 归一冲突（组合字符 vs 预组字符）按 PACKAGE_PATH_UNSAFE 拒", () => {
    // "\u00e9" 的两种编码：U+00E9 与 e + U+0301，在做归一化的文件系统上是同一个文件。
    const composed = "assets/caf\u00e9.txt";
    const decomposed = "assets/cafe\u0301.txt";
    expect(composed).not.toBe(decomposed);
    const findings = checkPackageEntries([entry(composed), entry(decomposed)], tinyLimits());
    expect(findings.map((f) => f.code)).toContain("PACKAGE_PATH_UNSAFE");
  });

  test("单文件与解压总量超限", () => {
    const findings = checkPackageEntries(
      [entry("big.bin", 150), entry("more.bin", 90)],
      tinyLimits(),
    );
    const details = findings.map((f) => f.detail).join("\n");
    expect(details).toContain("单文件 150 字节");
    expect(details).toContain("解压总量 240 字节");
  });
});
