import { createAgentUiI18n, type AgentUiI18n } from "./i18n";

export function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = ""): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}

export function button(className: string, label: string, title = ""): HTMLButtonElement {
  const node = element("button", className);
  node.type = "button";
  node.setAttribute("aria-label", title || label);
  node.title = title || label;
  node.textContent = label;
  return node;
}

const ALLOWED_TAGS = new Set(["BR", "B", "I", "SPAN"]);

export function appendSafeMarkup(target: HTMLElement, markup: string): void {
  const template = document.createElement("template");
  template.innerHTML = markup;
  const append = (source: Node, destination: Node) => {
    source.childNodes.forEach((child) => {
      if (child.nodeType === Node.TEXT_NODE) {
        destination.appendChild(document.createTextNode(child.textContent ?? ""));
        return;
      }
      if (!(child instanceof HTMLElement) || !ALLOWED_TAGS.has(child.tagName)) {
        destination.appendChild(document.createTextNode(child.textContent ?? ""));
        return;
      }
      const copy = document.createElement(child.tagName.toLowerCase());
      if (child.tagName === "SPAN" && ["dif", "mention"].includes(child.className)) copy.className = child.className;
      append(child, copy);
      destination.appendChild(copy);
    });
  };
  append(template.content, target);
}

/** formatDuration 的历史默认口径：未注入语言实例时按内置中文输出。模块私有、不可变。 */
const fallbackDurationI18n = createAgentUiI18n();

export function formatDuration(seconds: number, i18n: AgentUiI18n = fallbackDurationI18n): string {
  if (seconds < 60) return i18n.t("agentUi.duration.seconds", { seconds });
  const minutes = Math.floor(seconds / 60);
  const remain = seconds % 60;
  return remain
    ? i18n.t("agentUi.duration.minutesSeconds", { minutes, seconds: remain })
    : i18n.t("agentUi.duration.minutes", { minutes });
}
