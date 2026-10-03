import zh from "../assets/locales/zh.json";
import en from "../assets/locales/en.json";

type Dictionary = { [key: string]: string | Dictionary };
let language = "zh";
const missingKeys = new Set<string>();
export function setLocale(locale: string): boolean {
  const next = locale === "zh" ? "zh" : "en";
  const changed = next !== language;
  language = next;
  return changed;
}
export const currentLocale = () => language === "zh" ? "zh-CN" : "en-US";
export function t(key: string, params: Record<string, unknown> = {}): string {
  const lookup = (dict: Dictionary): string | undefined => {
    let value: string | Dictionary | undefined = dict;
    for (const part of key.split(".")) value = typeof value === "object" ? value[part] : undefined;
    return typeof value === "string" ? value : undefined;
  };
  const resolved = lookup(language === "zh" ? zh : en) ?? lookup(en);
  if (resolved === undefined && !missingKeys.has(key)) {
    missingKeys.add(key);
    console.warn(`[i18n] Missing message: ${key}`);
  }
  const text = resolved ?? key;
  return text.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (token, name: string) =>
    Object.hasOwn(params, name) ? String(params[name]) : token);
}

/** Apply new render text to existing nodes. Input, focus, listeners and scroll stay intact. */
export function updateLocalizedMarkup(root: HTMLElement, html: string): void {
  const template = root.ownerDocument.createElement("template");
  template.innerHTML = html;
  const patch = (current: Node, next: Node): void => {
    if (current.nodeType !== next.nodeType) return;
    if (current.nodeType === 3) { current.nodeValue = next.nodeValue; return; }
    if (current instanceof HTMLElement && next instanceof HTMLElement) {
      if (current.tagName !== next.tagName) return;
      for (const name of ["aria-label", "title", "placeholder"]) {
        const value = next.getAttribute(name);
        if (value !== null) current.setAttribute(name, value);
      }
    }
    const oldChildren = Array.from(current.childNodes), newChildren = Array.from(next.childNodes);
    if (oldChildren.length !== newChildren.length) return;
    oldChildren.forEach((child, index) => patch(child, newChildren[index]));
  };
  const nextChildren = Array.from(template.content.childNodes);
  if (root.childNodes.length !== nextChildren.length) return;
  Array.from(root.childNodes).forEach((child, index) => patch(child, nextChildren[index]));
}
