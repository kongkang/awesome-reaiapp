/** Source preflight only: package installation still verifies artifact identity in Host. */
import { readFileSync } from "node:fs";
import type { Finding } from "@reai/app-cli";

const readContract = (name: string) => JSON.parse(readFileSync(
  new URL(import.meta.resolve(`@reai/app-contract/${name}`)), "utf8"));
const policy = readContract("capability-review-policy.seed.json") as {
  approvals: { appId: string; publisherId: string; version: string;
    packageSha256: string | null; approvedHostCapabilities: string[] }[];
};
const matrix = readContract("host-support-matrix.json") as {
  hostCapabilities: { granted: string[]; grantGated: string[] };
  runtime: { activationAllowed?: string[]; activationGated?: string[] };
};
type Manifest = {
  appId: string; publisherId: string; version: string;
  requires?: { hostCapabilities?: string[] };
  runtime?: { components?: { activation?: string }[] };
};

export function sourceApprovalFindings(manifest: Manifest, legacy: Finding[]): Finding[] {
  // A platform package approval (bound to a digest) normally also covers later source
  // versions of the same publisher. An app already governed by per-version source review
  // (it has a digest-less record pinned to an exact version for this publisher) keeps
  // that discipline: its package approval covers only its own version, so every new
  // source version still needs its own review record.
  const perVersionReviewed = policy.approvals.some(approval =>
    approval.appId === manifest.appId && approval.publisherId === manifest.publisherId
    && approval.version !== "*" && approval.packageSha256 === null);
  const approved = (capability: string) => policy.approvals.some(approval =>
    approval.appId === manifest.appId
    && (approval.version === "*" || (approval.publisherId === manifest.publisherId
      && (approval.version === manifest.version
        || (typeof approval.packageSha256 === "string" && !perVersionReviewed))))
    && approval.approvedHostCapabilities.includes(capability));
  const checks = gatedSourceChecks(manifest);
  // Recompute both legacy denials and legacy appId-only successes. Do not erase
  // unrelated findings, unavailable capabilities, or schema errors.
  const pointers = new Set(checks.map(check => check.pointer));
  return [
    ...legacy.filter(finding => finding.code !== "APP_CAPABILITY_NOT_GRANTED" || !pointers.has(finding.pointer)),
    ...checks.filter(check => !approved(check.capability)).map(check => ({
      code: "APP_CAPABILITY_NOT_GRANTED" as const, pointer: check.pointer,
      detail: `${check.capability} requires an applicable source review approval`,
    })),
  ];
}

/** Same gated declarations for normal policy checks and non-authorizing byte calculation. */
export function gatedSourceChecks(manifest: Manifest): { pointer: string; capability: string }[] {
  const checks: { pointer: string; capability: string }[] = [];
  (manifest.requires?.hostCapabilities ?? []).forEach((capability, index) => {
    if (!matrix.hostCapabilities.granted.includes(capability)
      && matrix.hostCapabilities.grantGated.includes(capability)) {
      checks.push({ pointer: `requires.hostCapabilities[${index}]`, capability });
    }
  });
  (manifest.runtime?.components ?? []).forEach((component, index) => {
    const activation = component.activation ?? "";
    if (!(matrix.runtime.activationAllowed ?? []).includes(activation)
      && (matrix.runtime.activationGated ?? []).includes(activation)) {
      checks.push({ pointer: `runtime.components[${index}].activation`, capability: `activation.${activation}@1` });
    }
  });
  return checks;
}
