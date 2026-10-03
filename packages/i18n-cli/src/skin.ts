/** Skin v1 的开发期校验；Host 安装时会用 Rust 再独立校验一次。 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const skinSchema = JSON.parse(readFileSync(fileURLToPath(import.meta.resolve("@reai/app-contract/schemas/skin-v1.schema.json")), "utf8"));
import { validateAgainstSchema } from "@reai/app-cli";
import type { Finding } from "@reai/app-cli";

export const SKIN_TOKEN_NAMES = [
  "accent", "accent-glow", "accent-soft", "alert", "alert-line", "alert-soft",
  "bar-bg", "bar-border", "bar-shadow", "bg", "bound", "bound-line", "bound-soft",
  "cap-accent", "cap-bg", "cap-dim", "cap-shadow", "cap-text", "cap-wave",
  "card-bg", "card-border", "card-shadow", "desk-bg", "divider",
  "panel-bg", "panel-border", "panel-shadow", "panel-sub", "panel-text",
  "scroll-thumb", "scroll-thumb-hi", "text-primary", "text-secondary", "text-tertiary",
  "toggle-active", "toggle-bg", "warn", "warn-line", "warn-soft",
] as const;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function validateSkinDefinition(value: unknown): Finding[] {
  const findings: Finding[] = validateAgainstSchema(value, skinSchema).map((violation) => ({
    code: "MANIFEST_SCHEMA_INVALID",
    pointer: `skin.json:${violation.pointer}`,
    detail: violation.message,
  }));
  if (findings.length > 0 || !isObject(value)) return findings;

  const tokens = isObject(value.tokens) ? value.tokens : {};
  const expected = [...SKIN_TOKEN_NAMES].sort();
  for (const mode of ["light", "dark"] as const) {
    const values = isObject(tokens[mode]) ? tokens[mode] : {};
    const actual = Object.keys(values).sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      findings.push({
        code: "MANIFEST_SCHEMA_INVALID",
        pointer: `skin.json:tokens.${mode}`,
        detail: `必须完整且只覆盖 ${expected.length} 个公开 semantic token`,
      });
      continue;
    }
    for (const [name, raw] of Object.entries(values)) {
      const token = typeof raw === "string" ? raw : "";
      const lower = token.toLowerCase();
      if (
        token.length === 0 || token.length > 160 || lower.includes("url(") ||
        lower.includes("@import") || lower.includes("expression(") || /[;{}\u0000-\u001f\u007f]/.test(token)
      ) {
        findings.push({
          code: "MANIFEST_SCHEMA_INVALID",
          pointer: `skin.json:tokens.${mode}.${name}`,
          detail: "含不安全、非字符串或过长的样式值",
        });
      }
    }
  }
  return findings;
}
