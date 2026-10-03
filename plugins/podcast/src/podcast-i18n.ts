/**
 * Podcast 语言适配：唯一资源源是 assets/locales/{zh,en}.json，不另存翻译副本、
 * 不持久化插件自己的语言偏好。跟随 Host locale（app.ts 在 activate 里先读快照再订阅）。
 */
import zh from "../assets/locales/zh.json";
import en from "../assets/locales/en.json";

export type TextSource = string | (() => string);
let locale: "zh" | "en" = "zh";
const bindings = new Set<{ node: WeakRef<Node>; attribute?: string; update: (node: Node) => void }>();
const listeners = new Set<() => void>();

export function podcastLocale(): "zh" | "en" {
  return locale;
}

function lookup(table: unknown, key: string): string | undefined {
  let value = table;
  for (const part of key.split(".")) {
    if (!value || typeof value !== "object" || !Object.hasOwn(value, part)) return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return typeof value === "string" ? value : undefined;
}

/** 纯文本 + {name} 插值；参数按普通文本输出，不再作为消息或 HTML 解析。 */
export function t(key: string, params: Record<string, string | number | undefined> = {}): string {
  const message = lookup(locale === "zh" ? zh : en, key) ?? lookup(en, key);
  if (message === undefined) {
    console.warn(`[podcast:i18n] Missing message: ${key}`);
    return key;
  }
  return message.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (match, name: string) =>
    Object.hasOwn(params, name) ? String(params[name]) : match);
}

/** 未知语言回退英文；语言未实际变化时不触发任何更新（重复通知幂等）。 */
export function setPodcastLocale(value: string): void {
  const next = value === "zh" ? "zh" : "en";
  if (next === locale) return;
  locale = next;
  for (const binding of bindings) {
    const node = binding.node.deref();
    if (!node) {
      bindings.delete(binding);
      continue;
    }
    try {
      binding.update(node);
    } catch (cause) {
      console.warn("[podcast:i18n] Text binding failed", cause);
    }
  }
  for (const listener of listeners) {
    try {
      listener();
    } catch (cause) {
      console.warn("[podcast:i18n] Locale listener failed", cause);
    }
  }
}

export function onPodcastLocaleChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function bindText(node: Node, source: TextSource): void {
  // 持有自己的 Text 节点，语言切换时绝不替换元素子树；调用方可在同节点继续追加图标等。
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

/** 视图正常业务渲染替换节点时或销毁时释放绑定，避免泄漏。 */
export function releaseLocaleBindings(root: Node): void {
  for (const binding of bindings) {
    const node = binding.node.deref();
    if (!node || node === root || root.contains(node)) bindings.delete(binding);
  }
}

function readText(source: TextSource): string {
  return typeof source === "function" ? source() : source;
}
