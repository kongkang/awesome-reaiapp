import { configureChatI18n } from "@reai/chat-ui";
import zh from "../assets/locales/zh.json";
import en from "../assets/locales/en.json";
import { diagnosticLogFields } from "./voice-error-fields";

/** The JSON shipped in assets is the only resource source. No language is persisted here. */
export type TextSource = string | undefined | null | (() => TextSource);
let locale: "zh" | "en" = "zh";
const listeners = new Set<() => void>();
const bindings = new Set<{ node: WeakRef<Node>; attribute?: string; update: (node: Node) => void }>();

export function voiceLocale(): "zh" | "en" { return locale; }
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
    console.warn(`[voice:i18n] Missing message: ${key}`);
    return key;
  }
  // A single replacement pass: interpolation values are never parsed as messages or HTML.
  return message.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (match, name: string) =>
    Object.hasOwn(params, name) ? String(params[name]) : match);
}
export function setVoiceLocale(value: string): void {
  const next = value === "zh" ? "zh" : "en";
  if (next === locale) return;
  locale = next;
  for (const binding of bindings) {
    const node = binding.node.deref();
    if (!node) { bindings.delete(binding); continue; }
    // Host 会把插件 console 转进 App 日志：只打结构化投影，异常原文可能带插值参数（§6.0 白名单）。
    try { binding.update(node); } catch (cause) { console.warn("[voice:i18n] Text binding failed", diagnosticLogFields(cause)); }
  }
  for (const listener of listeners) {
    try { listener(); } catch (cause) { console.warn("[voice:i18n] Locale listener failed", diagnosticLogFields(cause)); }
  }
}
export function onVoiceLocaleChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
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

configureChatI18n({ t, bindText, bindAttribute, releaseLocaleBindings });
