import { isReasoningEffort, type ReasoningEffort } from "./capability-state";
import { isCodexTurnMode, type CodexTurnMode } from "./turn-mode";

const PREFERENCES_KEY = "selection";

interface PreferenceStore {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
}

export interface CodexPreferences {
  model: string;
  effort: ReasoningEffort;
  /** 三模式缺省 plan；老版本（schemaVersion 1）的存量偏好回落到 plan。 */
  mode: CodexTurnMode;
}

export async function loadPreferences(
  store: PreferenceStore,
): Promise<CodexPreferences | undefined> {
  const raw = await store.get(PREFERENCES_KEY);
  if (!raw || typeof raw !== "object") return undefined;
  const value = raw as Record<string, unknown>;
  if (
    typeof value.model !== "string" ||
    value.model.length === 0 ||
    !isReasoningEffort(value.effort)
  ) return undefined;
  const mode = isCodexTurnMode(value.mode) ? value.mode : "plan";
  return { model: value.model, effort: value.effort, mode };
}

export async function savePreferences(
  store: PreferenceStore,
  preferences: CodexPreferences,
): Promise<void> {
  await store.set(PREFERENCES_KEY, { schemaVersion: 2, ...preferences });
}
