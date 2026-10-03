import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  createAgentUiI18n,
  createSearchInput,
  createStatusPill,
  formatDuration,
  mountAgentComposer,
  mountConversationStream,
  mountPaneResizer,
  type AgentOrGroup,
  type AgentUiI18n,
  type StreamItem,
} from "../src";

// bun test 在同一进程里跑整个 workspace 的测试；其他包（如 cli 的 contract-test）
// 可能已全局注册过 happy-dom，重复 register 会抛错。只在缺失时注册，且不反注册。
beforeAll(() => {
  if (typeof globalThis.document === "undefined") GlobalRegistrator.register();
});
beforeEach(() => document.body.replaceChildren());

function demoAgent(): AgentOrGroup {
  return {
    id: "test-agent", kind: "agent", ava: "◆", name: "Agent", status: "busy",
    time: "", last: "", stream: [],
  };
}

function sampleItems(): StreamItem[] {
  return [
    { k: "day", t: "今天" },
    { k: "msg", me: 1, text: "你好", ts: "09:00" },
    { k: "msg", text: "在的", ts: "09:01" },
    { k: "anchor", icon: "🗺", title: "任务A", meta: "meta", st: "run", since: 195 },
    { k: "work", label: "工作卡", since: 134, open: "1", steps: [{ t: "步骤", d: 1 }] },
    { k: "work", label: "已完成卡", since: 75, steps: [] },
    { k: "ask", text: "要继续吗", brief: "确认", opts: ["继续"], answered: "继续" },
    { k: "msg", text: "看图", ts: "09:05", cards: [{ type: "image" }] },
  ];
}

function mountStream(items: StreamItem[], i18n?: AgentUiI18n) {
  const container = document.createElement("section");
  document.body.appendChild(container);
  return mountConversationStream(container, { agent: demoAgent(), items, i18n });
}

function mountComposer(options: Partial<Parameters<typeof mountAgentComposer>[1]> = {}) {
  const container = document.createElement("section");
  document.body.appendChild(container);
  return mountAgentComposer(container, {
    placeholder: "问点什么…",
    onSend: () => {},
    ...options,
  });
}

function setScrollMetrics(node: HTMLElement, values: { scrollHeight: number; clientHeight: number; scrollTop: number }): void {
  Object.defineProperties(node, {
    scrollHeight: { configurable: true, value: values.scrollHeight },
    clientHeight: { configurable: true, value: values.clientHeight },
    scrollTop: { configurable: true, writable: true, value: values.scrollTop },
  });
}

describe("旧调用兼容：不注入实例时逐字保留历史中文", () => {
  test("对话流自有文案维持原字符串", () => {
    const stream = mountStream(sampleItems());
    const root = stream.element;
    expect(root.querySelector(".agent-task-anchor-state")?.textContent).toBe("进行中");
    expect(root.querySelector(".agent-work-card.is-open .agent-work-time")?.textContent).toBe("已运行 2 分 14 秒");
    expect(root.querySelector(".agent-work-card.is-done .agent-work-time")?.textContent).toBe("耗时 1 分 15 秒");
    expect(root.querySelector(".agent-answered-prompt-title")?.textContent).toBe("✓ 已确认");
    expect(root.querySelector(".agent-answered-prompt-answer")?.textContent).toBe("你的回答：继续");
    expect(root.querySelector(".agent-chat-card-image")?.textContent).toBe("图片");
    expect(root.querySelector(".agent-message.is-mine .agent-message-avatar")?.textContent).toBe("我");
    stream.dispose();
  });

  test("输入坞按钮、aria 与占位维持原字符串", () => {
    const composer = mountComposer();
    const attach = composer.element.querySelector<HTMLButtonElement>(".agent-composer-button:not(.is-mic)");
    const mic = composer.element.querySelector<HTMLButtonElement>(".agent-composer-button.is-mic");
    expect(attach?.getAttribute("aria-label")).toBe("添加附件");
    expect(attach?.title).toBe("添加附件");
    expect(mic?.getAttribute("aria-label")).toBe("语音输入");
    expect(composer.input.placeholder).toBe("问点什么…");
    expect(composer.input.getAttribute("aria-label")).toBe("问点什么…");
    composer.dispose();
  });

  test("待确认坞折叠后 aria 使用历史文案", () => {
    const scroll = document.createElement("div");
    const composer = mountComposer({
      pendingPrompt: { k: "ask", text: "要继续吗", brief: "确认", opts: ["继续"] },
      scrollContainer: scroll,
    });
    const bar = composer.element.querySelector<HTMLButtonElement>(".agent-prompt-bar");
    expect(bar?.getAttribute("aria-label")).toBe("回到最新消息");
    setScrollMetrics(scroll, { scrollHeight: 1000, clientHeight: 100, scrollTop: 0 });
    scroll.dispatchEvent(new Event("scroll"));
    expect(bar?.getAttribute("aria-label")).toBe("展开待确认 Action 并回到最新");
    composer.dispose();
  });

  test("formatDuration 与状态药丸维持历史输出", () => {
    expect(formatDuration(42)).toBe("42 秒");
    expect(formatDuration(75)).toBe("1 分 15 秒");
    expect(formatDuration(180)).toBe("3 分");
    expect(createStatusPill("wait").textContent).toBe("等你确认");
    expect(createStatusPill("busy").textContent).toBe("工作中");
  });
});

describe("实例级双语：首屏与运行中切换", () => {
  test("英文实例首屏直接英文，不闪中文", () => {
    const i18n = createAgentUiI18n({ locale: "en" });
    const stream = mountStream(sampleItems(), i18n);
    expect(stream.element.querySelector(".agent-task-anchor-state")?.textContent).toBe("In progress");
    expect(stream.element.querySelector(".agent-work-card.is-open .agent-work-time")?.textContent).toBe("Running 2m 14s");
    expect(stream.element.querySelector(".agent-answered-prompt-answer")?.textContent).toBe("Your answer: 继续");
    expect(stream.element.querySelector(".agent-chat-card-image")?.textContent).toBe("Image");
    expect(stream.element.querySelector(".agent-message.is-mine .agent-message-avatar")?.textContent).toBe("Me");
    expect(formatDuration(75, i18n)).toBe("1m 15s");
    stream.dispose();
  });

  test("运行中切换语言更新的是同一批节点，滚动位置保持", () => {
    const i18n = createAgentUiI18n({ locale: "zh" });
    const stream = mountStream(sampleItems(), i18n);
    setScrollMetrics(stream.element, { scrollHeight: 1200, clientHeight: 300, scrollTop: 0 });
    stream.scrollToLatest();
    expect(stream.element.scrollTop).toBe(1200);
    const stateBefore = stream.element.querySelector(".agent-task-anchor-state");
    const timeBefore = stream.element.querySelector(".agent-work-card.is-open .agent-work-time");
    expect(stateBefore?.textContent).toBe("进行中");

    expect(i18n.setLocale("en")).toBe(true);
    const stateAfter = stream.element.querySelector(".agent-task-anchor-state");
    const timeAfter = stream.element.querySelector(".agent-work-card.is-open .agent-work-time");
    expect(stateAfter).toBe(stateBefore);
    expect(timeAfter).toBe(timeBefore);
    expect(stateAfter?.textContent).toBe("In progress");
    expect(timeAfter?.textContent).toBe("Running 2m 14s");
    // 滚动是用户状态，语言更新不得触碰。
    expect(stream.element.scrollTop).toBe(1200);
    stream.dispose();
  });

  test("输入坞按钮与待确认坞 aria 随语言更新，且状态机继续工作", () => {
    const i18n = createAgentUiI18n({ locale: "zh" });
    const scroll = document.createElement("div");
    const composer = mountComposer({
      i18n,
      pendingPrompt: { k: "ask", text: "要继续吗", brief: "确认", opts: ["继续"] },
      scrollContainer: scroll,
    });
    const bar = composer.element.querySelector<HTMLButtonElement>(".agent-prompt-bar");
    expect(bar?.getAttribute("aria-label")).toBe("回到最新消息");
    // 折叠后切语言：aria 按当前折叠状态用新语言重算。
    setScrollMetrics(scroll, { scrollHeight: 1000, clientHeight: 100, scrollTop: 0 });
    scroll.dispatchEvent(new Event("scroll"));
    i18n.setLocale("en");
    expect(bar?.getAttribute("aria-label")).toBe("Expand pending action and go to latest");
    expect(composer.element.querySelector(".agent-prompt-kind")?.textContent).toBe("Action");
    const attach = composer.element.querySelector<HTMLButtonElement>(".agent-composer-button:not(.is-mic)");
    expect(attach?.getAttribute("aria-label")).toBe("Add attachment");
    expect(composer.element.querySelector<HTMLButtonElement>(".is-mic")?.title).toBe("Voice input");
    // 展开后回到 backToLatest 文案（状态变化路径也走同一求值）。
    composer.expandPrompt();
    expect(bar?.getAttribute("aria-label")).toBe("Back to latest message");
    composer.dispose();
  });

  test("placeholder 传函数时随语言重求值", () => {
    const i18n = createAgentUiI18n({ locale: "zh" });
    const composer = mountComposer({ i18n, placeholder: () => (i18n.locale === "zh" ? "问点什么…" : "Ask anything…") });
    expect(composer.input.placeholder).toBe("问点什么…");
    i18n.setLocale("en");
    expect(composer.input.placeholder).toBe("Ask anything…");
    expect(composer.input.getAttribute("aria-label")).toBe("Ask anything…");
    composer.dispose();
  });

  test("状态药丸、搜索框与拖宽手柄随实例更新", () => {
    const i18n = createAgentUiI18n({ locale: "zh" });
    const pillHost = document.createElement("span");
    document.body.appendChild(pillHost);
    const pill = createStatusPill("wait", { i18n });
    pillHost.appendChild(pill);
    const search = createSearchInput({ placeholder: () => (i18n.locale === "zh" ? "搜索任务…" : "Search tasks…"), i18n, onInput: () => {} });
    document.body.appendChild(search.element);
    const pane = document.createElement("aside");
    const app = document.createElement("section");
    document.body.append(pane, app);
    const resizer = mountPaneResizer(pane, app, { storageKey: "test.pane", def: 264, min: 260, ariaLabel: "任务列表栏宽", i18n });
    const handle = pane.querySelector(".rs-handle");
    expect(pill.textContent).toBe("等你确认");
    expect(handle?.getAttribute("title")).toBe("拖动调整宽度 · 双击复位");

    i18n.setLocale("en");
    expect(pill.textContent).toBe("Needs confirmation");
    expect(search.input.placeholder).toBe("Search tasks…");
    expect(handle?.getAttribute("title")).toBe("Drag to resize · double-click to reset");
    // 手柄的消费者 aria-label 不被语言实例改写。
    expect(handle?.getAttribute("aria-label")).toBe("任务列表栏宽");
    search.dispose();
    resizer.dispose();
  });
});

describe("实例隔离、状态保留与回调边界", () => {
  test("两个实例不同 locale 互不污染", () => {
    const i18nA = createAgentUiI18n({ locale: "zh" });
    const i18nB = createAgentUiI18n({ locale: "en" });
    const streamA = mountStream(sampleItems(), i18nA);
    const streamB = mountStream(sampleItems(), i18nB);
    expect(streamA.element.querySelector(".agent-task-anchor-state")?.textContent).toBe("进行中");
    expect(streamB.element.querySelector(".agent-task-anchor-state")?.textContent).toBe("In progress");

    i18nA.setLocale("en");
    expect(streamA.element.querySelector(".agent-task-anchor-state")?.textContent).toBe("In progress");
    expect(streamB.element.querySelector(".agent-task-anchor-state")?.textContent).toBe("In progress");
    i18nB.setLocale("zh");
    expect(streamB.element.querySelector(".agent-task-anchor-state")?.textContent).toBe("进行中");
    expect(streamA.element.querySelector(".agent-task-anchor-state")?.textContent).toBe("In progress");
    streamA.dispose();
    streamB.dispose();
  });

  test("切语言保留输入值、选区、焦点、滚动、折叠与已回答内容", () => {
    const i18n = createAgentUiI18n({ locale: "zh" });
    const stream = mountStream(sampleItems(), i18n);
    setScrollMetrics(stream.element, { scrollHeight: 1200, clientHeight: 300, scrollTop: 900 });
    const composer = mountComposer({ i18n, scrollContainer: stream.element });
    composer.input.value = "未发送的草稿 draft";
    composer.input.focus();
    composer.input.setSelectionRange(2, 7);
    const workCard = stream.element.querySelector<HTMLElement>(".agent-work-card.is-open");
    workCard?.querySelector(".agent-work-header")?.dispatchEvent(new Event("click", { bubbles: true }));
    expect(workCard?.classList.contains("is-open")).toBe(false);

    i18n.setLocale("en");
    expect(document.activeElement === composer.input).toBe(true);
    expect(composer.input.value).toBe("未发送的草稿 draft");
    expect(composer.input.selectionStart).toBe(2);
    expect(composer.input.selectionEnd).toBe(7);
    expect(stream.element.scrollTop).toBe(900);
    expect(workCard?.classList.contains("is-open")).toBe(false);
    // 已回答的答案内容是数据，只有前缀文案换语言。
    expect(stream.element.querySelector(".agent-answered-prompt-answer")?.textContent).toBe("Your answer: 继续");
    stream.dispose();
    composer.dispose();
  });

  test("语言更新不触发任何业务回调", () => {
    const i18n = createAgentUiI18n({ locale: "zh" });
    let sends = 0;
    let answers = 0;
    let inputs = 0;
    const stream = mountStream(sampleItems(), i18n);
    const composer = mountComposer({
      i18n,
      pendingPrompt: { k: "ask", text: "要继续吗", brief: "确认", opts: ["继续"] },
      scrollContainer: stream.element,
      onSend: () => { sends += 1; },
      onPromptAnswer: () => { answers += 1; },
    });
    const search = createSearchInput({ placeholder: "搜索", i18n, onInput: () => { inputs += 1; } });
    i18n.setLocale("en");
    i18n.setLocale("zh");
    i18n.setLocale("en");
    expect(sends).toBe(0);
    expect(answers).toBe(0);
    expect(inputs).toBe(0);
    search.dispose();
    composer.dispose();
    stream.dispose();
  });

  test("销毁后不再更新：dispose 释放绑定", () => {
    const i18n = createAgentUiI18n({ locale: "zh" });
    const stream = mountStream(sampleItems(), i18n);
    const composer = mountComposer({ i18n });
    const stateNode = stream.element.querySelector(".agent-task-anchor-state");
    const attach = composer.element.querySelector<HTMLButtonElement>(".agent-composer-button");
    stream.dispose();
    composer.dispose();
    i18n.setLocale("en");
    expect(stateNode?.textContent).toBe("进行中");
    expect(attach?.getAttribute("aria-label")).toBe("添加附件");
  });

  test("反复切换无重复通知，同语言是 no-op", () => {
    const i18n = createAgentUiI18n({ locale: "zh" });
    const seen: string[] = [];
    i18n.onChange((locale) => seen.push(locale));
    const stream = mountStream(sampleItems(), i18n);
    expect(i18n.setLocale("en")).toBe(true);
    expect(i18n.setLocale("en")).toBe(false);
    expect(i18n.setLocale("zh")).toBe(true);
    expect(i18n.setLocale("en")).toBe(true);
    expect(seen).toEqual(["en", "zh", "en"]);
    expect(stream.element.querySelector(".agent-task-anchor-state")?.textContent).toBe("In progress");
    stream.dispose();
  });
});

describe("资源回退与插值", () => {
  test("消费者资源优先，缺键回退内置，未知语言回退英文", () => {
    const i18n = createAgentUiI18n({
      locale: "zh",
      messages: { zh: { agentUi: { status: { busy: "忙碌中" } } } },
    });
    expect(i18n.t("agentUi.status.busy")).toBe("忙碌中");
    // 消费者 zh 缺键 → 消费者 en（无）→ 内置 zh。
    expect(i18n.t("agentUi.status.idle")).toBe("空闲");
    expect(i18n.setLocale("fr")).toBe(true);
    expect(i18n.t("agentUi.status.busy")).toBe("Working");
    expect(i18n.t("agentUi.duration.seconds", { seconds: 8 })).toBe("8s");
    // 彻底缺键：返回键本身便于定位。
    expect(i18n.t("agentUi.no.such.key")).toBe("agentUi.no.such.key");
  });

  test("插值参数按普通文本显示，不留插值残影", () => {
    const i18n = createAgentUiI18n({ locale: "zh" });
    expect(i18n.t("agentUi.ask.answer", { answer: "<b>不是 HTML</b>" })).toBe("你的回答：<b>不是 HTML</b>");
    expect(i18n.t("agentUi.ask.answer")).toBe("你的回答：{answer}");
  });
});

describe("重建、实例 dispose 与高级绑定", () => {
  test("切换语言后再次 render：旧节点脱离实例，新节点用当前语言", () => {
    const i18n = createAgentUiI18n({ locale: "zh" });
    const stream = mountStream(sampleItems(), i18n);
    const oldState = stream.element.querySelector(".agent-task-anchor-state");
    i18n.setLocale("en");
    expect(oldState?.textContent).toBe("In progress");
    stream.render(sampleItems(), demoAgent());
    const newState = stream.element.querySelector(".agent-task-anchor-state");
    expect(newState).not.toBe(oldState);
    expect(newState?.textContent).toBe("In progress");
    // render 释放了旧树的绑定：再切换只有新树更新，脱离的旧节点不被触碰。
    i18n.setLocale("zh");
    expect(newState?.textContent).toBe("进行中");
    expect(oldState?.textContent).toBe("In progress");
    stream.dispose();
  });

  test("实例级 dispose 后 setLocale 不再触发任何更新或通知", () => {
    const i18n = createAgentUiI18n({ locale: "zh" });
    let notified = 0;
    i18n.onChange(() => { notified += 1; });
    const pill = createStatusPill("busy", { i18n });
    i18n.dispose();
    expect(i18n.setLocale("en")).toBe(true);
    expect(pill.textContent).toBe("工作中");
    expect(notified).toBe(0);
  });

  test("bindText / bindAttribute：元素独占文本子节点，releaseBindings 精确释放", () => {
    const i18n = createAgentUiI18n({ locale: "zh" });
    const chip = document.createElement("span");
    i18n.bindText(chip, () => (i18n.locale === "zh" ? "展开" : "Expand"));
    const textNode = chip.firstChild;
    expect(textNode?.nodeType).toBe(Node.TEXT_NODE);
    expect(chip.textContent).toBe("展开");
    const btn = document.createElement("button");
    i18n.bindAttribute(btn, "title", () => (i18n.locale === "zh" ? "关闭" : "Close"));
    i18n.setLocale("en");
    // 同一文本节点被复用，元素与后续挂载的内容不被重建。
    expect(chip.firstChild).toBe(textNode);
    expect(chip.textContent).toBe("Expand");
    expect(btn.getAttribute("title")).toBe("Close");
    i18n.releaseBindings(chip);
    i18n.setLocale("zh");
    expect(chip.textContent).toBe("Expand");
    expect(btn.getAttribute("title")).toBe("关闭");
  });

  test("图片卡片 alt 空串与旧版口径一致：显示空而非占位文案", () => {
    const stream = mountStream([{ k: "msg", text: "x", ts: "09:00", cards: [{ type: "image", alt: "" }] }]);
    expect(stream.element.querySelector(".agent-chat-card-image")?.textContent).toBe("");
    stream.dispose();
  });
});
