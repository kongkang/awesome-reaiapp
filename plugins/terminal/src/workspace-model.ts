export const MIN_TERMINAL_PANE_PX = 56;
export const TERMINAL_SASH_PX = 6;
const COMPACT_ENTER_WIDTH_PX = 210;
const COMPACT_ENTER_HEIGHT_PX = 118;
const COMPACT_EXIT_WIDTH_PX = 238;
const COMPACT_EXIT_HEIGHT_PX = 148;
const SASH_RELEASE_PX = 32;

export type TerminalSplitAxis = "horizontal" | "vertical";
export type TerminalLayoutPreset = "columns" | "rows" | "focus-stack";
export type TerminalLockedSide = "first" | "second" | null;

export interface TerminalPaneModel {
  id: string;
  sessionId: string;
  number: number;
  cwd: string | null;
}

export interface TerminalLeafNode {
  kind: "leaf";
  paneId: string;
}

export interface TerminalSplitNode {
  kind: "split";
  id: string;
  axis: TerminalSplitAxis;
  first: TerminalLayoutNode;
  second: TerminalLayoutNode;
  ratio: number;
  lockedSide: TerminalLockedSide;
}

export type TerminalLayoutNode = TerminalLeafNode | TerminalSplitNode;

export interface TerminalTabModel {
  id: string;
  name: string;
  root: TerminalLayoutNode;
  panes: Record<string, TerminalPaneModel>;
  activePaneId: string;
  focusedPaneId: string | null;
}

export type TabNameResult =
  | { ok: true; name: string }
  | { ok: false; error: string };

export function normalizeTerminalTabName(raw: string): TabNameResult {
  const name = raw.trim();
  if (!name) return { ok: false, error: "emptyName" };
  if (Array.from(name).length > 48) return { ok: false, error: "longName" };
  return { ok: true, name };
}

export function normalizeTerminalDynamicTitle(raw: string): string | null {
  const title = raw
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
    .replace(/[\u061c\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!title) return null;
  const characters = Array.from(title);
  return characters.length <= 48 ? title : `${characters.slice(0, 47).join("")}…`;
}

export function createTerminalPane(
  id: string,
  sessionId: string,
  number: number,
  cwd: string | null = null,
): TerminalPaneModel {
  return { id, sessionId, number, cwd };
}

export function createTerminalTab(
  id: string,
  name: string,
  pane: TerminalPaneModel,
): TerminalTabModel {
  const normalized = normalizeTerminalTabName(name);
  if (!normalized.ok) throw new Error(normalized.error);
  return {
    id,
    name: normalized.name,
    root: { kind: "leaf", paneId: pane.id },
    panes: { [pane.id]: pane },
    activePaneId: pane.id,
    focusedPaneId: null,
  };
}

export function flattenTerminalPaneIds(node: TerminalLayoutNode): string[] {
  if (node.kind === "leaf") return [node.paneId];
  return [...flattenTerminalPaneIds(node.first), ...flattenTerminalPaneIds(node.second)];
}

export function layoutDepth(node: TerminalLayoutNode): number {
  if (node.kind === "leaf") return 1;
  return 1 + Math.max(layoutDepth(node.first), layoutDepth(node.second));
}

export function layoutContainsPane(node: TerminalLayoutNode, paneId: string): boolean {
  if (node.kind === "leaf") return node.paneId === paneId;
  return layoutContainsPane(node.first, paneId) || layoutContainsPane(node.second, paneId);
}

function replaceLeaf(
  node: TerminalLayoutNode,
  paneId: string,
  replacement: TerminalLayoutNode,
): TerminalLayoutNode {
  if (node.kind === "leaf") return node.paneId === paneId ? replacement : node;
  return {
    ...node,
    first: replaceLeaf(node.first, paneId, replacement),
    second: replaceLeaf(node.second, paneId, replacement),
  };
}

export function splitTerminalPane(
  tab: TerminalTabModel,
  targetPaneId: string,
  pane: TerminalPaneModel,
  axis: TerminalSplitAxis,
): TerminalTabModel {
  if (!tab.panes[targetPaneId]) throw new Error(`窗格不存在: ${targetPaneId}`);
  if (tab.panes[pane.id]) throw new Error(`窗格已存在: ${pane.id}`);
  const replacement: TerminalSplitNode = {
    kind: "split",
    id: `split:${targetPaneId}:${pane.id}`,
    axis,
    first: { kind: "leaf", paneId: targetPaneId },
    second: { kind: "leaf", paneId: pane.id },
    ratio: 0.5,
    lockedSide: null,
  };
  return {
    ...tab,
    root: replaceLeaf(tab.root, targetPaneId, replacement),
    panes: { ...tab.panes, [pane.id]: pane },
    activePaneId: pane.id,
    focusedPaneId: null,
  };
}

export function activateTerminalPane(tab: TerminalTabModel, paneId: string): TerminalTabModel {
  if (!tab.panes[paneId] || tab.activePaneId === paneId) return tab;
  return { ...tab, activePaneId: paneId };
}

interface RemovalResult {
  node: TerminalLayoutNode | null;
  fallbackPaneId: string | null;
}

function firstPaneId(node: TerminalLayoutNode): string {
  return node.kind === "leaf" ? node.paneId : firstPaneId(node.first);
}

function removePane(node: TerminalLayoutNode, paneId: string): RemovalResult {
  if (node.kind === "leaf") {
    return node.paneId === paneId
      ? { node: null, fallbackPaneId: null }
      : { node, fallbackPaneId: null };
  }
  if (layoutContainsPane(node.first, paneId)) {
    const removed = removePane(node.first, paneId);
    if (!removed.node) return { node: node.second, fallbackPaneId: firstPaneId(node.second) };
    return { node: { ...node, first: removed.node }, fallbackPaneId: removed.fallbackPaneId };
  }
  if (layoutContainsPane(node.second, paneId)) {
    const removed = removePane(node.second, paneId);
    if (!removed.node) return { node: node.first, fallbackPaneId: firstPaneId(node.first) };
    return { node: { ...node, second: removed.node }, fallbackPaneId: removed.fallbackPaneId };
  }
  return { node, fallbackPaneId: null };
}

export function closeTerminalPane(tab: TerminalTabModel, paneId: string): TerminalTabModel | null {
  if (!tab.panes[paneId]) return tab;
  const removal = removePane(tab.root, paneId);
  if (!removal.node) return null;
  const panes = { ...tab.panes };
  delete panes[paneId];
  const activePaneId = tab.activePaneId === paneId
    ? (removal.fallbackPaneId ?? firstPaneId(removal.node))
    : tab.activePaneId;
  return {
    ...tab,
    root: removal.node,
    panes,
    activePaneId,
    focusedPaneId: tab.focusedPaneId === paneId ? null : tab.focusedPaneId,
  };
}

function chainLeaves(ids: string[], axis: TerminalSplitAxis, prefix: string): TerminalLayoutNode {
  const [first, ...rest] = ids;
  if (!first) throw new Error("终端布局至少需要一个窗格");
  let node: TerminalLayoutNode = { kind: "leaf", paneId: first };
  rest.forEach((paneId, index) => {
    node = {
      kind: "split",
      id: `${prefix}:${index}`,
      axis,
      first: node,
      second: { kind: "leaf", paneId },
      ratio: index === 0 ? 0.5 : (index + 1) / (index + 2),
      lockedSide: null,
    };
  });
  return node;
}

export function reflowTerminalLayout(
  tab: TerminalTabModel,
  preset: TerminalLayoutPreset,
): TerminalTabModel {
  const ids = flattenTerminalPaneIds(tab.root);
  let root: TerminalLayoutNode;
  if (preset === "columns") root = chainLeaves(ids, "horizontal", `layout:${tab.id}:cols`);
  else if (preset === "rows") root = chainLeaves(ids, "vertical", `layout:${tab.id}:rows`);
  else if (ids.length < 2) root = { kind: "leaf", paneId: ids[0]! };
  else {
    root = {
      kind: "split",
      id: `layout:${tab.id}:stack`,
      axis: "horizontal",
      first: { kind: "leaf", paneId: ids[0]! },
      second: chainLeaves(ids.slice(1), "vertical", `layout:${tab.id}:stack-tail`),
      ratio: 0.58,
      lockedSide: null,
    };
  }
  return { ...tab, root, focusedPaneId: null };
}

function onlyAxis(node: TerminalLayoutNode, axis: TerminalSplitAxis): boolean {
  if (node.kind === "leaf") return true;
  return node.axis === axis && onlyAxis(node.first, axis) && onlyAxis(node.second, axis);
}

export function inferTerminalLayoutPreset(
  node: TerminalLayoutNode,
): TerminalLayoutPreset | null {
  const paneCount = flattenTerminalPaneIds(node).length;
  if (paneCount < 2 || node.kind === "leaf") return null;
  if (
    paneCount >= 3
    && node.axis === "horizontal"
    && node.first.kind === "leaf"
    && node.second.kind === "split"
    && node.second.axis === "vertical"
    && onlyAxis(node.second, "vertical")
  ) return "focus-stack";
  if (onlyAxis(node, "horizontal")) return "columns";
  if (onlyAxis(node, "vertical")) return "rows";
  return null;
}

export function minLayoutExtent(node: TerminalLayoutNode, axis: TerminalSplitAxis): number {
  if (node.kind === "leaf") return MIN_TERMINAL_PANE_PX;
  const first = minLayoutExtent(node.first, axis);
  const second = minLayoutExtent(node.second, axis);
  return node.axis === axis ? first + TERMINAL_SASH_PX + second : Math.max(first, second);
}

export interface SashPositionInput {
  containerPx: number;
  pointerPx: number;
  firstMinPx: number;
  secondMinPx: number;
  previousLockedSide: TerminalLockedSide;
}

export interface SashPosition {
  ratio: number;
  lockedSide: TerminalLockedSide;
}

export function resolveSashPosition(input: SashPositionInput): SashPosition {
  const available = Math.max(1, input.containerPx);
  const min = Math.max(MIN_TERMINAL_PANE_PX, input.firstMinPx);
  const max = Math.max(min, available - Math.max(MIN_TERMINAL_PANE_PX, input.secondMinPx));
  const pointer = Math.min(max, Math.max(min, input.pointerPx));
  const firstRelease = min + SASH_RELEASE_PX;
  const secondRelease = max - SASH_RELEASE_PX;
  const lockFirst = input.pointerPx <= firstRelease
    || (input.previousLockedSide === "first" && input.pointerPx <= firstRelease);
  const lockSecond = input.pointerPx >= secondRelease
    || (input.previousLockedSide === "second" && input.pointerPx >= secondRelease);
  if (lockFirst) return { ratio: min / available, lockedSide: "first" };
  if (lockSecond) return { ratio: max / available, lockedSide: "second" };
  return { ratio: pointer / available, lockedSide: null };
}

export function compactPaneOrientation(
  width: number,
  height: number,
  wasCompact = false,
): "horizontal" | "vertical" | null {
  const compact = wasCompact
    ? width < COMPACT_EXIT_WIDTH_PX || height < COMPACT_EXIT_HEIGHT_PX
    : width < COMPACT_ENTER_WIDTH_PX || height < COMPACT_ENTER_HEIGHT_PX;
  if (!compact) return null;
  return width >= height ? "horizontal" : "vertical";
}

export interface SplitTracks {
  firstPx: number;
  secondPx: number;
}

export function focusSplitTracks(
  node: TerminalSplitNode,
  containerPx: number,
  paneId: string,
): SplitTracks {
  const available = Math.max(0, containerPx - TERMINAL_SASH_PX);
  if (layoutContainsPane(node.first, paneId)) {
    const secondPx = Math.min(available, minLayoutExtent(node.second, node.axis));
    return { firstPx: available - secondPx, secondPx };
  }
  if (layoutContainsPane(node.second, paneId)) {
    const firstPx = Math.min(available, minLayoutExtent(node.first, node.axis));
    return { firstPx, secondPx: available - firstPx };
  }
  const firstPx = Math.round(available * node.ratio);
  return { firstPx, secondPx: available - firstPx };
}

export function updateTerminalSplit(
  node: TerminalLayoutNode,
  splitId: string,
  position: SashPosition,
): TerminalLayoutNode {
  if (node.kind === "leaf") return node;
  if (node.id === splitId) return { ...node, ...position };
  return {
    ...node,
    first: updateTerminalSplit(node.first, splitId, position),
    second: updateTerminalSplit(node.second, splitId, position),
  };
}
