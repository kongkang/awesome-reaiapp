/** 三种视图模式，命名与设计稿 te-modes 及 Codex App 侧面板对齐。 */
export type TeMode = "document" | "source" | "diff";

export const TE_MODES: readonly TeMode[] = ["document", "source", "diff"];

export function isTeMode(value: unknown): value is TeMode {
  return typeof value === "string" && (TE_MODES as readonly string[]).includes(value);
}
