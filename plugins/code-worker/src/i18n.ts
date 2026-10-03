import zh from "../assets/locales/zh.json";
import en from "../assets/locales/en.json";
type Dictionary = { [key: string]: string | Dictionary };
export function createI18n(initial: string) {
  let locale = initial === "zh" ? "zh" : "en";
  const lookup = (dict: Dictionary, key: string): string | undefined => {
    let value: string | Dictionary | undefined = dict;
    for (const part of key.split(".")) value = typeof value === "object" ? value[part] : undefined;
    return typeof value === "string" ? value : undefined;
  };
  return {
    setLocale(value: string) { const next = value === "zh" ? "zh" : "en"; const changed = next !== locale; locale = next; return changed; },
    t(key: string, params: Record<string, unknown> = {}) {
      const value = lookup(locale === "zh" ? zh : en, key) ?? lookup(en, key);
      if (!value) throw new Error(`Missing localization: ${key}`);
      return value.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (token, name: string) => Object.hasOwn(params, name) ? String(params[name]) : token);
    },
  };
}
export type I18n = ReturnType<typeof createI18n>;

/** Apply new render text to existing nodes. Input, focus, listeners and scroll stay intact. */
export function updateLocalizedMarkup(root: HTMLElement, html: string): void {
  const template = root.ownerDocument.createElement("template");
  template.innerHTML = html;
  const patch = (current: Node, next: Node): void => {
    if (current.nodeType !== next.nodeType) return;
    if (current.nodeType === 3) { if (current.nodeValue !== next.nodeValue) current.nodeValue = next.nodeValue; return; }
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
