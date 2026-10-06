import { t, bindAttribute, releaseLocaleBindings, type TextSource } from "./i18n";
import { chatIcon, element } from "./dom";

export type ChatMicState = "idle" | "listening" | "busy";

export interface ChatComposerMic {
  /** idle = 可起一场；listening = 正在听，点一下是收工；busy = 识别中 / 别处占用。 */
  state: ChatMicState;
  disabled?: boolean;
  onToggle(): void;
  /** 无障碍与悬停文案；缺省是通用说法，消费方按自己的语义覆盖。 */
  labels?: { idle: TextSource; listening: TextSource; busy?: TextSource };
}

export interface ChatComposerOptions {
  /** 稿文案 `Say something or type…` 由消费方传入，本包不替它写死产品文案。 */
  placeholder: TextSource;
  draft?: string;
  disabled?: boolean;
  /** 每次击键回调草稿；整页重渲染的消费方靠它在重建输入框时把草稿带回来。 */
  onDraftChange?(value: string): void;
  /**
   * Enter 发送（稿里没有发送钮）。只在去掉首尾空白后非空时触发；本包**不**替
   * 消费方清空输入——要不要清、失败要不要把草稿还回去，都是消费方的事
   * （`setDraft("")`）。
   */
  onSend(text: string): void;
  mic: ChatComposerMic;
  /**
   * `+` 附件钮。缺省时按稿画出来但 disabled 并带说明——形态对稿，又不是一扇
   * 点了没反应的假门。
   */
  onAttach?(): void;
  /** Consumers hide the entry when no attachment formats are supported. */
  hideAttach?: boolean;
  /** `+` 钮 disabled 时的说明（默认「暂不支持添加附件」）。 */
  attachDisabledTitle?: TextSource;
}

export interface ChatComposer {
  element: HTMLElement;
  input: HTMLInputElement;
  setDraft(value: string): void;
  /**
   * 把一段文字接到当前草稿末尾（定向听写的落点）：只改这个输入框，不碰别处。
   * 两侧都是 ASCII 字母数字时补一个空格，别把 `hello` 和 `world` 粘成一个词。
   */
  appendDraft(text: string): void;
  focus(): void;
  dispose(): void;
}

const DEFAULT_MIC_LABELS = { idle: () => t("chatUi.message1"), listening: () => t("chatUi.message2"), busy: () => t("chatUi.message3") };

function needsSpace(left: string, right: string): boolean {
  return /[A-Za-z0-9]$/.test(left) && /^[A-Za-z0-9]/.test(right);
}

/** 底部输入坞：稿 `.chat-input-bar` = `[+][输入框][麦克风]`。 */
export function mountChatComposer(
  container: HTMLElement,
  options: ChatComposerOptions,
): ChatComposer {
  const bar = element("div", "chat-input-bar");

  if (!options.hideAttach) {
    const attach = element("button", "chat-attach");
    attach.type = "button";
    bindAttribute(attach, "aria-label", () => t("chatUi.message4"));
    attach.append(chatIcon("plus", 16));
    if (options.onAttach) {
      // Options are mount-time values; callers remount when disabled state changes.
      attach.disabled = options.disabled === true;
      bindAttribute(attach, "title", () => t("chatUi.message4"));
      attach.addEventListener("click", () => options.onAttach?.());
    } else {
      attach.disabled = true;
      bindAttribute(attach, "title", options.attachDisabledTitle ?? (() => t("chatUi.message5")));
    }
    bar.append(attach);
  }

  const input = element("input", "chat-input");
  input.type = "text";
  input.autocomplete = "off";
  bindAttribute(input, "placeholder", options.placeholder);
  bindAttribute(input, "aria-label", options.placeholder);
  input.value = options.draft ?? "";
  input.disabled = options.disabled === true;
  const onInput = () => options.onDraftChange?.(input.value);
  const onKeydown = (event: KeyboardEvent) => {
    if (event.key !== "Enter" || event.isComposing) return;
    event.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    options.onSend(text);
  };
  input.addEventListener("input", onInput);
  input.addEventListener("keydown", onKeydown);

  const mic = element("button", "chat-mic");
  mic.type = "button";
  const labels = { ...DEFAULT_MIC_LABELS, ...options.mic.labels };
  const listening = options.mic.state === "listening";
  const micLabel = listening
    ? labels.listening
    : options.mic.state === "busy"
      ? labels.busy ?? DEFAULT_MIC_LABELS.busy
      : labels.idle;
  bindAttribute(mic, "title", micLabel);
  bindAttribute(mic, "aria-label", micLabel);
  mic.setAttribute("aria-pressed", String(listening));
  mic.classList.toggle("is-listening", listening);
  mic.disabled = options.mic.disabled === true;
  mic.append(chatIcon("mic", 14));
  const onMic = () => options.mic.onToggle();
  mic.addEventListener("click", onMic);

  bar.append(input, mic);
  container.append(bar);

  const setDraft = (value: string) => {
    input.value = value;
    options.onDraftChange?.(value);
  };

  return {
    element: bar,
    input,
    setDraft,
    appendDraft(text) {
      const current = input.value;
      const joined = current + (needsSpace(current, text) ? " " : "") + text;
      setDraft(joined);
      input.focus();
      const end = joined.length;
      try {
        input.setSelectionRange(end, end);
      } catch {
        /* 某些实现对 type=text 以外的输入框会抛，这里只是把光标挪到末尾。 */
      }
    },
    focus() {
      input.focus();
    },
    dispose() {
      releaseLocaleBindings(bar);
      input.removeEventListener("input", onInput);
      input.removeEventListener("keydown", onKeydown);
      mic.removeEventListener("click", onMic);
      bar.remove();
    },
  };
}
