export interface TerminalColorSchemeV1 {
  schemaVersion: 1;
  id: string;
  name: string;
  appearance: "light" | "dark";
  colors: TerminalColors;
}

export interface TerminalColors {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent?: string;
  selectionBackground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

export interface TerminalSchemePreferences {
  followAppTheme: boolean;
  schemeId: string;
  lightSchemeId: string;
  darkSchemeId: string;
}

export interface TerminalSchemeSurfaceTokens {
  workspace: string;
  pane: string;
  header: string;
  headerActive: string;
  border: string;
  divider: string;
  muted: string;
  compact: string;
  compactCore: string;
  accent: string;
  accentContrast: string;
}

const REQUIRED_COLOR_KEYS = [
  "background", "foreground", "cursor", "selectionBackground", "black", "red", "green",
  "yellow", "blue", "magenta", "cyan", "white", "brightBlack", "brightRed", "brightGreen",
  "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite",
] as const;
const ALLOWED_COLOR_KEYS = new Set<string>([...REQUIRED_COLOR_KEYS, "cursorAccent"]);
const HEX_COLOR = /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i;
const MAX_IMPORT_BYTES = 64 * 1024;
const MAX_CUSTOM_SCHEMES = 8;
const BUILTIN_SCHEME_IDS = new Set(["paper-light", "warm-light", "classic-dark", "dusk-dark"]);

const classicDark: TerminalColorSchemeV1 = {
  schemaVersion: 1,
  id: "classic-dark",
  name: "Classic Dark",
  appearance: "dark",
  colors: {
    background: "#151620", foreground: "#cbd0dd", cursor: "#9e9ef9", cursorAccent: "#151620",
    selectionBackground: "#2c2d42", black: "#1b1c27", red: "#f87171", green: "#67d391",
    yellow: "#ffc36b", blue: "#7777ee", magenta: "#c084fc", cyan: "#22d3ee",
    white: "#e2e8f0", brightBlack: "#777a8e", brightRed: "#fca5a5",
    brightGreen: "#86efac", brightYellow: "#fde047", brightBlue: "#93c5fd",
    brightMagenta: "#d8b4fe", brightCyan: "#67e8f9", brightWhite: "#ffffff",
  },
};

const paperLight: TerminalColorSchemeV1 = {
  schemaVersion: 1,
  id: "paper-light",
  name: "Paper Light",
  appearance: "light",
  colors: {
    background: "#fbfbfd", foreground: "#1d1d1f", cursor: "#166534", cursorAccent: "#ffffff",
    selectionBackground: "#c7ddff", black: "#1d1d1f", red: "#b42318", green: "#137333",
    yellow: "#8a5d00", blue: "#185abc", magenta: "#8430a6", cyan: "#007b83",
    white: "#f1f3f4", brightBlack: "#667085", brightRed: "#d93025",
    brightGreen: "#188038", brightYellow: "#b06000", brightBlue: "#1a73e8",
    brightMagenta: "#a142f4", brightCyan: "#0097a7", brightWhite: "#ffffff",
  },
};

const duskDark: TerminalColorSchemeV1 = {
  ...classicDark,
  id: "dusk-dark",
  name: "Dusk Dark",
  colors: {
    ...classicDark.colors,
    background: "#15131c",
    foreground: "#f3eefb",
    cursor: "#d0a8ff",
    cursorAccent: "#15131c",
    selectionBackground: "#251f31",
    black: "#201c29",
    green: "#7ed6a5",
    yellow: "#f2c879",
    blue: "#8ab4f8",
    brightBlack: "#8f869d",
    magenta: "#d0a8ff",
  },
};

const warmLight: TerminalColorSchemeV1 = {
  ...paperLight,
  id: "warm-light",
  name: "Warm Light",
  colors: {
    ...paperLight.colors,
    background: "#fffaf2",
    foreground: "#2f2923",
    cursor: "#8f4c2d",
    selectionBackground: "#f3dfbd",
    green: "#3f7d55",
    yellow: "#9b6200",
    blue: "#9a4f2f",
    brightBlack: "#766b61",
  },
};

export const BUILTIN_TERMINAL_SCHEMES = [
  paperLight,
  warmLight,
  classicDark,
  duskDark,
] as const;

export function terminalSchemeAccent(scheme: TerminalColorSchemeV1): string {
  return scheme.colors.blue;
}

const BUILTIN_SURFACES: Readonly<Record<string, TerminalSchemeSurfaceTokens>> = {
  "classic-dark": {
    workspace: "#0f1018", pane: "#151620", header: "#1b1c27",
    headerActive: "#1d1e2b", border: "#2a2c38", divider: "#292b37",
    muted: "#777a8e", compact: "#191a24", compactCore: "#22232e",
    accent: "#7777ee", accentContrast: "#ffffff",
  },
  "dusk-dark": {
    workspace: "#111019", pane: "#15131c", header: "#201c29",
    headerActive: "#251f31", border: "#383143", divider: "#352f40",
    muted: "#8f869d", compact: "#18151f", compactCore: "#282130",
    accent: "#8ab4f8", accentContrast: "#101827",
  },
  "paper-light": {
    workspace: "#e8ebf1", pane: "#fbfbfd", header: "#f1f3f6",
    headerActive: "#e8eef8", border: "#cdd2dc", divider: "#d9dde5",
    muted: "#667085", compact: "#eef1f5", compactCore: "#ffffff",
    accent: "#185abc", accentContrast: "#ffffff",
  },
  "warm-light": {
    workspace: "#f0e9de", pane: "#fffaf2", header: "#f8efe2",
    headerActive: "#f2e3d2", border: "#d9cbb8", divider: "#e5d8c7",
    muted: "#766b61", compact: "#f6ede1", compactCore: "#fffaf2",
    accent: "#9a4f2f", accentContrast: "#ffffff",
  },
};

export function terminalSchemeSurfaceTokens(
  scheme: TerminalColorSchemeV1,
): TerminalSchemeSurfaceTokens {
  const builtin = BUILTIN_SURFACES[scheme.id];
  if (builtin) return { ...builtin };
  return {
    workspace: scheme.colors.black,
    pane: scheme.colors.background,
    header: scheme.colors.black,
    headerActive: scheme.colors.selectionBackground,
    border: scheme.colors.brightBlack,
    divider: scheme.colors.brightBlack,
    muted: scheme.colors.brightBlack,
    compact: scheme.colors.black,
    compactCore: scheme.colors.selectionBackground,
    accent: scheme.colors.blue,
    accentContrast: scheme.colors.cursorAccent ?? scheme.colors.background,
  };
}

type ValidationResult =
  | { ok: true; value: TerminalColorSchemeV1 }
  | { ok: false; error: string; params?: Record<string, string> };
type ImportResult =
  | { ok: true; scheme: TerminalColorSchemeV1; schemes: TerminalColorSchemeV1[] }
  | { ok: false; error: string; params?: Record<string, string> };

export function validateTerminalColorScheme(value: unknown): ValidationResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "themeObject" };
  }
  const input = value as Record<string, unknown>;
  const allowedTop = new Set(["schemaVersion", "id", "name", "appearance", "colors"]);
  if (Object.keys(input).some((key) => !allowedTop.has(key))) {
    return { ok: false, error: "themeUnknownFields" };
  }
  if (input.schemaVersion !== 1) return { ok: false, error: "themeVersion" };
  if (typeof input.id !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(input.id)) {
    return { ok: false, error: "themeId" };
  }
  if (BUILTIN_SCHEME_IDS.has(input.id)) return { ok: false, error: "themeBuiltin" };
  if (typeof input.name !== "string" || !input.name.trim() || Array.from(input.name).length > 80) {
    return { ok: false, error: "themeName" };
  }
  if (input.appearance !== "light" && input.appearance !== "dark") {
    return { ok: false, error: "themeAppearance" };
  }
  if (!input.colors || typeof input.colors !== "object" || Array.isArray(input.colors)) {
    return { ok: false, error: "themeColors" };
  }
  const colors = input.colors as Record<string, unknown>;
  if (Object.keys(colors).some((key) => !ALLOWED_COLOR_KEYS.has(key))) {
    return { ok: false, error: "themeColorFields" };
  }
  for (const key of REQUIRED_COLOR_KEYS) {
    if (typeof colors[key] !== "string" || !HEX_COLOR.test(colors[key] as string)) {
      return { ok: false, error: "invalidColor", params: { name: key } };
    }
  }
  if (
    colors.cursorAccent !== undefined
    && (typeof colors.cursorAccent !== "string" || !HEX_COLOR.test(colors.cursorAccent))
  ) {
    return { ok: false, error: "themeCursorAccent" };
  }
  return { ok: true, value: value as TerminalColorSchemeV1 };
}

export function importTerminalColorScheme(
  json: string,
  current: TerminalColorSchemeV1[],
  conflict: "copy" | "replace",
): ImportResult {
  if (new TextEncoder().encode(json).length > MAX_IMPORT_BYTES) {
    return { ok: false, error: "themeFileSize" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { ok: false, error: "themeJson" };
  }
  const validation = validateTerminalColorScheme(parsed);
  if (!validation.ok) return validation;
  let scheme = validation.value;
  const existingIndex = current.findIndex((item) => item.id === scheme.id);
  const addsNew = existingIndex < 0 || conflict === "copy";
  if (addsNew && current.length >= MAX_CUSTOM_SCHEMES) {
    return { ok: false, error: "themeLimit" };
  }
  if (existingIndex >= 0 && conflict === "copy") {
    let suffix = 1;
    const copyId = () => {
      const ending = suffix === 1 ? "-copy" : `-copy-${suffix}`;
      return `${scheme.id.slice(0, 64 - ending.length)}${ending}`;
    };
    let id = copyId();
    while (current.some((item) => item.id === id)) {
      suffix += 1;
      id = copyId();
    }
    const name = `${Array.from(scheme.name).slice(0, 75).join("")} Copy`;
    scheme = { ...scheme, id, name };
  }
  const schemes = [...current];
  const replaceIndex = schemes.findIndex((item) => item.id === scheme.id);
  if (replaceIndex >= 0) schemes.splice(replaceIndex, 1, scheme);
  else schemes.push(scheme);
  return { ok: true, scheme, schemes };
}

export function resolveTerminalScheme(
  preferences: TerminalSchemePreferences,
  appearance: "light" | "dark",
  custom: TerminalColorSchemeV1[],
): TerminalColorSchemeV1 | undefined {
  const all: TerminalColorSchemeV1[] = [...custom, ...BUILTIN_TERMINAL_SCHEMES];
  const id = preferences.followAppTheme
    ? (appearance === "light" ? preferences.lightSchemeId : preferences.darkSchemeId)
    : preferences.schemeId;
  return all.find((scheme) => scheme.id === id)
    ?? all.find((scheme) => scheme.appearance === appearance)
    ?? all[0];
}

/** 让会缓存 OSC 10/11 的 TUI 在换 palette 后重新查询。 */
export function refreshTerminalPalette(term: { blur(): void; focus(): void }): void {
  term.blur();
  term.focus();
}
