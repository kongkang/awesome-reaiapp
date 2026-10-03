import { readFileSync } from "node:fs";
import { join } from "node:path";
import { validateManifestFile as validateLegacyManifest } from "../packages/cli/src/index";
import { validateManifestFile as validateLanguageManifest } from "../packages/i18n-cli/src/index";
import type { SourceReviewEvidence } from "../packages/i18n-cli/src/source-review-evidence";

export const I18N_REFERENCE_PLUGINS = ["voice", "codex-link", "codex-app"] as const;

export function requiresPluginI18n(manifest: Record<string, unknown>): boolean {
  return I18N_REFERENCE_PLUGINS.some((slug) => manifest.appId === `com.reai.${slug}`)
    || Object.hasOwn(manifest, "i18n");
}

export function pluginCliCommand(root: string): { packageName: string; executable: string } {
  const manifest = JSON.parse(readFileSync(join(root, "app.manifest.json"), "utf8"));
  return requiresPluginI18n(manifest)
    ? { packageName: "@reai/app-i18n-cli", executable: "reai-app-i18n" }
    : { packageName: "@reai/app-cli", executable: "reai-app" };
}

export function validatePluginLanguagePackage(root: string, sourceReview?: SourceReviewEvidence) {
  const path = join(root, "app.manifest.json");
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  return requiresPluginI18n(manifest) ? validateLanguageManifest(path, true, sourceReview) : validateLegacyManifest(path);
}
