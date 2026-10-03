import { afterEach, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp, collectSourceReviewInputs, packApp, packedFiles, sourceReviewInputsDigest,
  validateManifest, validateManifestFile, type SourceReviewEvidence } from "../src/index";
import { BUILD_MANIFEST_NAME, writeZip } from "@reai/app-cli";
import { readVerifiedEntries } from "../src/pack";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
function fixture() {
  const repository = realpathSync(mkdtempSync(join(tmpdir(), "source-review-evidence-"))); roots.push(repository);
  mkdirSync(join(repository, ".git"));
  const root = join(repository, "app"); mkdirSync(join(root, "src"), { recursive: true });
  const manifest = JSON.parse(readFileSync(join(import.meta.dir, "../../contract/manifest-fixtures/valid/minimal-todo.json"), "utf8"));
  Object.assign(manifest, { appId: "com.example.source-reviewed", publisherId: "reviewed-team", oauthAppId: "reviewed-oauth", version: "1.0.0-rc.3" });
  manifest.requires.hostCapabilities.push("surface.clipboard@1");
  writeFileSync(join(root, "app.manifest.json"), JSON.stringify(manifest));
  writeFileSync(join(root, "src/app.ts"), "export default { activate() {} };\n");
  const sourceFiles = Object.fromEntries(["app.manifest.json", "src/app.ts"].map(path => [path, sha(readFileSync(join(root, path)))]));
  const expectedPackageSha256 = "a".repeat(64);
  const scope = { purpose: "submission-source-review", appId: manifest.appId, publisherId: manifest.publisherId,
    oauthAppId: manifest.oauthAppId, version: manifest.version, reviewedHostCapabilities: ["surface.clipboard@1"],
    sourceFilesSha256: sha(JSON.stringify(Object.fromEntries(Object.entries(sourceFiles).sort(([a], [b]) => a.localeCompare(b))))),
    expectedPackageSha256, decision: "approved" };
  const report = join(repository, "review.md");
  writeFileSync(report, `Independent reviewer: fixture\nApproved source scope; runtime authorization remains separate.\nSOURCE_REVIEW_SCOPE=${JSON.stringify(scope)}\n`);
  const evidence: SourceReviewEvidence = { schemaVersion: 1, ...scope, purpose: "submission-source-review", sourceFiles, reviewReports: [{ path: report, sha256: sha(readFileSync(report)) }] };
  return { root, repository, manifest, evidence, report };
}

test("explicit bound source evidence removes only reviewed capability denial without runtime seed changes", () => {
  const h = fixture();
  expect(validateManifest(h.manifest).map(f => f.code)).toContain("APP_CAPABILITY_NOT_GRANTED");
  expect(validateManifest(h.manifest, h.evidence, h.root)).toEqual([]);
});

function refreshReport(h: ReturnType<typeof fixture>) {
  const scope = { purpose: h.evidence.purpose, appId: h.evidence.appId, publisherId: h.evidence.publisherId,
    oauthAppId: h.evidence.oauthAppId, version: h.evidence.version, reviewedHostCapabilities: h.evidence.reviewedHostCapabilities,
    sourceFilesSha256: sourceReviewInputsDigest(h.evidence.sourceFiles), expectedPackageSha256: h.evidence.expectedPackageSha256, decision: "approved" };
  writeFileSync(h.report, `Independent reviewer: fixture\nNo blocker found in the exact source scope. Runtime grants remain separate.\nSOURCE_REVIEW_SCOPE=${JSON.stringify(scope)}\n`);
  h.evidence.reviewReports[0]!.sha256 = sha(readFileSync(h.report));
}
async function bindActualPackage(h: ReturnType<typeof fixture>) {
  const built = await buildApp(h.root, false, h.evidence);
  const entries = readVerifiedEntries(h.root, built.buildManifest);
  entries.push({ path: BUILD_MANIFEST_NAME, bytes: Buffer.from(`${JSON.stringify(built.buildManifest, null, 2)}\n`) });
  entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  h.evidence.expectedPackageSha256 = sha(writeZip(entries));
  refreshReport(h);
}

test.each(["appId", "publisherId", "oauthAppId", "version"] as const)("evidence cannot substitute a different %s", field => {
  const h = fixture(); h.evidence[field] = "different";
  const findings = validateManifest(h.manifest, h.evidence, h.root);
  expect(findings.map(f => f.code)).toContain("APP_CAPABILITY_NOT_GRANTED");
  expect(findings.some(f => f.pointer === "sourceReview")).toBeTrue();
});

test.each(["mutated", "added", "missing", "unsafe"])("source evidence rejects %s build input coverage", mode => {
  const h = fixture();
  if (mode === "mutated") writeFileSync(join(h.root, "src/app.ts"), "export default { activate() { throw Error('changed'); } };\n");
  if (mode === "added") { mkdirSync(join(h.root, "config")); writeFileSync(join(h.root, "config/runtime.json"), "{}"); }
  if (mode === "missing") delete h.evidence.sourceFiles["src/app.ts"];
  if (mode === "unsafe") h.evidence.sourceFiles["../outside.ts"] = "a".repeat(64);
  expect(validateManifest(h.manifest, h.evidence, h.root).map(f => f.code)).toContain("APP_CAPABILITY_NOT_GRANTED");
});

test("review scope does not erase an extra gated capability or unrelated availability finding", () => {
  const h = fixture();
  h.manifest.requires.hostCapabilities.push("surface.worker@1", "agent.session@2");
  h.manifest.permissions.push({ id: "agent.session@2", purpose: "Reviewed fixture", required: false });
  writeFileSync(join(h.root, "app.manifest.json"), JSON.stringify(h.manifest));
  h.evidence.sourceFiles = collectSourceReviewInputs(h.root); refreshReport(h);
  const findings = validateManifest(h.manifest, h.evidence, h.root);
  expect(findings.some(f => f.code === "APP_CAPABILITY_NOT_GRANTED" && f.detail.includes("agent.session@2"))).toBeTrue();
  expect(findings.some(f => f.code === "HOST_CAPABILITY_NOT_AVAILABLE" && f.detail.includes("surface.worker@1"))).toBeTrue();
  expect(findings.some(f => f.code === "APP_CAPABILITY_NOT_GRANTED" && f.detail.includes("surface.clipboard@1"))).toBeFalse();
});

test("report hash and exact approval scope are mandatory; a standalone self-declared JSON is insufficient", () => {
  const h = fixture();
  h.evidence.reviewReports[0]!.sha256 = "b".repeat(64);
  expect(validateManifest(h.manifest, h.evidence, h.root).map(f => f.code)).toContain("APP_CAPABILITY_NOT_GRANTED");
  writeFileSync(h.report, "Independent review did not approve this candidate.\n");
  h.evidence.reviewReports[0]!.sha256 = sha(readFileSync(h.report));
  expect(validateManifest(h.manifest, h.evidence, h.root).map(f => f.code)).toContain("APP_CAPABILITY_NOT_GRANTED");
  h.evidence.reviewReports = [];
  expect(validateManifest(h.manifest, h.evidence, h.root).map(f => f.code)).toContain("APP_CAPABILITY_NOT_GRANTED");
});

test("source and report symlinks or repository escapes cannot supply evidence", () => {
  const h = fixture();
  const original = join(h.repository, "outside.ts"); writeFileSync(original, "export default {};\n");
  symlinkSync(original, join(h.root, "src/linked.ts"));
  expect(validateManifest(h.manifest, h.evidence, h.root).map(f => f.code)).toContain("APP_CAPABILITY_NOT_GRANTED");
  rmSync(join(h.root, "src/linked.ts"));
  const alias = join(h.repository, "review-alias.md"); symlinkSync(h.report, alias);
  h.evidence.reviewReports[0]!.path = alias;
  expect(validateManifest(h.manifest, h.evidence, h.root).map(f => f.code)).toContain("APP_CAPABILITY_NOT_GRANTED");
  h.evidence.reviewReports[0]!.path = "../outside-report.md";
  expect(validateManifest(h.manifest, h.evidence, h.root).map(f => f.code)).toContain("APP_CAPABILITY_NOT_GRANTED");
});

test("validate, two builds, two packs and archived bytes agree on the exact reviewed candidate", async () => {
  const h = fixture(); await bindActualPackage(h);
  expect(validateManifestFile(join(h.root, "app.manifest.json"), false, h.evidence)).toEqual([]);
  const first = await buildApp(h.root, false, h.evidence), second = await buildApp(h.root, false, h.evidence);
  expect(first.buildManifest).toEqual(second.buildManifest);
  const one = await packApp(h.root, join(h.root, "one.reaiapp"), false, h.evidence);
  const two = await packApp(h.root, join(h.root, "two.reaiapp"), false, h.evidence);
  expect(one.archiveDigest).toBe(h.evidence.expectedPackageSha256);
  expect(two.archiveDigest).toBe(one.archiveDigest);
  expect(readFileSync(one.outputPath)).toEqual(readFileSync(two.outputPath));
  const manifest = JSON.parse(new TextDecoder().decode(packedFiles(readFileSync(one.outputPath)).get("app.manifest.json")));
  expect(validateManifest(manifest, h.evidence, h.root)).toEqual([]);
  expect(collectSourceReviewInputs(h.root)).toEqual(h.evidence.sourceFiles);
});

test("different actual package digest rejects without replacing an existing artifact", async () => {
  const h = fixture(); await bindActualPackage(h);
  const output = join(h.root, "out.reaiapp"); writeFileSync(output, "previous immutable package");
  h.evidence.expectedPackageSha256 = "b".repeat(64); refreshReport(h);
  await expect(packApp(h.root, output, false, h.evidence)).rejects.toThrow("package digest");
  expect(readFileSync(output, "utf8")).toBe("previous immutable package");
});

test("post-build checks reject a source mutation during bundling", async () => {
  const h = fixture(); const spawn = Bun.spawn;
  const hook = spyOn(Bun, "spawn").mockImplementation(((...args: any[]) => {
    writeFileSync(join(h.root, "src/app.ts"), "export default { activate() { throw Error('changed during build'); } };\n");
    return (spawn as any)(...args);
  }) as typeof Bun.spawn);
  try { await expect(buildApp(h.root, false, h.evidence)).rejects.toThrow("Post-build validation"); }
  finally { hook.mockRestore(); }
});

test("a manifest detached from the reviewed input cannot claim evidence", () => {
  const h = fixture();
  expect(validateManifest(h.manifest, h.evidence).map(f => f.code)).toContain("APP_CAPABILITY_NOT_GRANTED");
  const changed = structuredClone(h.manifest); changed.name = "Different submitted manifest";
  expect(validateManifest(changed, h.evidence, h.root).map(f => f.code)).toContain("APP_CAPABILITY_NOT_GRANTED");
});

test("post-build checks also revalidate independent report bytes", async () => {
  const h = fixture(); const spawn = Bun.spawn;
  const hook = spyOn(Bun, "spawn").mockImplementation(((...args: any[]) => {
    writeFileSync(h.report, "Review report changed while bundling.\n");
    return (spawn as any)(...args);
  }) as typeof Bun.spawn);
  try { await expect(buildApp(h.root, false, h.evidence)).rejects.toThrow("Post-build validation"); }
  finally { hook.mockRestore(); }
});

test("real CLI forwards explicit evidence through validate/build/pack and keeps default denial", async () => {
  const h = fixture();
  const { metadataTargets } = await import("../src/resources");
  h.manifest.requires.hostCapabilities.push("metadata.i18n@1");
  h.manifest.i18n = { locales: ["zh", "en"], messages: [...metadataTargets(h.manifest).keys()].map(identity => {
    const [target, id] = identity.split(":"); return { target, ...(id ? { id } : {}), key: "metadata.name" };
  }) };
  mkdirSync(join(h.root, "assets/locales"), { recursive: true });
  for (const lang of ["en", "zh"]) writeFileSync(join(h.root, `assets/locales/${lang}.json`), '{"metadata":{"name":"Fixture"}}');
  writeFileSync(join(h.root, "app.manifest.json"), JSON.stringify(h.manifest));
  h.evidence.sourceFiles = collectSourceReviewInputs(h.root); refreshReport(h); await bindActualPackage(h);
  const evidencePath = join(h.repository, "evidence.json"); writeFileSync(evidencePath, JSON.stringify(h.evidence));
  const cli = join(import.meta.dir, "../src/cli.ts");
  const invoke = async (...args: string[]) => {
    const proc = Bun.spawn([process.execPath, cli, ...args], { stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    return { code, stdout, stderr };
  };
  const denied = await invoke("validate", h.root); expect(denied.code).toBe(1); expect(denied.stderr).toContain("APP_CAPABILITY_NOT_GRANTED");
  for (const command of ["validate", "build", "pack"]) {
    const result = await invoke(command, h.root, "--source-review", evidencePath,
      ...(command === "pack" ? ["--out", join(h.root, "cli.reaiapp")] : []));
    expect(result.code).toBe(0); expect(result.stdout).toContain("local submission preflight only");
  }
  expect(sha(readFileSync(join(h.root, "cli.reaiapp")))).toBe(h.evidence.expectedPackageSha256);
  const alias = join(h.repository, "evidence-alias.json"); symlinkSync(evidencePath, alias);
  expect((await invoke("validate", h.root, "--source-review", alias)).code).toBe(1);
});
