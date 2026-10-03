import { appendSafeMarkup, element, formatDuration } from "./dom";
import { createAgentUiI18n, type AgentUiI18n } from "./i18n";
import type { AgentOrGroup, Card, StreamItem } from "./model";

function renderCard(card: Card, i18n: AgentUiI18n): HTMLElement {
  const outer = element("div", "agent-chat-card");
  if (card.type === "file") {
    const icon = element("span", "agent-chat-card-icon");
    icon.textContent = card.icon ?? "📄";
    const info = element("span", "agent-chat-card-info");
    const name = element("strong", "agent-chat-card-name");
    name.textContent = card.name ?? "";
    const meta = element("small", "agent-chat-card-meta");
    meta.textContent = card.meta ?? "";
    info.append(name, meta);
    outer.append(icon, info);
  } else if (card.type === "audio") {
    outer.classList.add("is-audio");
    const play = element("span", "agent-chat-card-play");
    play.textContent = "▶";
    const wave = element("span", "agent-chat-card-wave");
    [5, 12, 8, 16, 11, 7, 14, 9, 17, 6, 12, 8].forEach((height) => {
      const bar = element("i");
      bar.style.height = `${height}px`;
      wave.appendChild(bar);
    });
    const duration = element("small", "agent-chat-card-duration");
    duration.textContent = card.dur ?? "";
    outer.append(play, wave, duration);
  } else {
    const preview = element("div", "agent-chat-card-image");
    // 消费者给了 alt（含空串，与旧版 ?? 判空口径一致）就用数据；缺省占位文案才走语言实例。
    if (card.alt != null) preview.textContent = card.alt;
    else i18n.bindText(preview, () => i18n.t("agentUi.card.imageAlt"));
    outer.appendChild(preview);
  }
  return outer;
}

function renderItem(item: StreamItem, agent: AgentOrGroup, i18n: AgentUiI18n): HTMLElement | null {
  if (item.k === "day") {
    const day = element("div", "agent-stream-day");
    day.textContent = item.t;
    return day;
  }
  if (item.k === "anchor") {
    const anchor = element("article", "agent-task-anchor");
    const icon = element("span", "agent-task-anchor-icon");
    icon.textContent = item.icon;
    const body = element("span", "agent-task-anchor-body");
    const title = element("strong", "agent-task-anchor-title");
    title.textContent = item.title;
    const meta = element("small", "agent-task-anchor-meta");
    appendSafeMarkup(meta, item.meta);
    body.append(title, meta);
    const state = element("span", `agent-task-anchor-state${item.st === "run" ? " is-running" : ""}`);
    i18n.bindText(state, () => i18n.t(item.st === "run" ? "agentUi.anchor.running" : "agentUi.anchor.done"));
    anchor.append(icon, body, state);
    return anchor;
  }
  if (item.k === "work") {
    const done = !item.open;
    const work = element("article", `agent-work-card${done ? " is-done" : " is-open"}`);
    const header = element("div", "agent-work-header");
    // 完成态换 ✓：转圈的胶囊图标只属于进行中的卡片。
    const marker = element("span", done ? "agent-work-done-icon" : "agent-work-spinner");
    marker.textContent = done ? "✓" : "";
    const label = element("span", "agent-work-label");
    label.textContent = item.label;
    const time = element("small", "agent-work-time");
    // 耗时/已运行标签与时间格式都来自语言实例；since 数值是数据，切语言只重排文案。
    i18n.bindText(time, () =>
      i18n.t(done ? "agentUi.work.elapsed" : "agentUi.work.running", { duration: formatDuration(item.since, i18n) }));
    header.append(marker, label, time);
    const steps = element("div", "agent-work-steps");
    item.steps.forEach((step) => {
      const row = element("div", `agent-work-step${step.d ? " is-done" : ""}`);
      const marker = element("span", "agent-work-step-marker");
      marker.textContent = step.d ? "✓" : "●";
      row.append(marker, document.createTextNode(step.t));
      steps.appendChild(row);
    });
    header.addEventListener("click", () => work.classList.toggle("is-open"));
    work.append(header, steps);
    return work;
  }
  if (item.k === "ask") {
    if (!item.answered) return null;
    const answered = element("article", "agent-answered-prompt");
    const head = element("strong", "agent-answered-prompt-title");
    i18n.bindText(head, () => i18n.t("agentUi.ask.confirmed"));
    const question = element("p");
    question.textContent = item.text;
    const answer = element("span", "agent-answered-prompt-answer");
    i18n.bindText(answer, () => i18n.t("agentUi.ask.answer", { answer: item.answered ?? "" }));
    answered.append(head, question, answer);
    return answered;
  }
  const row = element("article", `agent-message${item.me ? " is-mine" : ""}`);
  const avatar = element("span", "agent-message-avatar");
  // 自己的头像字是界面文案（"我"/"Me"）；他人头像是数据，不翻译。
  if (item.me) i18n.bindText(avatar, () => i18n.t("agentUi.message.selfAvatar"));
  else avatar.textContent = item.ava ?? agent.ava ?? agent.name.slice(0, 1);
  const body = element("div", "agent-message-body");
  if (!item.me && agent.kind === "group" && item.who) {
    const author = element("span", "agent-message-author");
    author.textContent = item.who;
    body.appendChild(author);
  }
  const bubble = element("div", "agent-message-bubble");
  appendSafeMarkup(bubble, item.text);
  body.appendChild(bubble);
  if (item.card) body.appendChild(renderCard(item.card, i18n));
  item.cards?.forEach((card) => body.appendChild(renderCard(card, i18n)));
  const time = element("small", "agent-message-time");
  time.textContent = item.ts;
  body.appendChild(time);
  row.append(avatar, body);
  return row;
}

export interface ConversationStream {
  element: HTMLElement;
  render(items: StreamItem[], agent: AgentOrGroup): void;
  scrollToLatest(): void;
  /**
   * 原地更新**最后一条助手气泡**的文本（流式续文用）。
   *
   * 与 `render` 的区别：不全量重建对话流，只重绘那一条气泡的内容——
   * 打字机式呈现时每 45ms 来一块，全量重建会有闪烁与滚动抖动。
   * 流里没有助手气泡时退化成一个空操作（调用方照常全量 render）。
   */
  updateLastMessage(text: string): void;
  /**
   * 卸载：释放注入语言实例在本流上的全部文案绑定并移除节点。
   * 未注入实例的历史用法不调用也可（私有实例随节点一起被回收）。
   */
  dispose(): void;
}

export interface ConversationStreamOptions {
  agent: AgentOrGroup;
  items: StreamItem[];
  /**
   * 实例级语言入口：状态标签、耗时、已确认提示、图片占位等自有文案随它
   * 更新。缺省沿用历史内置中文（行为与旧调用完全一致）。
   */
  i18n?: AgentUiI18n;
}

export function mountConversationStream(container: HTMLElement, options: ConversationStreamOptions): ConversationStream {
  const i18n = options.i18n ?? createAgentUiI18n();
  const stream = element("div", "agent-conversation-stream");
  // 最后一条非我方的消息气泡（updateLastMessage 的操作目标）。
  let lastAssistantBubble: HTMLElement | null = null;
  const render = (items: StreamItem[], agent: AgentOrGroup) => {
    // 旧节点即将被整体替换，先摘掉它们在（可能被消费者长期持有的）语言实例里的绑定。
    i18n.releaseBindings(stream);
    stream.replaceChildren();
    lastAssistantBubble = null;
    items.forEach((item) => {
      const node = renderItem(item, agent, i18n);
      if (node) {
        stream.appendChild(node);
        if (item.k === "msg" && !item.me) {
          lastAssistantBubble = node;
        }
      }
    });
    stream.scrollTop = stream.scrollHeight;
  };
  const updateLastMessage = (text: string) => {
    if (!lastAssistantBubble) return;
    const body = lastAssistantBubble.querySelector(
      ".agent-message-body",
    ) as HTMLElement | null;
    const bubble = lastAssistantBubble.querySelector(
      ".agent-message-bubble",
    ) as HTMLElement | null;
    // 时间标签是 body 的最后一个子节点,重绘内容时保住它。
    const time = body?.lastElementChild;
    if (body && bubble) {
      bubble.replaceChildren();
      appendSafeMarkup(bubble, text);
      if (time) body.appendChild(time);
    }
    stream.scrollTop = stream.scrollHeight;
  };
  const scrollToLatest = () => { stream.scrollTop = stream.scrollHeight; };
  container.appendChild(stream);
  render(options.items, options.agent);
  return {
    element: stream,
    render,
    updateLastMessage,
    scrollToLatest,
    dispose: () => {
      i18n.releaseBindings(stream);
      stream.remove();
    },
  };
}
