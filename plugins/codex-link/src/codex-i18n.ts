import zh from "../assets/locales/zh.json";
import en from "../assets/locales/en.json";

/** The JSON shipped in assets is the only resource source. No language is persisted here. */
export type TextSource = string | undefined | null | (() => TextSource);
let locale: "zh" | "en" = "zh";
const bindings = new Set<{ node: WeakRef<Node>; attribute?: string; update: (node: Node) => void }>();

export function codexLocale(): "zh" | "en" { return locale; }
export function readText(source: TextSource): string {
  return typeof source === "function" ? readText(source()) : source ?? "";
}
function lookup(table: unknown, key: string): string | undefined {
  let value = table;
  for (const part of key.split(".")) {
    if (!value || typeof value !== "object" || !Object.hasOwn(value, part)) return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return typeof value === "string" ? value : undefined;
}
export function t(key: string, params: Record<string, string | number | undefined> = {}): string {
  const message = lookup(locale === "zh" ? zh : en, key) ?? lookup(en, key);
  if (message === undefined) {
    console.warn(`[codex-link:i18n] Missing message: ${key}`);
    return key;
  }
  // A single replacement pass: interpolation values are never parsed as messages or HTML.
  return message.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (match, name: string) =>
    Object.hasOwn(params, name) ? String(params[name]) : match);
}
export function setCodexLocale(value: string): void {
  const next = value === "zh" ? "zh" : "en";
  if (next === locale) return;
  locale = next;
  for (const binding of bindings) {
    const node = binding.node.deref();
    if (!node) { bindings.delete(binding); continue; }
    try { binding.update(node); } catch (cause) { console.warn("[codex-link:i18n] Text binding failed", cause); }
  }
}
export function bindText(node: Node, source: TextSource): void {
  // Own a Text node, never replace an element's children during a language update.
  // Consumers may append icons or controls after assigning this initial text.
  let target = node;
  if (node.nodeType !== Node.TEXT_NODE) {
    for (const child of Array.from(node.childNodes)) releaseLocaleBindings(child);
    target = document.createTextNode("");
    node.textContent = "";
    node.appendChild(target);
  }
  const update = (text: Node) => {
    const value = readText(source);
    if (text.textContent !== value) text.textContent = value;
  };
  // Direct Text-node consumers can rebind without replacing a parent element.
  // A static replacement must also retire the previous dynamic source.
  for (const binding of bindings) {
    if (binding.node.deref() === target && binding.attribute === undefined) bindings.delete(binding);
  }
  update(target);
  if (typeof source === "function") bindings.add({ node: new WeakRef(target), update });
}
export function bindAttribute(node: Element, name: string, source: TextSource): void {
  for (const binding of bindings) {
    if (binding.node.deref() === node && binding.attribute === name) bindings.delete(binding);
  }
  const update = (target: Node) => {
    const element = target as Element;
    const value = readText(source);
    if (element.getAttribute(name) !== value) element.setAttribute(name, value);
  };
  update(node);
  if (typeof source === "function") bindings.add({ node: new WeakRef(node), attribute: name, update });
}
/** Release bindings when a view's normal business render replaces its nodes, or on cleanup. */
export function releaseLocaleBindings(root: Node): void {
  for (const binding of bindings) {
    const node = binding.node.deref();
    if (!node || node === root || root.contains(node)) bindings.delete(binding);
  }
}
export function localizedTextNode(source: TextSource): Text {
  const node = document.createTextNode("");
  bindText(node, source);
  return node;
}

/** Minimal read-only port; SDK snapshots carry additional Host ordering fields. */
export interface CodexLocalePort {
  getSnapshot(): { locale: string };
  onChange(listener: (snapshot: { locale: string }) => void): () => void;
}
export const text = (key: string, params: Record<string, string | number | undefined> = {}): (() => string) =>
  () => t(key, params);
export class CodexMessageError extends Error {
  constructor(public readonly messageKey: string, public readonly params: Record<string, string | number | undefined> = {}, options?: ErrorOptions) {
    super(t(messageKey, params), options);
    this.name = "CodexMessageError";
  }
  getLocalizedMessage(): string { return t(this.messageKey, this.params); }
}
/** Called only during ordinary rendering, never by a language notification. */
export function replaceChildren(node: Element, ...children: (Node | string)[]): void {
  releaseLocaleBindings(node);
  node.replaceChildren(...children);
}
/** Bind only explicit, authored markers. Never discover translations from user text. */
export function bindTemplate(root: Element): void {
  for (const node of Array.from(root.querySelectorAll<HTMLElement>("[data-i18n]"))) {
    bindText(node, text(node.dataset.i18n!));
  }
  for (const attribute of ["aria-label", "title", "placeholder"]) {
    for (const node of Array.from(root.querySelectorAll<HTMLElement>(`[data-i18n-${attribute}]`))) {
      const key = node.getAttribute(`data-i18n-${attribute}`)!;
      // Parameterized labels are bound explicitly by the business owner once
      // it has the real values. Never substitute an invented zero on mount.
      if (/\{[A-Za-z][A-Za-z0-9_]*\}/.test(t(key))) continue;
      bindAttribute(node, attribute, text(key));
    }
  }
}
