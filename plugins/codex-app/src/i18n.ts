import zh from "../assets/locales/zh.json";
import en from "../assets/locales/en.json";

type Dictionary = { [key: string]: string | Dictionary };
export interface Message { readonly key: string; readonly params: Readonly<Record<string, unknown>> }
export type LocalizedText = string | Message;
let locale = "zh";
const missing = new Set<string>();
export function setLocale(value: string): boolean {
  const next = value === "zh" ? "zh" : "en";
  const changed = next !== locale;
  locale = next;
  return changed;
}
export const currentLocale = () => locale === "zh" ? "zh-CN" : "en-US";
export const message = (key: string, params: Record<string, unknown> = {}): Message => ({ key, params });
export const resolveText = (value: LocalizedText): string => typeof value === "string" ? value : t(value.key, value.params);
export function t(key: string, params: Readonly<Record<string, unknown>> = {}): string {
  const lookup = (dict: Dictionary): string | undefined => {
    let value: string | Dictionary | undefined = dict;
    for (const part of key.split(".")) value = typeof value === "object" ? value[part] : undefined;
    return typeof value === "string" ? value : undefined;
  };
  const resolved = lookup(locale === "zh" ? zh : en) ?? lookup(en);
  if (resolved === undefined && !missing.has(key)) {
    missing.add(key); console.warn(`[i18n] Missing message: ${key}`);
  }
  return (resolved ?? key).replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (token, name: string) =>
    Object.hasOwn(params, name) ? String(params[name]) : token);
}

/** Locale-only projection: preserve controls, listeners, selection, focus, and scroll. */
export function patchLocalizedContent(current: Node, next: Node): void {
  if (current.nodeType !== next.nodeType) return;
  if (current.nodeType === 3) {
    // Assigning the same text can still collapse a browser Range anchored inside it.
    if (current.nodeValue !== next.nodeValue) current.nodeValue = next.nodeValue;
    return;
  }
  if (current instanceof HTMLElement && next instanceof HTMLElement) {
    if (current.tagName !== next.tagName) return;
    // Validation reflects a user action, so a locale render must not clear it.
    if (current.dataset.messageKey) {
      const text = t(current.dataset.messageKey);
      if (current.textContent !== text) current.textContent = text;
      return;
    }
    for (const name of ["aria-label", "title", "placeholder"]) {
      const value = next.getAttribute(name);
      if (value !== null && current.getAttribute(name) !== value) current.setAttribute(name, value);
    }
  }
  const oldChildren = Array.from(current.childNodes), newChildren = Array.from(next.childNodes);
  if (oldChildren.length !== newChildren.length) return;
  oldChildren.forEach((child, index) => patchLocalizedContent(child, newChildren[index]!));
}
