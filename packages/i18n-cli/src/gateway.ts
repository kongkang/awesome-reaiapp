/** Host 1.20 rules layered above the immutable 1.2 builder. */
import { validateManifest as validateLegacy, type Finding } from "@reai/app-cli";
import { sourceApprovalFindings } from "./source-approval";
import { sourceReviewEvidenceFindings, type SourceReviewEvidence } from "./source-review-evidence";

export function validateManifest(manifest: unknown, sourceReview?: SourceReviewEvidence, appDirectory?: string): Finding[] {
  let findings = validateLegacy(manifest);
  if (findings.some(({ code }) => code === "MANIFEST_SCHEMA_INVALID")) return findings;
  findings = sourceApprovalFindings(manifest as Parameters<typeof sourceApprovalFindings>[0], findings);
  if (sourceReview) {
    const evidenceFindings = sourceReviewEvidenceFindings(manifest as Record<string, unknown>, sourceReview, appDirectory);
    if (evidenceFindings.length === 0) {
      const reviewed = new Set(sourceReview.reviewedHostCapabilities);
      const scope = manifest as { requires?: { hostCapabilities?: string[] }; runtime?: { components?: { activation?: string }[] } };
      const pointers = new Set<string>();
      (scope.requires?.hostCapabilities ?? []).forEach((cap, index) => {
        if (reviewed.has(cap)) pointers.add(`requires.hostCapabilities[${index}]`);
      });
      (scope.runtime?.components ?? []).forEach((component, index) => {
        if (reviewed.has(`activation.${component.activation}@1`)) pointers.add(`runtime.components[${index}].activation`);
      });
      findings = findings.filter(finding => finding.code !== "APP_CAPABILITY_NOT_GRANTED" || !pointers.has(finding.pointer));
    }
    findings.push(...evidenceFindings);
  }
  const m = manifest as {
    requires?: { hostCapabilities?: string[] };
    permissions?: { id: string }[];
  };
  const capabilities = m.requires?.hostCapabilities ?? [];
  const hasCapability = capabilities.includes("apps.gateway@1");
  const hasPermission = (m.permissions ?? []).some(({ id }) => id === "apps.gateway@1");
  if (hasCapability && !capabilities.includes("apps.service@1")) {
    findings.push({ code: "MANIFEST_REFERENCE_INVALID", pointer: "requires.hostCapabilities",
      detail: "apps.gateway@1 requires apps.service@1" });
  }
  if (hasCapability !== hasPermission) {
    findings.push({ code: "MANIFEST_REFERENCE_INVALID",
      pointer: hasCapability ? "permissions" : "requires.hostCapabilities",
      detail: "apps.gateway@1 requires both capability and user permission declarations" });
  }
  return findings;
}
