import type { AgentTokenUsage } from "@reai/app-sdk/v1";

/** Whitelist and copy Host snapshots; old histories must not acquire invented metadata. */
export function sanitizeAgentUsage(value: unknown): AgentTokenUsage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.complete !== "boolean") return undefined;
  const usage: AgentTokenUsage = { complete: raw.complete };
  for (const key of ["inputTokens", "outputTokens", "totalTokens"] as const) {
    const count = raw[key];
    if (typeof count === "number" && Number.isSafeInteger(count) && count >= 0) usage[key] = count;
    else if (count !== undefined) usage.complete = false;
  }
  if (usage.inputTokens === undefined || usage.outputTokens === undefined || usage.totalTokens === undefined
    || !Number.isSafeInteger(usage.inputTokens + usage.outputTokens)
    || usage.inputTokens + usage.outputTokens !== usage.totalTokens) usage.complete = false;
  if (!usage.complete) delete usage.totalTokens;
  return usage;
}
