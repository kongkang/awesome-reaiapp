import { element } from "./dom";
import { createAgentUiI18n, readAgentUiText, type AgentUiI18n, type AgentUiTextSource } from "./i18n";
import { icon } from "./icons";

export interface AgentSearchInput {
  element: HTMLLabelElement;
  input: HTMLInputElement;
  dispose(): void;
}

export interface AgentSearchInputOptions {
  /** 占位文案；传函数时语言变化会原地重求值（纯文本 getter，勿做业务操作）。 */
  placeholder: AgentUiTextSource;
  /** 实例级语言入口；缺省沿用历史内置中文。 */
  i18n?: AgentUiI18n;
  onInput(value: string): void;
}

export function createSearchInput(options: AgentSearchInputOptions): AgentSearchInput {
  const i18n = options.i18n ?? createAgentUiI18n();
  const wrapper = element("label", "agent-search");
  const input = element("input", "agent-search-input");
  input.type = "search";
  input.name = "agent-search";
  input.placeholder = readAgentUiText(options.placeholder);
  input.autocomplete = "off";
  i18n.bindAttribute(input, "placeholder", options.placeholder);
  const listener = () => options.onInput(input.value);
  input.addEventListener("input", listener);
  wrapper.append(icon("search", 14), input);
  return { element: wrapper, input, dispose: () => {
    input.removeEventListener("input", listener);
    i18n.releaseBindings(wrapper);
  } };
}
