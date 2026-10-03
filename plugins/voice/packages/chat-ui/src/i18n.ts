/** Voice injects its single packaged resource source; this component package owns no dictionary. */
export type TextSource = string | (() => TextSource);
export interface ChatI18n {
  t(key: string, params?: Record<string, string | number>): string;
  bindText(node: Node, source: TextSource): void;
  bindAttribute(node: Element, name: string, source: TextSource): void;
  releaseLocaleBindings(root: Node): void;
}
let adapter: ChatI18n | undefined;
export function configureChatI18n(value: ChatI18n): void { adapter = value; }
function current(): ChatI18n {
  if (!adapter) throw new Error("Configure chat UI localization before mounting components");
  return adapter;
}
export const t: ChatI18n["t"] = (key, params) => current().t(key, params);
export const bindText: ChatI18n["bindText"] = (node, source) => current().bindText(node, source);
export const bindAttribute: ChatI18n["bindAttribute"] = (node, name, source) => current().bindAttribute(node, name, source);
export const releaseLocaleBindings: ChatI18n["releaseLocaleBindings"] = (root) => current().releaseLocaleBindings(root);
