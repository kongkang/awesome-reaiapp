/** 输入框三模式。与 SDK 的 CodexTurnMode 同形（插件不直接依赖 SDK 内部路径）。 */
export type CodexTurnMode = "chat" | "plan" | "yolo";

const MODES = new Set<CodexTurnMode>(["chat", "plan", "yolo"]);

export const isCodexTurnMode = (value: unknown): value is CodexTurnMode =>
  typeof value === "string" && MODES.has(value as CodexTurnMode);

export const TURN_MODES: CodexTurnMode[] = ["chat", "plan", "yolo"];
