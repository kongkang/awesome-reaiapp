import type { LocaleClient } from "@reai/app-sdk/v1";
import zh from "../assets/locales/zh.json";
import en from "../assets/locales/en.json";

type Params = Record<string, string | number>;
type Dictionary = { [key: string]: string | Dictionary };
const dictionaries: Record<string, Dictionary> = { zh, en };
function messageAt(dictionary: Dictionary | undefined, key: string): string | undefined {
  let value: string | Dictionary | undefined = dictionary;
  for (const part of key.split(".")) value = typeof value === "object" ? value[part] : undefined;
  return typeof value === "string" ? value : undefined;
}
const attributes = ["aria-label", "title"] as const;

/** Plain-text resource contract: parameters are never parsed as messages or HTML. */
export function createTerminalMessages(locale?: LocaleClient) {
  let language = locale?.getSnapshot().locale ?? "zh";
  const t = (key: string, params: Params = {}): string => {
    const message = messageAt(dictionaries[language], key) ?? messageAt(dictionaries.en, key) ?? key;
    return message.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (token, name: string) =>
      Object.hasOwn(params, name) ? String(params[name]) : token);
  };
  const update = (root: HTMLElement) => {
    const nodes = [root, ...root.querySelectorAll<HTMLElement>("[data-i18n], [data-i18n-aria-label], [data-i18n-title]")];
    for (const node of nodes) {
      const params = JSON.parse(node.getAttribute("data-i18n-params") ?? "{}") as Params;
      const key = node.getAttribute("data-i18n");
      if (key) node.textContent = t(key, params);
      for (const attribute of attributes) {
        const attributeKey = node.getAttribute(`data-i18n-${attribute}`);
        if (attributeKey) node.setAttribute(attribute, t(attributeKey, params));
      }
    }
  };
  return {
    t,
    update,
    text(node: HTMLElement, key: string, params: Params = {}, attribute?: typeof attributes[number]) {
      node.setAttribute(attribute ? `data-i18n-${attribute}` : "data-i18n", key);
      node.setAttribute("data-i18n-params", JSON.stringify(params));
      if (attribute) node.setAttribute(attribute, t(key, params));
      else node.textContent = t(key, params);
    },
    clear(node: HTMLElement) {
      node.removeAttribute("data-i18n");
      node.removeAttribute("data-i18n-params");
      node.textContent = "";
    },
    subscribe(listener: () => void): () => void {
      if (!locale) { listener(); return () => {}; }
      return locale.onChange(snapshot => { language = snapshot.locale; listener(); });
    },
  };
}
export type TerminalMessages = ReturnType<typeof createTerminalMessages>;
