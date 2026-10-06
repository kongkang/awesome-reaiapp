import { afterEach, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { buildApp, collectSourceReviewInputs, metadataTargets, packApp, packedFiles, sourceReviewInputsDigest, validateManifestFile, type SourceReviewEvidence } from "../src/index";

const roots: string[] = [];
const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const repository = resolve(import.meta.dir, "../../..");
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });

function fixture() {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "unapproved-review-bytes-"))); roots.push(parent);
  mkdirSync(join(parent, ".git"));
  const root = join(parent, "app"); mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "assets/locales"), { recursive: true });
  const manifest = JSON.parse(readFileSync(join(repository, "packages/contract/manifest-fixtures/valid/minimal-todo.json"), "utf8"));
  Object.assign(manifest, { appId: "com.example.review-bytes", publisherId: "synthetic-review-team", oauthAppId: "synthetic-client", version: "1.0.0-rc.3" });
  manifest.requires.hostCapabilities.push("surface.clipboard@1", "metadata.i18n@1");
  manifest.i18n = { locales: ["zh", "en"], messages: [...metadataTargets(manifest).keys()].map(identity => {
    const [target, id] = identity.split(":"); return { target, ...(id ? { id } : {}), key: "metadata.name" };
  }) };
  for (const lang of ["en", "zh"]) writeFileSync(join(root, `assets/locales/${lang}.json`), '{"metadata":{"name":"Fixture"}}');
  writeFileSync(join(root, "assets/icon.svg"), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  writeFileSync(join(root, "app.manifest.json"), JSON.stringify(manifest));
  writeFileSync(join(root, "src/app.ts"), 'import "./app.css"; export default { activate() {} };\n');
  writeFileSync(join(root, "src/app.css"), "body { color: red; }\n");
  writeFileSync(join(root, "bun.lock"), "synthetic local fixture lock\n");
  mkdirSync(join(root, "node_modules/@reai"), { recursive: true });
  for (const [name, directory] of [["app-i18n-cli", "i18n-cli"], ["app-cli", "cli"], ["app-contract", "contract"]]) {
    symlinkSync(join(repository, "packages", directory!), join(root, "node_modules/@reai", name!));
  }
  return { root, parent, manifest };
}

function pin(root: string) {
  const sourceFiles = collectSourceReviewInputs(root);
  return { schemaVersion: 1 as const, sourceFiles, sourceFilesSha256: sourceReviewInputsDigest(sourceFiles) };
}

async function calculator() {
  // An absent production entry is the expected new-feature RED, not a replacement algorithm.
  return await import("../src/review-bytes");
}

async function invoke(...args: string[]) {
  const proc = Bun.spawn([process.execPath, join(repository, "scripts/source-review-bytes.ts"), ...args], { stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code, stdout, stderr };
}

test("production calculation computes the canonical bytes while every normal unreviewed gate remains denied", async () => {
  const h = fixture(), inputs = pin(h.root), api = await calculator();
  const policyPath = join(repository, "packages/contract/capability-review-policy.seed.json");
  const policyBefore = sha(readFileSync(policyPath));
  const first = await api.calculateReviewBytes(h.root, inputs, Bun.version);
  // Inspect actual ZIP methods independently of calculation metadata and normal pack defaults.
  const end = first.archive.length - 22;
  let central = first.archive.readUInt32LE(end + 16);
  const count = first.archive.readUInt16LE(end + 10);
  for (let index = 0; index < count; index++) {
    expect(first.archive.readUInt32LE(central)).toBe(0x02014b50);
    expect(first.archive.readUInt16LE(central + 10)).toBe(0);
    central += 46 + first.archive.readUInt16LE(central + 28)
      + first.archive.readUInt16LE(central + 30) + first.archive.readUInt16LE(central + 32);
  }
  expect(central).toBe(end);
  const second = await api.calculateReviewBytes(h.root, inputs, Bun.version);
  expect(second.archive).toEqual(first.archive);
  expect(first.calculation).toMatchObject({ status: { validation: "NOT_VALIDATED", approval: "NOT_APPROVED", installation: "NOT_INSTALLABLE", publication: "NOT_PUBLISHED" }, runtimeGrant: false, platformApproval: false, sourceFilesSha256: inputs.sourceFilesSha256, archiveSha256: sha(first.archive) });
  expect(first.calculation.pendingFindings.map(f => f.pointer)).toEqual(["requires.hostCapabilities[5]"]);
  expect(JSON.stringify(first.calculation)).not.toContain("SOURCE_REVIEW_SCOPE");
  expect(first.calculation.toolchain.bunVersion).toBe(Bun.version);
  expect(first.calculation.entries).toHaveLength(first.calculation.entryCount);
  expect(first.calculation.entries.find(f => f.path === "build-manifest.json")?.sha256).toBe(sha(packedFiles(first.archive).get("build-manifest.json")!));
  expect(first.calculation.toolchain.packages["@reai/app-i18n-cli"]!.resolution).toBe("same-content");
  expect(packedFiles(first.archive).has("dist/app.css")).toBeTrue();
  expect(collectSourceReviewInputs(h.root)).toEqual(inputs.sourceFiles);
  expect(validateManifestFile(join(h.root, "app.manifest.json")).map(f => f.code)).toContain("APP_CAPABILITY_NOT_GRANTED");
  await expect(buildApp(h.root)).rejects.toThrow("Manifest 校验");
  await expect(packApp(h.root, join(h.root, "denied.reaiapp"))).rejects.toThrow();
  expect(existsSync(join(h.root, "denied.reaiapp"))).toBeFalse();
  expect(sha(readFileSync(policyPath))).toBe(policyBefore);

  // This approval is synthetic test data. It never leaves this disposable fixture.
  const report = join(h.parent, "test-only-report.md");
  const scope = { purpose: "submission-source-review" as const, appId: h.manifest.appId, publisherId: h.manifest.publisherId, oauthAppId: h.manifest.oauthAppId, version: h.manifest.version, reviewedHostCapabilities: ["surface.clipboard@1"], sourceFilesSha256: inputs.sourceFilesSha256, expectedPackageSha256: sha(first.archive), decision: "approved" };
  writeFileSync(report, `Synthetic test fixture only\nSOURCE_REVIEW_SCOPE=${JSON.stringify(scope)}\n`);
  const evidence: SourceReviewEvidence = { schemaVersion: 1, ...scope, sourceFiles: inputs.sourceFiles, reviewReports: [{ path: report, sha256: sha(readFileSync(report)) }] };
  const normal = await packApp(h.root, join(h.root, "normal.reaiapp"), true, evidence);
  expect(readFileSync(normal.outputPath)).toEqual(first.archive);
});

test.each(["missing", "added", "changed", "invalid-hash", "invalid-digest"])("complete input pin rejects %s coverage", async mode => {
  const h = fixture(), inputs = pin(h.root), api = await calculator();
  if (mode === "missing") delete inputs.sourceFiles["src/app.css"];
  if (mode === "added") writeFileSync(join(h.root, "additional.txt"), "new input");
  if (mode === "changed") writeFileSync(join(h.root, "src/app.css"), "changed");
  if (mode === "invalid-hash") inputs.sourceFiles["src/app.ts"] = "not-a-hash";
  if (mode === "invalid-digest") inputs.sourceFilesSha256 = "a".repeat(64);
  await expect(api.calculateReviewBytes(h.root, inputs, Bun.version)).rejects.toThrow("input");
});

test.each(["unknown-capability", "withheld-capability", "schema", "locale", "unsafe-source", "compile"])("calculation never tolerates %s failure", async mode => {
  const h = fixture(), api = await calculator();
  if (mode === "unknown-capability") h.manifest.requires.hostCapabilities.push("unknown.capability@99");
  if (mode === "withheld-capability") h.manifest.requires.hostCapabilities.push("surface.worker@1");
  if (mode === "schema") h.manifest.unknownField = true;
  if (mode === "locale") writeFileSync(join(h.root, "assets/locales/en.json"), "{}");
  if (mode === "unsafe-source") writeFileSync(join(h.root, "package.json"), JSON.stringify({ reaiApp: { entry: "../outside.ts" } }));
  if (mode === "compile") writeFileSync(join(h.root, "src/app.ts"), "const = syntax error;");
  writeFileSync(join(h.root, "app.manifest.json"), JSON.stringify(h.manifest));
  await expect(api.calculateReviewBytes(h.root, pin(h.root), Bun.version)).rejects.toThrow();
});

test.each(["source", "manifest", "asset", "lock"])("production post-build inventory rejects concurrent %s mutation", async mode => {
  const h = fixture(), inputs = pin(h.root), api = await calculator(), spawn = Bun.spawn;
  const hook = spyOn(Bun, "spawn").mockImplementation(((...args: any[]) => {
    if (Array.isArray(args[0]) && args[0][1] === "build") {
      const path = mode === "source" ? "src/app.css" : mode === "asset" ? "assets/icon.svg" : mode === "lock" ? "bun.lock" : "app.manifest.json";
      writeFileSync(join(h.root, path), readFileSync(join(h.root, path), "utf8") + " \n");
    }
    return (spawn as any)(...args);
  }) as typeof Bun.spawn);
  try { await expect(api.calculateReviewBytes(h.root, inputs, Bun.version)).rejects.toThrow(); }
  finally { hook.mockRestore(); }
});

test("source symlinks and a different expected Bun version fail closed", async () => {
  const h = fixture(), inputs = pin(h.root), api = await calculator();
  await expect(api.calculateReviewBytes(h.root, inputs, "0.0.0")).rejects.toThrow("Bun");
  symlinkSync(join(h.root, "src/app.ts"), join(h.root, "src/linked.ts"));
  await expect(api.calculateReviewBytes(h.root, inputs, Bun.version)).rejects.toThrow("symlink");
});

test("normal installed CLI with different source bytes cannot provide calculation evidence", async () => {
  const h = fixture(), api = await calculator();
  const alias = join(h.root, "node_modules/@reai/app-i18n-cli");
  rmSync(alias); cpSync(join(repository, "packages/i18n-cli"), alias, { recursive: true });
  writeFileSync(join(alias, "src/build.ts"), "export {};\n");
  await expect(api.calculateReviewBytes(h.root, pin(h.root), Bun.version)).rejects.toThrow("toolchain");
});

test("same-content installed copy is accepted but a toolchain change during compilation is rejected", async () => {
  const h = fixture(), api = await calculator();
  const alias = join(h.root, "node_modules/@reai/app-i18n-cli");
  rmSync(alias); cpSync(join(repository, "packages/i18n-cli"), alias, { recursive: true });
  const inputs = pin(h.root);
  expect((await api.calculateReviewBytes(h.root, inputs, Bun.version)).calculation.toolchain.packages["@reai/app-i18n-cli"]!.resolution).toBe("same-content");
  const spawn = Bun.spawn;
  const hook = spyOn(Bun, "spawn").mockImplementation(((...args: any[]) => {
    if (Array.isArray(args[0]) && args[0][1] === "build") writeFileSync(join(alias, "package.json"), readFileSync(join(alias, "package.json"), "utf8") + "\n");
    return (spawn as any)(...args);
  }) as typeof Bun.spawn);
  try { await expect(api.calculateReviewBytes(h.root, inputs, Bun.version)).rejects.toThrow("toolchain"); }
  finally { hook.mockRestore(); }
});

test("toolchain content binding permits an evidence-only HEAD change but rejects compiler changes", async () => {
  const h = fixture(), api = await calculator();
  const actual = (await api.calculateReviewBytes(h.root, pin(h.root), Bun.version)).calculation;
  const { reviewToolchainInputsDigest } = await import("../src/review-toolchain");
  expect(reviewToolchainInputsDigest(actual.toolchain)).toBe(actual.toolchainInputsSha256);
  expect(reviewToolchainInputsDigest({ ...actual.toolchain, gitHead: "a".repeat(40) })).toBe(actual.toolchainInputsSha256);
  expect(reviewToolchainInputsDigest({ ...actual.toolchain, bunBinarySha256: "b".repeat(64) })).not.toBe(actual.toolchainInputsSha256);
});

test("real CLI writes only unapproved bytes plus metadata and preserves any existing output directory", async () => {
  const h = fixture(), inputs = pin(h.root), inputFile = join(h.parent, "inputs.json");
  writeFileSync(inputFile, JSON.stringify(inputs));
  const output = join(h.parent, "review-1"), second = join(h.parent, "review-2");
  for (const out of [output, second]) expect((await invoke(h.root, "--inputs", inputFile, "--out", out, "--expected-bun", Bun.version)).code).toBe(0);
  expect(readdirSync(output).sort()).toEqual(["calculation.json", "candidate.review-bytes"]);
  expect(readFileSync(join(output, "candidate.review-bytes"))).toEqual(readFileSync(join(second, "candidate.review-bytes")));
  const saved = readFileSync(join(output, "calculation.json"));
  expect(saved.toString()).not.toContain("SOURCE_REVIEW_SCOPE");
  expect((await invoke(h.root, "--inputs", inputFile, "--out", output, "--expected-bun", Bun.version)).code).toBe(1);
  expect(readFileSync(join(output, "calculation.json"))).toEqual(saved);
  expect(collectSourceReviewInputs(h.root)).toEqual(inputs.sourceFiles);
});

test.each(["inside-app", "symlink-parent", "no-inputs", "no-bun", "invalid-source"])("real CLI rejects %s without a success artifact", async mode => {
  const h = fixture(), inputFile = join(h.parent, "inputs.json");
  let output = join(h.parent, "rejected");
  if (mode === "inside-app") output = join(h.root, "output");
  if (mode === "symlink-parent") { const alias = join(h.parent, "alias"); symlinkSync(h.parent, alias); output = join(alias, "rejected"); }
  if (mode === "invalid-source") writeFileSync(join(h.root, "src/app.ts"), "const = ;");
  writeFileSync(inputFile, JSON.stringify(pin(h.root)));
  const result = await invoke(h.root, ...(mode === "no-inputs" ? [] : ["--inputs", inputFile]), "--out", output, ...(mode === "no-bun" ? [] : ["--expected-bun", Bun.version]));
  expect(result.code).toBe(1);
  expect(result.stderr).toContain(mode === "inside-app" ? "outside" : mode === "symlink-parent" ? "Symlink" : mode === "invalid-source" ? "编译失败" : "required");
  expect(existsSync(join(output, "calculation.json"))).toBeFalse();
  expect(existsSync(join(output, "candidate.review-bytes"))).toBeFalse();
});


function installedCodecCopy(h: ReturnType<typeof fixture>) {
  const cli = join(h.root, "node_modules/@reai/app-i18n-cli");
  rmSync(cli);
  cpSync(join(repository, "packages/i18n-cli"), cli, { recursive: true, filter: path => !path.split("/").includes("node_modules") });
  const resolver = createRequire(new URL("../src/archive.ts", import.meta.url));
  const active = dirname(realpathSync(resolver.resolve("fflate/package.json")));
  const installed = join(h.root, "node_modules/fflate");
  cpSync(active, installed, { recursive: true });
  return { cli, active, installed };
}

function fixtureEvidence(h: ReturnType<typeof fixture>, inputs: ReturnType<typeof pin>, archive: Uint8Array) {
  const report = join(h.parent, "synthetic-only-report.md");
  const scope = { purpose: "submission-source-review" as const, appId: h.manifest.appId, publisherId: h.manifest.publisherId, oauthAppId: h.manifest.oauthAppId, version: h.manifest.version, reviewedHostCapabilities: ["surface.clipboard@1"], sourceFilesSha256: inputs.sourceFilesSha256, expectedPackageSha256: sha(archive), decision: "approved" };
  writeFileSync(report, `Synthetic disposable fixture only\nSOURCE_REVIEW_SCOPE=${JSON.stringify(scope)}\n`);
  return { schemaVersion: 1 as const, ...scope, sourceFiles: inputs.sourceFiles, reviewReports: [{ path: report, sha256: sha(readFileSync(report)) }] };
}

test("unapproved Deflate calculation uses the normal archive and exact codec without granting approval", async () => {
  const h = fixture(), inputs = pin(h.root), api = await calculator();
  const first = await (api.calculateReviewBytes as any)(h.root, inputs, Bun.version, { compression: "deflate" });
  const second = await (api.calculateReviewBytes as any)(h.root, inputs, Bun.version, { compression: "deflate" });
  const stored = await api.calculateReviewBytes(h.root, inputs, Bun.version);
  const explicitStore = await (api.calculateReviewBytes as any)(h.root, inputs, Bun.version, { compression: "store" });
  expect(first.calculation.compression).toBe("deflate");
  expect(first.archive).toEqual(second.archive);
  expect(explicitStore.archive).toEqual(stored.archive);
  expect(first.archive.length).toBeLessThan(stored.archive.length);
  expect(packedFiles(first.archive)).toEqual(packedFiles(stored.archive));
  expect(first.calculation.archiveSha256).not.toBe(stored.calculation.archiveSha256);
  expect(first.calculation.status.approval).toBe("NOT_APPROVED");
  expect(first.calculation.status.installation).toBe("NOT_INSTALLABLE");
  expect(first.calculation.runtimeGrant).toBeFalse();
  expect(first.calculation.platformApproval).toBeFalse();
  expect(JSON.stringify(first.calculation)).not.toContain("SOURCE_REVIEW_SCOPE");
  const codec = first.calculation.toolchain.packages.fflate;
  expect(codec.version).toBe("0.8.3");
  expect(codec.resolution).toBe("same-content");
  expect(codec.entry).toBe("lib/node.cjs");
  expect(codec.files[codec.entry]).toMatch(/^[a-f0-9]{64}$/);
  expect(codec.files["LICENSE"]).toMatch(/^[a-f0-9]{64}$/);
  expect(stored.calculation.toolchain.packages.fflate).toBeUndefined();
  await expect(buildApp(h.root)).rejects.toThrow();
  await expect(packApp(h.root, join(h.root, "denied.reaiapp"), true, undefined, { compression: "deflate" })).rejects.toThrow();
  const evidence = fixtureEvidence(h, inputs, first.archive);
  const normal = await packApp(h.root, join(h.root, "normal-deflate.reaiapp"), true, evidence, { compression: "deflate" });
  expect(readFileSync(normal.outputPath)).toEqual(first.archive);
  await expect(packApp(h.root, join(h.root, "different-store.reaiapp"), true, evidence)).rejects.toThrow("package digest");
  const storeEvidence = fixtureEvidence(h, inputs, stored.archive);
  await expect(packApp(h.root, join(h.root, "different-deflate.reaiapp"), true, storeEvidence, { compression: "deflate" })).rejects.toThrow("package digest");
}, 20000);

test.each(["files", "version", "missing", "entry-outside"])("Deflate calculation rejects installed codec %s while STORE stays independent", async mode => {
  const h = fixture(), api = await calculator(), codec = installedCodecCopy(h);
  if (mode === "files") writeFileSync(join(codec.installed, "LICENSE"), "different bytes");
  if (mode === "version") {
    const metadata = JSON.parse(readFileSync(join(codec.installed, "package.json"), "utf8"));
    metadata.version = "9.9.9"; writeFileSync(join(codec.installed, "package.json"), JSON.stringify(metadata));
  }
  if (mode === "missing") rmSync(codec.installed, { recursive: true });
  if (mode === "entry-outside") {
    const entry = join(codec.installed, "lib/node.cjs");
    rmSync(entry); writeFileSync(join(h.parent, "outside.cjs"), "exports.deflateSync = () => new Uint8Array();");
    symlinkSync(join(h.parent, "outside.cjs"), entry);
  }
  const inputs = pin(h.root);
  await expect((api.calculateReviewBytes as any)(h.root, inputs, Bun.version, { compression: "deflate" })).rejects.toThrow("fflate");
  expect((await api.calculateReviewBytes(h.root, inputs, Bun.version)).calculation.compression).toBe("store");
});

test("Deflate records a full independent installed codec and rejects its mutation during compilation", async () => {
  const h = fixture(), api = await calculator(), codec = installedCodecCopy(h), inputs = pin(h.root);
  const first = await (api.calculateReviewBytes as any)(h.root, inputs, Bun.version, { compression: "deflate" });
  expect(first.calculation.toolchain.packages.fflate.files["LICENSE"]).toBe(sha(readFileSync(join(codec.installed, "LICENSE"))));
  const spawn = Bun.spawn;
  const hook = spyOn(Bun, "spawn").mockImplementation(((...args: any[]) => {
    if (Array.isArray(args[0]) && args[0][1] === "build") writeFileSync(join(codec.installed, "LICENSE"), "changed during build");
    return (spawn as any)(...args);
  }) as typeof Bun.spawn);
  try { await expect((api.calculateReviewBytes as any)(h.root, inputs, Bun.version, { compression: "deflate" })).rejects.toThrow("toolchain"); }
  finally { hook.mockRestore(); }
});

test("the shared encoder resolver reads current metadata and rejects unsafe or missing fixture origins", async () => {
  const h = fixture(), codec = installedCodecCopy(h), api = await import("../src/archive") as any;
  const from = pathToFileURL(join(codec.cli, "src/archive.ts"));
  const actual = api.resolveDeflateCodec(from);
  expect(actual.entryPath).toBe(realpathSync(join(codec.installed, "lib/node.cjs")));
  const metadata = JSON.parse(readFileSync(join(codec.installed, "package.json"), "utf8"));
  metadata.version = "9.9.9"; writeFileSync(join(codec.installed, "package.json"), JSON.stringify(metadata));
  expect(() => api.resolveDeflateCodec(from)).toThrow("found 9.9.9");
  metadata.version = "0.8.3"; writeFileSync(join(codec.installed, "package.json"), JSON.stringify(metadata));
  rmSync(join(codec.installed, "lib/node.cjs"));
  writeFileSync(join(h.parent, "outside.cjs"), "exports.deflateSync = () => new Uint8Array();");
  symlinkSync(join(h.parent, "outside.cjs"), join(codec.installed, "lib/node.cjs"));
  expect(() => api.resolveDeflateCodec(from)).toThrow("outside its package");
  rmSync(codec.installed, { recursive: true });
  expect(() => api.resolveDeflateCodec(from)).toThrow("dependency missing");
});

test("real offline CLI calculates explicit Deflate twice without SOURCE approval", async () => {
  const h = fixture(), inputFile = join(h.parent, "inputs.json");
  writeFileSync(inputFile, JSON.stringify(pin(h.root)));
  const first = join(h.parent, "deflate-one"), second = join(h.parent, "deflate-two");
  for (const out of [first, second]) {
    const result = await invoke(h.root, "--inputs", inputFile, "--out", out, "--expected-bun", Bun.version, "--compression", "deflate");
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).compression).toBe("deflate");
  }
  expect(readFileSync(join(first, "candidate.review-bytes"))).toEqual(readFileSync(join(second, "candidate.review-bytes")));
  expect(JSON.parse(readFileSync(join(first, "calculation.json"), "utf8")).status.approval).toBe("NOT_APPROVED");
});

test.each([["--compression", "gzip"], ["--compression", ""], ["--compression"], ["--compression=deflate"], ["--compression", "store", "--compression", "deflate"], ["--unexpected", "deflate"]].map(args => [args]))("real CLI rejects invalid compression argument %j without artifacts", async extra => {
  const h = fixture(), inputFile = join(h.parent, "inputs.json"), output = join(h.parent, "rejected-compression");
  writeFileSync(inputFile, JSON.stringify(pin(h.root)));
  const result = await invoke(h.root, "--inputs", inputFile, "--out", output, "--expected-bun", Bun.version, ...extra);
  expect(result.code).toBe(1);
  expect(existsSync(output)).toBeFalse();
});

test("unsupported compression fails before compilation or output", async () => {
  const h = fixture(), api = await calculator();
  await expect((api.calculateReviewBytes as any)(h.root, pin(h.root), Bun.version, { compression: "gzip" })).rejects.toThrow("--compression");
  expect(existsSync(join(h.root, "dist"))).toBeFalse();
});


test("offline calculation keeps skin packages outside its supported scope", async () => {
  const h = fixture(), api = await calculator();
  const skin = join(repository, "examples/skins/codex");
  cpSync(join(skin, "app.manifest.json"), join(h.root, "app.manifest.json"));
  cpSync(join(skin, "skin"), join(h.root, "skin"), { recursive: true });
  await expect(api.calculateReviewBytes(h.root, pin(h.root), Bun.version, { compression: "deflate" })).rejects.toThrow();
  expect(existsSync(join(h.root, "dist"))).toBeFalse();
});


test("reused Deflate writer executes current codec bytes and preserves other CJS caches and STORE", async () => {
  const h = fixture(), copied = installedCodecCopy(h);
  const archiveUrl = pathToFileURL(join(copied.cli, "src/archive.ts"));
  const writer = await import(archiveUrl.href) as typeof import("../src/archive");
  const req = createRequire(archiveUrl), origin = writer.resolveDeflateCodec();
  expect(origin.entryPath.startsWith(h.parent + "/")).toBeTrue();
  expect(origin.root).toBe(realpathSync(copied.installed));
  const peer = join(h.root, "node_modules/fflate-peer/index.cjs");
  mkdirSync(dirname(peer), { recursive: true });
  writeFileSync(peer, "module.exports = { sentinel: true };\n");
  const sentinel = req(peer);
  const { loadSupportMatrix } = await import("@reai/app-cli");
  const entries = [{ path: "app.manifest.json", bytes: Buffer.from('{"manifestVersion":"1.1"}') }];
  const first = writer.writePackageZip(entries, "deflate", loadSupportMatrix().limits);
  expect(writer.writePackageZip(entries, "deflate", loadSupportMatrix().limits)).toEqual(first);
  const cached = req.cache[origin.entryPath];
  expect(cached).toBeDefined();
  writer.writePackageZip(entries, "store", loadSupportMatrix().limits);
  expect(req.cache[origin.entryPath]).toBe(cached);
  writeFileSync(origin.entryPath, readFileSync(origin.entryPath, "utf8") + '\nexports.deflateSync = () => { throw new Error("fresh fixture codec source executed"); };\n');
  expect(() => writer.writePackageZip(entries, "deflate", loadSupportMatrix().limits)).toThrow("fresh fixture codec source executed");
  expect(req(peer)).toBe(sentinel);
});
