import { message } from "./i18n";
import type { SkillSummary } from "./codex-view";

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};

function valueAt(value: unknown, ...path: string[]): unknown {
  let current = value;
  for (const key of path) current = asRecord(current)[key];
  return current;
}

function stringAt(value: unknown, ...path: string[]): string | undefined {
  const current = valueAt(value, ...path);
  return typeof current === "string" ? current : undefined;
}

function arrayAt(value: unknown, ...path: string[]): unknown[] {
  const current = valueAt(value, ...path);
  return Array.isArray(current) ? current : [];
}

/** `skills/list` 的官方结果转成只含启用项的视图快照。 */
export function normalizeSkills(payload: unknown, cwd: string): SkillSummary[] {
  const entries = arrayAt(payload, "data");
  const entry = entries.find((candidate) => stringAt(candidate, "cwd") === cwd);
  if (!entry) return [];
  return arrayAt(entry, "skills")
    .filter((raw) => valueAt(raw, "enabled") === true)
    .map((raw): SkillSummary | undefined => {
      const name = stringAt(raw, "name");
      if (!name) return undefined;
      const displayName = stringAt(raw, "interface", "displayName") ?? name;
      const description =
        stringAt(raw, "interface", "shortDescription") ??
        stringAt(raw, "shortDescription") ??
        stringAt(raw, "description") ??
        message("ui.m152");
      return {
        name,
        displayName,
        description: typeof description === "string" ? description.slice(0, 240) : description,
        scope: stringAt(raw, "scope") ?? "unknown",
      };
    })
    .filter((skill): skill is SkillSummary => Boolean(skill))
    .sort((left, right) => left.displayName.localeCompare(right.displayName));
}
