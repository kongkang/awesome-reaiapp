import type { KeyValueStore } from "@reai/app-sdk/v1";
import {
  BUILTIN_TERMINAL_SCHEMES,
  resolveTerminalScheme,
  validateTerminalColorScheme,
  type TerminalColorSchemeV1,
} from "./terminal-theme";

export type TerminalCursorStyle = "block" | "bar" | "underline";

export interface TerminalPreferences {
  followAppTheme: boolean;
  schemeId: string;
  lightSchemeId: string;
  darkSchemeId: string;
  fontSize: number;
  cursorStyle: TerminalCursorStyle;
  cursorBlink: boolean;
  scrollback: number;
  customSchemes: TerminalColorSchemeV1[];
}

export const DEFAULT_TERMINAL_PREFERENCES: TerminalPreferences = {
  followAppTheme: false,
  schemeId: "classic-dark",
  lightSchemeId: "paper-light",
  darkSchemeId: "classic-dark",
  fontSize: 11,
  cursorStyle: "block",
  cursorBlink: true,
  scrollback: 1_000,
  customSchemes: [],
};

const PREFERENCES_KEY = "preferences";
const SCROLLBACK_VALUES = new Set([1_000, 5_000, 10_000, 50_000, 100_000]);
const CURSOR_STYLES = new Set<TerminalCursorStyle>(["block", "bar", "underline"]);

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function sanitize(raw: unknown): TerminalPreferences {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return clone(DEFAULT_TERMINAL_PREFERENCES);
  }
  const value = raw as Record<string, unknown>;
  if (value.schemaVersion !== 1) return clone(DEFAULT_TERMINAL_PREFERENCES);
  const customSchemes = Array.isArray(value.customSchemes)
    ? value.customSchemes.flatMap((candidate) => {
      const result = validateTerminalColorScheme(candidate);
      return result.ok ? [result.value] : [];
    }).slice(0, 8)
    : [];
  const allIds = new Set([
    ...BUILTIN_TERMINAL_SCHEMES.map((scheme) => scheme.id),
    ...customSchemes.map((scheme) => scheme.id),
  ]);
  const stringId = (candidate: unknown, fallback: string) =>
    typeof candidate === "string" && allIds.has(candidate) ? candidate : fallback;
  const fontSize = typeof value.fontSize === "number" && Number.isInteger(value.fontSize)
    ? Math.max(9, Math.min(24, value.fontSize))
    : DEFAULT_TERMINAL_PREFERENCES.fontSize;
  const cursorStyle = typeof value.cursorStyle === "string" && CURSOR_STYLES.has(value.cursorStyle as TerminalCursorStyle)
    ? value.cursorStyle as TerminalCursorStyle
    : DEFAULT_TERMINAL_PREFERENCES.cursorStyle;
  const scrollback = typeof value.scrollback === "number" && SCROLLBACK_VALUES.has(value.scrollback)
    ? value.scrollback
    : DEFAULT_TERMINAL_PREFERENCES.scrollback;
  return {
    followAppTheme: value.followAppTheme === true,
    schemeId: stringId(value.schemeId, DEFAULT_TERMINAL_PREFERENCES.schemeId),
    lightSchemeId: stringId(value.lightSchemeId, DEFAULT_TERMINAL_PREFERENCES.lightSchemeId),
    darkSchemeId: stringId(value.darkSchemeId, DEFAULT_TERMINAL_PREFERENCES.darkSchemeId),
    fontSize,
    cursorStyle,
    cursorBlink: value.cursorBlink !== false,
    scrollback,
    customSchemes,
  };
}

export function currentAppearance(): "light" | "dark" {
  const hostScheme = globalThis.getComputedStyle?.(document.documentElement).colorScheme;
  if (hostScheme?.split(/\s+/).includes("light")) return "light";
  if (hostScheme?.split(/\s+/).includes("dark")) return "dark";
  return globalThis.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

export function resolvedTerminalScheme(preferences: TerminalPreferences): TerminalColorSchemeV1 {
  return resolveTerminalScheme(preferences, currentAppearance(), preferences.customSchemes)
    ?? BUILTIN_TERMINAL_SCHEMES[2];
}

export class TerminalPreferencesStore {
  #value = clone(DEFAULT_TERMINAL_PREFERENCES);
  #listeners = new Set<(value: TerminalPreferences) => void>();
  #saveTail: Promise<void> = Promise.resolve();
  #revision = 0;

  constructor(private readonly store: KeyValueStore) {}

  get value(): TerminalPreferences { return clone(this.#value); }

  async load(): Promise<TerminalPreferences> {
    this.#value = sanitize(await this.store.get(PREFERENCES_KEY));
    this.#emit();
    return this.value;
  }

  save(next: TerminalPreferences): Promise<void> {
    const previous = this.value;
    this.#value = sanitize({ schemaVersion: 1, ...next });
    const snapshot = this.value;
    const revision = ++this.#revision;
    this.#emit();
    const write = this.#saveTail
      .then(() => this.store.set(PREFERENCES_KEY, { schemaVersion: 1, ...snapshot }))
      .catch((cause) => {
        if (this.#revision === revision) {
          this.#value = previous;
          this.#emit();
        }
        throw cause;
      });
    this.#saveTail = write.catch(() => undefined);
    return write;
  }

  subscribe(listener: (value: TerminalPreferences) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #emit(): void {
    const snapshot = this.value;
    for (const listener of this.#listeners) listener(snapshot);
  }
}
