import { button, element } from "./dom";
import { createAgentUiI18n, readAgentUiText, type AgentUiI18n, type AgentUiTextSource } from "./i18n";
import { icon } from "./icons";
import type { StreamAsk } from "./model";

export interface AgentComposer {
  element: HTMLElement;
  input: HTMLInputElement;
  expandPrompt(): boolean;
  dispose(): void;
}

export interface AgentComposerOptions {
  /**
   * 输入框占位文案。传函数时它是纯文本 getter：语言变化会重新求值并原地
   * 更新 placeholder / aria-label，不影响输入值、光标与焦点。
   */
  placeholder: AgentUiTextSource;
  pendingPrompt?: StreamAsk;
  scrollContainer?: HTMLElement;
  /**
   * 实例级语言入口：按钮 title / aria、待确认坞提示随它更新。
   * 缺省沿用历史内置中文（行为与旧调用完全一致）。
   */
  i18n?: AgentUiI18n;
  onSend(text: string): void;
  onPromptAnswer?(answer: string): void;
}

const PROMPT_EXPAND_GAP = 80;
const PROMPT_COLLAPSE_GAP = 220;
let promptBodySequence = 0;

export function mountAgentComposer(container: HTMLElement, options: AgentComposerOptions): AgentComposer {
  const i18n = options.i18n ?? createAgentUiI18n();
  const dock = element("div", "agent-composer-dock");
  let prompt: HTMLElement | undefined;
  let promptBar: HTMLButtonElement | undefined;
  let promptBody: HTMLElement | undefined;
  let promptCompact = false;
  let promptHovered = false;
  let scrollTimer: ReturnType<typeof setTimeout> | undefined;

  // 折叠/悬停状态变化与语言变化都会重算这条 aria；闭包读的是活状态，
  // 两条路径共用同一个求值函数，不会互相覆盖。
  const promptBarLabel = (): string =>
    i18n.t((!promptCompact || promptHovered) ? "agentUi.composer.backToLatest" : "agentUi.composer.expandPrompt");

  const syncPromptPresentation = (): void => {
    if (!prompt || !promptBar || !promptBody) return;
    const expanded = !promptCompact || promptHovered;
    prompt.classList.toggle("is-compact", promptCompact);
    prompt.classList.toggle("is-hover-expanded", promptHovered);
    promptBar.setAttribute("aria-expanded", String(expanded));
    promptBar.setAttribute("aria-label", promptBarLabel());
    promptBody.setAttribute("aria-hidden", String(!expanded));
    promptBody.inert = !expanded;
  };

  const setPromptCompact = (compact: boolean): void => {
    if (!prompt || !promptBar) return;
    promptCompact = compact;
    syncPromptPresentation();
  };

  const promptGap = (): number => {
    const stream = options.scrollContainer;
    return stream ? Math.max(0, stream.scrollHeight - stream.scrollTop - stream.clientHeight) : 0;
  };

  const syncPromptToScroll = (): void => {
    if (!prompt) return;
    setPromptCompact(promptCompact ? promptGap() > PROMPT_EXPAND_GAP : promptGap() > PROMPT_COLLAPSE_GAP);
  };

  const expandPrompt = (): boolean => {
    if (!prompt) return false;
    setPromptCompact(false);
    if (scrollTimer) clearTimeout(scrollTimer);
    if (options.scrollContainer) {
      scrollTimer = setTimeout(() => {
        options.scrollContainer?.scrollTo({ top: options.scrollContainer.scrollHeight, behavior: "smooth" });
      }, 250);
    }
    return true;
  };

  if (options.pendingPrompt) {
    prompt = element("section", "agent-prompt-dock");
    promptBar = button("agent-prompt-bar", "", i18n.t("agentUi.composer.backToLatest"));
    promptBar.setAttribute("aria-expanded", "true");
    const brief = element("strong", "agent-prompt-brief");
    brief.textContent = options.pendingPrompt.brief;
    const kind = element("span", "agent-prompt-kind");
    i18n.bindText(kind, () => i18n.t("agentUi.composer.promptKind"));
    promptBar.append(brief, kind);
    promptBody = element("div", "agent-prompt-body");
    promptBody.id = `agent-prompt-body-${++promptBodySequence}`;
    promptBody.setAttribute("role", "region");
    promptBar.setAttribute("aria-controls", promptBody.id);
    const question = element("p", "agent-prompt-question");
    question.textContent = options.pendingPrompt.text;
    const actions = element("div", "agent-prompt-actions");
    options.pendingPrompt.opts.forEach((answer, index) => {
      const action = button(`agent-prompt-action${index === 0 ? " is-primary" : ""}`, answer);
      action.addEventListener("click", () => options.onPromptAnswer?.(answer), { once: true });
      actions.appendChild(action);
    });
    promptBody.append(question, actions);
    prompt.append(promptBar, promptBody);
    dock.appendChild(prompt);
    promptBar.addEventListener("click", expandPrompt);
    prompt.addEventListener("pointerenter", onPromptEnter);
    prompt.addEventListener("pointerleave", onPromptLeave);
    options.scrollContainer?.addEventListener("scroll", syncPromptToScroll, { passive: true });
    syncPromptPresentation();
    // 语言切换时按当前折叠/悬停状态重算 aria 与 title（syncPromptPresentation 也会走同一求值）。
    i18n.bindAttribute(promptBar, "aria-label", promptBarLabel);
    i18n.bindAttribute(promptBar, "title", () => i18n.t("agentUi.composer.backToLatest"));
  }

  function onPromptEnter(): void {
    promptHovered = true;
    syncPromptPresentation();
  }

  function onPromptLeave(): void {
    promptHovered = false;
    syncPromptPresentation();
  }
  const composer = element("div", "agent-composer");
  const attach = button("agent-composer-button", "", i18n.t("agentUi.composer.attach"));
  attach.appendChild(icon("plus", 17));
  i18n.bindAttribute(attach, "title", () => i18n.t("agentUi.composer.attach"));
  i18n.bindAttribute(attach, "aria-label", () => i18n.t("agentUi.composer.attach"));
  const input = element("input", "agent-composer-input");
  input.name = "agent-message";
  input.placeholder = readAgentUiText(options.placeholder);
  input.setAttribute("aria-label", input.placeholder);
  i18n.bindAttribute(input, "placeholder", options.placeholder);
  i18n.bindAttribute(input, "aria-label", options.placeholder);
  const mic = button("agent-composer-button is-mic", "", i18n.t("agentUi.composer.voice"));
  mic.appendChild(icon("mic", 16));
  i18n.bindAttribute(mic, "title", () => i18n.t("agentUi.composer.voice"));
  i18n.bindAttribute(mic, "aria-label", () => i18n.t("agentUi.composer.voice"));
  const send = () => {
    const value = input.value.trim();
    if (!value) return;
    input.value = "";
    options.onSend(value);
  };
  const keydown = (event: KeyboardEvent) => {
    if (event.key === "Enter" && !event.isComposing) {
      event.preventDefault();
      send();
    }
  };
  input.addEventListener("keydown", keydown);
  composer.append(attach, input, mic);
  dock.appendChild(composer);
  container.appendChild(dock);
  return {
    element: dock,
    input,
    expandPrompt,
    dispose: () => {
      if (scrollTimer) clearTimeout(scrollTimer);
      input.removeEventListener("keydown", keydown);
      promptBar?.removeEventListener("click", expandPrompt);
      prompt?.removeEventListener("pointerenter", onPromptEnter);
      prompt?.removeEventListener("pointerleave", onPromptLeave);
      options.scrollContainer?.removeEventListener("scroll", syncPromptToScroll);
      i18n.releaseBindings(dock);
      dock.remove();
    },
  };
}
