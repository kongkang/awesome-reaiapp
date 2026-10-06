import { afterEach, expect, spyOn, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp as frozenBuild, packApp as frozenPack, loadSupportMatrix } from "@reai/app-cli";
import { buildApp, packApp, packedFiles, verifyPackagedResources, validateManifest } from "../src/index";
import { checkPackageEntries, readVerifiedEntries, type PackFinding } from "../src/pack";

const roots: string[] = [];
test("withheld worker capability remains rejected by validate, build and pack", async () => {
  const root = fixture(), path = join(root, "app.manifest.json");
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  manifest.requires.hostCapabilities.push("surface.worker@1");
  writeFileSync(path, JSON.stringify(manifest));
  expect(loadSupportMatrix().hostCapabilities.withheld["surface.worker@1"]).toBeDefined();
  expect(validateManifest(manifest).some(f => f.detail.includes("surface.worker@1"))).toBe(true);
  await expect(buildApp(root, false)).rejects.toThrow();
  await expect(packApp(root, join(root, "blocked.reaiapp"), false)).rejects.toThrow();
  expect(existsSync(join(root, "blocked.reaiapp"))).toBe(false);
});
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "modern-cli-parity-")); roots.push(root);
  mkdirSync(join(root, "src")); mkdirSync(join(root, "assets"));
  cpSync(join(import.meta.dir, "../../contract/manifest-fixtures/valid/minimal-todo.json"), join(root, "app.manifest.json"));
  writeFileSync(join(root, "src/app.ts"), 'import "./app.css"; export { defineApp } from "@reai/app-sdk/v1";');
  writeFileSync(join(root, "src/app.css"), "body { color: red; }");
  writeFileSync(join(root, "assets/raw.bin"), Buffer.from([0, 255, 3]));
  return root;
}

test("ordinary app build manifest and complete archive match frozen CLI byte for byte", async () => {
  const legacy = fixture(), modern = fixture();
  expect((await buildApp(modern, false)).buildManifest).toEqual((await frozenBuild(legacy)).buildManifest);
  await frozenPack(legacy, join(legacy, "out.reaiapp"));
  const result = await packApp(modern, join(modern, "out.reaiapp"), false);
  expect(readFileSync(result.outputPath)).toEqual(readFileSync(join(legacy, "out.reaiapp")));
  expect(readFileSync(join(modern, "dist/app.js"), "utf8")).toContain("@reai/app-sdk/v1");
  expect(packedFiles(readFileSync(result.outputPath)).has("dist/app.css")).toBe(true);
});

test("explicit Deflate builds twice identically and preserves every packaged resource", async () => {
  const root = fixture();
  const stored = await packApp(root, join(root, "store.reaiapp"), false);
  const compressed = await packApp(root, join(root, "deflate.reaiapp"), false, undefined, { compression: "deflate" });
  const repeated = await packApp(root, join(root, "repeat.reaiapp"), false, undefined, { compression: "deflate" });
  const bytes = readFileSync(compressed.outputPath);
  expect(bytes.length).toBeLessThan(stored.bytes);
  expect(bytes).toEqual(readFileSync(repeated.outputPath));
  expect(packedFiles(bytes)).toEqual(packedFiles(readFileSync(stored.outputPath)));
});

test("skin build and archive retain frozen schema/token validation and exact bytes", async () => {
  const legacy = fixture(), modern = fixture();
  for (const root of [legacy, modern]) {
    const source = join(import.meta.dir, "../../../examples/skins/codex");
    cpSync(join(source, "app.manifest.json"), join(root, "app.manifest.json"));
    cpSync(join(source, "skin"), join(root, "skin"), { recursive: true });
    if (existsSync(join(source, "assets"))) cpSync(join(source, "assets"), join(root, "assets"), { recursive: true });
  }
  expect((await buildApp(modern, false)).buildManifest).toEqual((await frozenBuild(legacy)).buildManifest);
  await frozenPack(legacy, join(legacy, "out.reaiapp")); await packApp(modern, join(modern, "out.reaiapp"), false);
  expect(readFileSync(join(modern, "out.reaiapp"))).toEqual(readFileSync(join(legacy, "out.reaiapp")));
  const skinPath = join(modern, "skin/skin.json"), skin = JSON.parse(readFileSync(skinPath, "utf8"));
  skin.tokens.light.accent = "url(https://bad.invalid)"; writeFileSync(skinPath, JSON.stringify(skin));
  await expect(buildApp(modern, false)).rejects.toThrow("Skin");
});

test("manifest mutation during bundling fails even for otherwise valid identity and preserves output", async () => {
  const root = fixture(), path = join(root, "app.manifest.json"), output = join(root, "out.reaiapp");
  writeFileSync(output, "previous-approved-output");
  const spawn = Bun.spawn;
  const hook = spyOn(Bun, "spawn").mockImplementation(((...args: any[]) => {
    const manifest = JSON.parse(readFileSync(path, "utf8")); manifest.version = "9.9.9";
    writeFileSync(path, JSON.stringify(manifest)); return (spawn as any)(...args);
  }) as typeof Bun.spawn);
  try { await expect(packApp(root, output, false)).rejects.toThrow("Manifest changed"); }
  finally { hook.mockRestore(); }
  expect(readFileSync(output, "utf8")).toBe("previous-approved-output");
});

test("unsafe source or output symlinks are rejected before cleanup", async () => {
  const root = fixture(), outside = fixture();
  symlinkSync(outside, join(root, "dist"));
  await expect(buildApp(root, false)).rejects.toThrow("Symlink");
  expect(existsSync(join(outside, "app.manifest.json"))).toBe(true);
  rmSync(join(root, "dist"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ reaiApp: { entry: "../outside.ts" } }));
  await expect(buildApp(root, false)).rejects.toThrow("Unsafe path");
});

test("build manifest symlink cannot overwrite an outside file", async () => {
  const root = fixture(), outside = fixture(), sentinel = join(outside, "sentinel.txt");
  writeFileSync(sentinel, "do-not-overwrite");
  symlinkSync(sentinel, join(root, "build-manifest.json"));
  await expect(buildApp(root, false)).rejects.toThrow("Symlink");
  expect(readFileSync(sentinel, "utf8")).toBe("do-not-overwrite");
});

test("size, digest, whitelist and duplicate evidence fail closed", async () => {
  const root = fixture(), built = await buildApp(root, false);
  const original = readFileSync(join(root, "assets/raw.bin"));
  writeFileSync(join(root, "assets/raw.bin"), Buffer.from([3, 2, 1]));
  expect(() => readVerifiedEntries(root, built.buildManifest)).toThrow("内容");
  writeFileSync(join(root, "assets/raw.bin"), Buffer.from([3]));
  expect(() => readVerifiedEntries(root, built.buildManifest)).toThrow("大小");
  writeFileSync(join(root, "assets/raw.bin"), original);
  const result = await packApp(root, join(root, "out.reaiapp"), false);
  const base = packedFiles(readFileSync(result.outputPath));
  const extra = new Map(base); extra.set("extra", new Uint8Array());
  expect(() => verifyPackagedResources(extra)).toThrow("whitelist");
  const missing = new Map(base); missing.delete("assets/raw.bin");
  expect(() => verifyPackagedResources(missing)).toThrow("mismatch");
  const duplicate = new Map(base), bm = JSON.parse(new TextDecoder().decode(base.get("build-manifest.json")));
  bm.files.push(bm.files[0]); duplicate.set("build-manifest.json", Buffer.from(JSON.stringify(bm)));
  expect(() => verifyPackagedResources(duplicate)).toThrow("mismatch");
});

test("modern limits match frozen golden findings, with additional unsafe-path rejection", () => {
  const limits = { ...loadSupportMatrix().limits, packageEntryCount: 2, packagePathDepth: 2,
    packageSingleFileBytes: 4, packageUncompressedBytes: 6 };
  // Frozen CLI 1.2 findings captured through review; no private source imports.
  const cases: { paths: string[]; bytes: number; expected: PackFinding[] }[] = [
    { paths: ["a", "b", "c"], bytes: 0, expected: [
      { code: "PACKAGE_LIMIT_EXCEEDED", pointer: "package", detail: "条目 3 个，上限 2" },
    ] },
    { paths: ["a/b/c"], bytes: 0, expected: [
      { code: "PACKAGE_LIMIT_EXCEEDED", pointer: "package[a/b/c]", detail: "路径深度 3，上限 2" },
    ] },
    { paths: ["A", "a"], bytes: 0, expected: [
      { code: "PACKAGE_PATH_UNSAFE", pointer: "package[a]", detail: '与条目 "A" 在大小写不敏感/归一化文件系统上同名' },
    ] },
    { paths: ["café", "cafe\u0301"], bytes: 0, expected: [
      { code: "PACKAGE_PATH_UNSAFE", pointer: "package[cafe\u0301]", detail: '与条目 "café" 在大小写不敏感/归一化文件系统上同名' },
    ] },
    { paths: ["large"], bytes: 7, expected: [
      { code: "PACKAGE_LIMIT_EXCEEDED", pointer: "package[large]", detail: "单文件 7 字节，超过上限 4 字节" },
      { code: "PACKAGE_LIMIT_EXCEEDED", pointer: "package", detail: "解压总量 7 字节，超过上限 6 字节" },
    ] },
  ];
  for (const { paths, bytes, expected } of cases) {
    expect(checkPackageEntries(paths.map(path => ({ path, bytes: Buffer.alloc(bytes) })), limits)).toEqual(expected);
  }
  for (const path of ["../escape", "/root", "a\\b", "a//b", "a/./b", "C:drive", "nul\u0000"]) {
    expect(checkPackageEntries([{ path, bytes: Buffer.alloc(0) }], limits).map(f => f.code)).toContain("PACKAGE_PATH_UNSAFE");
  }
});
