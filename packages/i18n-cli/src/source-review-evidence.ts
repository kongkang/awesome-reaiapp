/** Explicit local submission preflight evidence. Never runtime or platform authorization. */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { Finding } from "@reai/app-cli";
import { assertSafeTree, isSafePackagePath, safeChild } from "./paths";

export interface SourceReviewEvidence {
  schemaVersion: 1;
  purpose: "submission-source-review";
  appId: string;
  publisherId: string;
  oauthAppId: string;
  version: string;
  reviewedHostCapabilities: string[];
  sourceFiles: Record<string, string>;
  reviewReports: { path: string; sha256: string }[];
  expectedPackageSha256: string;
}

const digest = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const validDigest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const orderedFiles = (files: Record<string, string>) => Object.fromEntries(Object.entries(files).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
export const sourceReviewInputsDigest = (files: Record<string, string>): string => digest(JSON.stringify(orderedFiles(files)));

/** Conservative complete input inventory, including local packages/config/assets/locks.
 * Root build outputs and dependency installs are excluded; package digest binds output. */
export function collectSourceReviewInputs(appDirectory: string): Record<string, string> {
  const root = resolve(appDirectory);
  if (lstatSync(root).isSymbolicLink()) throw new Error("Source review app root is a symlink");
  const files: Record<string, string> = {};
  const visit = (directory: string, prefix = "") => {
    for (const name of readdirSync(directory).sort()) {
      const path = prefix ? `${prefix}/${name}` : name;
      if (name === "node_modules" || name === ".git" || (!prefix && (name === "dist" || name === "build-manifest.json" || name.endsWith(".reaiapp")))) continue;
      if (!isSafePackagePath(path)) throw new Error("Unsafe source review input path");
      const full = safeChild(root, path), stat = lstatSync(full);
      if (stat.isSymbolicLink()) throw new Error(`Source review input is a symlink: ${path}`);
      if (stat.isDirectory()) visit(full, path);
      else if (stat.isFile()) files[path] = digest(readFileSync(full));
      else throw new Error(`Unsupported source review input: ${path}`);
    }
  };
  visit(root);
  return orderedFiles(files);
}

function repositoryRoot(appDirectory: string): string {
  const root = resolve(appDirectory);
  let candidate = root;
  for (;;) {
    if (existsSync(join(candidate, ".git"))) return candidate;
    const parent = dirname(candidate);
    if (parent === candidate) return root;
    candidate = parent;
  }
}
function reportPath(appDirectory: string, path: string): string {
  const root = repositoryRoot(appDirectory);
  const full = isAbsolute(path) ? resolve(path) : safeChild(root, path);
  const rel = relative(root, full).replaceAll("\\", "/");
  if (!isSafePackagePath(rel)) throw new Error("Review report escapes repository root");
  assertSafeTree(root, rel);
  if (!lstatSync(full).isFile()) throw new Error("Review report is not a regular file");
  return full;
}
export function readSourceReviewEvidence(path: string): SourceReviewEvidence {
  const full = resolve(path);
  // The explicit evidence artifact itself cannot alias another file through a symlink.
  let prefix = dirname(full);
  while (dirname(prefix) !== prefix) {
    if (lstatSync(prefix).isSymbolicLink()) throw new Error("Source review evidence path is a symlink");
    prefix = dirname(prefix);
  }
  if (!lstatSync(full).isFile() || lstatSync(full).isSymbolicLink()) throw new Error("Source review evidence is not a regular file");
  return JSON.parse(readFileSync(full, "utf8")) as SourceReviewEvidence;
}

/** Returns a validation finding; invalid evidence never removes any denial. */
export function sourceReviewEvidenceFindings(manifest: Record<string, unknown>, evidence: SourceReviewEvidence, appDirectory?: string): Finding[] {
  try {
    if (!appDirectory || !evidence || typeof evidence !== "object" || evidence.schemaVersion !== 1
      || evidence.purpose !== "submission-source-review") throw new Error("Explicit source review evidence and app directory are required");
    for (const field of ["appId", "publisherId", "oauthAppId", "version"] as const) {
      if (typeof evidence[field] !== "string" || !evidence[field] || evidence[field] !== manifest[field]) throw new Error(`Source review identity differs: ${field}`);
    }
    if (!validDigest(evidence.expectedPackageSha256)) throw new Error("Source review package digest is invalid");
    const caps = evidence.reviewedHostCapabilities;
    if (!Array.isArray(caps) || caps.length === 0 || caps.some(cap => typeof cap !== "string" || !cap)
      || new Set(caps).size !== caps.length) throw new Error("Source review capability scope is invalid");
    const declared = new Set(((manifest.requires as { hostCapabilities?: string[] } | undefined)?.hostCapabilities ?? []));
    for (const component of ((manifest.runtime as { components?: { activation?: string }[] } | undefined)?.components ?? [])) {
      if (component.activation) declared.add(`activation.${component.activation}@1`);
    }
    if (caps.some(cap => !declared.has(cap))) throw new Error("Source review includes an undeclared capability");
    if (!evidence.sourceFiles || typeof evidence.sourceFiles !== "object" || Array.isArray(evidence.sourceFiles)
      || Object.entries(evidence.sourceFiles).some(([path, hash]) => !isSafePackagePath(path) || !validDigest(hash))) throw new Error("Source review input inventory is invalid");
    if (JSON.stringify(JSON.parse(readFileSync(safeChild(resolve(appDirectory), "app.manifest.json"), "utf8"))) !== JSON.stringify(manifest)) throw new Error("Source review manifest differs from build input");
    const actual = collectSourceReviewInputs(appDirectory);
    if (JSON.stringify(actual) !== JSON.stringify(orderedFiles(evidence.sourceFiles))) throw new Error("Source review build inputs differ or are not completely covered");
    const scope = { purpose: evidence.purpose, appId: evidence.appId, publisherId: evidence.publisherId,
      oauthAppId: evidence.oauthAppId, version: evidence.version, reviewedHostCapabilities: [...caps].sort(),
      sourceFilesSha256: sourceReviewInputsDigest(actual), expectedPackageSha256: evidence.expectedPackageSha256, decision: "approved" };
    if (!Array.isArray(evidence.reviewReports) || evidence.reviewReports.length === 0) throw new Error("Independent source review reports are required");
    let reviewedScope = false;
    const paths = new Set<string>();
    for (const report of evidence.reviewReports) {
      if (!report || typeof report.path !== "string" || !validDigest(report.sha256)) throw new Error("Source review report reference is invalid");
      const path = reportPath(appDirectory, report.path);
      if (paths.has(path)) throw new Error("Duplicate source review report");
      paths.add(path);
      const bytes = readFileSync(path);
      if (digest(bytes) !== report.sha256) throw new Error("Source review report digest differs");
      for (const match of bytes.toString("utf8").matchAll(/^SOURCE_REVIEW_SCOPE=(\{[^\r\n]*\})\r?$/gm)) {
        const reviewed = JSON.parse(match[1]!);
        if (Array.isArray(reviewed.reviewedHostCapabilities)) reviewed.reviewedHostCapabilities.sort();
        if (Object.keys(scope).every(key => JSON.stringify(reviewed[key]) === JSON.stringify(scope[key as keyof typeof scope]))) reviewedScope = true;
      }
    }
    if (!reviewedScope) throw new Error("Independent report does not approve this exact source scope and package digest");
    return [];
  } catch (cause) {
    return [{ code: "MANIFEST_REFERENCE_INVALID", pointer: "sourceReview", detail: cause instanceof Error ? cause.message : "Invalid source review evidence" }];
  }
}

export function assertSourceReviewArchive(evidence: SourceReviewEvidence | undefined, archive: Uint8Array): void {
  if (evidence && digest(archive) !== evidence.expectedPackageSha256) throw new Error("Source review expected package digest differs from actual archive");
}
