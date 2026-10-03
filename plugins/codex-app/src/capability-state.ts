export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface EffortSummary {
  value: ReasoningEffort;
  label: string;
  description: string;
}

export interface ModelSummary {
  id: string;
  displayName: string;
  isDefault: boolean;
  defaultEffort?: ReasoningEffort;
  efforts: EffortSummary[];
}

export interface UsageSummary {
  primaryUsedPercent?: number;
  primaryResetsAt?: number;
  secondaryUsedPercent?: number;
  secondaryResetsAt?: number;
  lifetimeTokens?: number;
}

const EFFORTS = new Set<ReasoningEffort>([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;
const finite = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;
const effort = (value: unknown): ReasoningEffort | undefined =>
  typeof value === "string" && EFFORTS.has(value as ReasoningEffort)
    ? value as ReasoningEffort
    : undefined;
const epochMs = (value: unknown): number | undefined => {
  const numeric = finite(value);
  if (numeric === undefined) return undefined;
  return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
};

/** 只投影 app-server model/list 返回且当前 Host 协议可表达的模型与 effort。 */
export function normalizeModels(payload: unknown): ModelSummary[] {
  const root = record(payload);
  const rows = array(root.data).length > 0 ? array(root.data) : array(root.models);
  return rows.flatMap((raw): ModelSummary[] => {
    const row = record(raw);
    if (row.hidden === true) return [];
    const id = text(row.model) ?? text(row.id);
    if (!id) return [];
    const efforts = array(row.supportedReasoningEfforts).flatMap((rawEffort): EffortSummary[] => {
      const entry = record(rawEffort);
      const value = effort(entry.reasoningEffort);
      if (!value) return [];
      return [{
        value,
        label: value,
        description: text(entry.description) ?? "",
      }];
    });
    const defaultEffort = effort(row.defaultReasoningEffort);
    return [{
      id,
      displayName: text(row.displayName) ?? id,
      isDefault: row.isDefault === true,
      ...(defaultEffort ? { defaultEffort } : {}),
      efforts,
    }];
  });
}

export function chooseModelSelection(
  models: ModelSummary[],
  preferred?: { model?: string; effort?: ReasoningEffort },
): { model: string; effort?: ReasoningEffort } | undefined {
  const model = models.find((entry) => entry.id === preferred?.model) ??
    models.find((entry) => entry.isDefault) ?? models[0];
  if (!model) return undefined;
  const supported = model.efforts.map((entry) => entry.value);
  const selectedEffort = preferred?.effort && supported.includes(preferred.effort)
    ? preferred.effort
    : model.defaultEffort && supported.includes(model.defaultEffort)
      ? model.defaultEffort
      : supported[0];
  return { model: model.id, ...(selectedEffort ? { effort: selectedEffort } : {}) };
}

/** account/rateLimits/read 与 account/usage/read 的只读视图。 */
export function normalizeUsageSnapshot(ratePayload: unknown, usagePayload: unknown): UsageSummary {
  const rateLimits = record(record(ratePayload).rateLimits);
  const primary = record(rateLimits.primary);
  const secondary = record(rateLimits.secondary);
  const summary = record(record(usagePayload).summary);
  const result: UsageSummary = {};
  const primaryUsed = finite(primary.usedPercent);
  const primaryReset = epochMs(primary.resetsAt);
  const secondaryUsed = finite(secondary.usedPercent);
  const secondaryReset = epochMs(secondary.resetsAt);
  const lifetimeTokens = finite(summary.lifetimeTokens);
  if (primaryUsed !== undefined) result.primaryUsedPercent = primaryUsed;
  if (primaryReset !== undefined) result.primaryResetsAt = primaryReset;
  if (secondaryUsed !== undefined) result.secondaryUsedPercent = secondaryUsed;
  if (secondaryReset !== undefined) result.secondaryResetsAt = secondaryReset;
  if (lifetimeTokens !== undefined) result.lifetimeTokens = lifetimeTokens;
  return result;
}

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === "string" && EFFORTS.has(value as ReasoningEffort);
}
