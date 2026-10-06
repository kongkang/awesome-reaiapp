import { configureChatI18n } from "../src/i18n";
import { t, bindText, bindAttribute, releaseLocaleBindings, setVoiceLocale } from "../../../src/voice-i18n";
configureChatI18n({ t, bindText, bindAttribute, releaseLocaleBindings });
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CHAT_WAVEFORM_BARS,
  formatChatTime,
  formatClipDuration,
  mountChatComposer,
  renderChatAttachment,
  renderChatMessage,
  stableWaveform,
  type ChatToolCallEntry,
} from "../src/index";

let ownsDomRegistration = false;
beforeAll(() => {
  if (typeof document === "undefined") {
    GlobalRegistrator.register();
    ownsDomRegistration = true;
  }
});
afterAll(() => {
  if (ownsDomRegistration) GlobalRegistrator.unregister();
});
beforeEach(() => document.body.replaceChildren());

const AT = "2026-08-22T06:47:00.000Z";

describe("消息气泡（稿 renderMsg）", () => {
  test("只有 AI 正文解析 Markdown，用户原文及状态标签不解析", () => {
    const text = "# 标题\n**天气** <img src=x>";
    const user = renderChatMessage({ from: "user", text, at: AT });
    expect(user.querySelector(".chat-bubble")?.textContent).toBe(text);
    expect(user.querySelector("h1, strong, img")).toBeNull();
    const ai = renderChatMessage({ from: "ai", text, at: AT });
    expect(ai.querySelector("h1")?.textContent).toBe("标题");
    expect(ai.querySelector("strong")?.textContent).toBe("天气");
    const status = renderChatMessage({ from: "ai", text: "", at: AT,
      card: { kind: "tool", tool: "web_search", status: "completed", label: "**搜索完成**" } });
    expect(status.querySelector(".chat-status-label")?.textContent).toBe("**搜索完成**");
    expect(status.querySelector("strong")).toBeNull();
    expect(status.querySelector(".chat-status-icon svg")).not.toBeNull();
  });
  test("调试芯片只在开发者模式且仅对 AI 消息渲染", () => {
    const hidden = renderChatMessage({ from: "ai", text: "answer", at: AT, runtime: "codex", totalTokens: 42 });
    expect(hidden.querySelector(".chat-devmeta")).toBeNull();
    const visible = renderChatMessage(
      { from: "ai", text: "answer", at: AT, runtime: "codex", channel: "external-brain", usage: { complete: true, inputTokens: 30, outputTokens: 12, totalTokens: 42 } },
      { developerMode: true },
    );
    expect(visible.querySelector(".chat-dev-chip")?.textContent).toBe("codex");
    expect(visible.querySelector(".chat-dev-chip.tok")?.textContent).toBe("42 tok");
    expect(visible.querySelector(".chat-devmeta")?.textContent).toContain("external-brain");
    const card = renderChatMessage({
      from: "ai",
      text: "",
      at: AT,
      runtime: "dsh",
      totalTokens: 456,
      card: { kind: "tool", tool: "web_search", status: "completed", label: "搜索完成" },
    }, { developerMode: true });
    expect(card.querySelector(".chat-dev-chip")?.textContent).toBe("dsh");
    expect(card.querySelector(".chat-dev-chip.tok")).toBeNull();
    const user = renderChatMessage(
      { from: "user", text: "question", at: AT, runtime: "pi", totalTokens: 9 },
      { developerMode: true },
    );
    expect(user.querySelector(".chat-devmeta")).toBeNull();
  });
  test("旧计数、不完整、非法或矛盾的用量不显示总数", () => {
    for (const usage of [undefined, { complete: false, inputTokens: 3, outputTokens: 4, totalTokens: 7 },
      { complete: true, totalTokens: 7 }, { complete: true, inputTokens: -1, outputTokens: 8, totalTokens: 7 },
      { complete: true, inputTokens: 3, outputTokens: 4, totalTokens: 8 }]) {
      const row = renderChatMessage({ from: "ai", text: "reply", at: AT, runtime: "pi", totalTokens: 7, usage }, { developerMode: true });
      expect(row.querySelector(".chat-dev-chip.tok")).toBeNull();
      expect(row.querySelector(".chat-dev-chip")?.textContent).toBe("pi");
    }
  });
  test("用户在右、AI 在左，气泡 + 时间戳；时间戳是稿的 2:47 PM 短格式", () => {
    const user = renderChatMessage({ from: "user", text: "帮我翻译", at: AT });
    const ai = renderChatMessage({ from: "ai", text: "好的\n\n第二段", at: new Date(AT) });
    expect(user.className).toBe("chat-msg from-user");
    expect(ai.className).toBe("chat-msg from-ai");
    expect(user.querySelector(".chat-bubble")?.textContent).toBe("帮我翻译");
    // AI 多段正文生成独立段落；用户原文仍由 textContent 保留。
    expect(Array.from(ai.querySelectorAll(".chat-bubble p"), p => p.textContent)).toEqual(["好的", "第二段"]);
    const ts = user.querySelector(".chat-ts")?.textContent ?? "";
    expect(ts).toMatch(/^\d{1,2}:\d{2} (AM|PM)$/);
    expect(ts).not.toContain(":00 ");
    expect(formatChatTime(new Date(2026, 7, 22, 14, 47))).toBe("2:47 PM");
    expect(formatChatTime("not a date")).toBe("");
  });

  test("没有正文的消息不画空气泡，只画附件与时间", () => {
    const row = renderChatMessage({
      from: "ai",
      text: "",
      at: AT,
      attachments: [{ kind: "file", name: "Q3_update_email.txt", meta: "Plain text · 0.3 KB" }],
    });
    expect(row.querySelector(".chat-bubble")).toBeNull();
    expect(row.querySelector(".chat-card")).not.toBeNull();
    expect(row.lastElementChild?.className).toBe("chat-ts");
  });

  test("联网工具状态与缺能力卡是结构化消息，安装按钮只调用显式动作", () => {
    const running = renderChatMessage({
      from: "ai",
      text: "",
      at: AT,
      card: {
        kind: "tool",
        tool: "web_search",
        status: "running",
        label: "正在使用浏览器插件进行联网搜索",
      },
    });
    expect(running.querySelector(".chat-status-card")?.getAttribute("data-status")).toBe("running");
    expect(running.textContent).toContain("正在使用浏览器插件进行联网搜索");

    let actions = 0;
    const required = renderChatMessage({
      from: "ai",
      text: "",
      at: AT,
      card: {
        kind: "capability-required",
        capability: "browser-web-access",
        title: "当前需要联网搜索功能才能完成这个请求",
        detail: "安装后可以继续",
        actionId: "install-browser-web-access",
        actionLabel: "一键安装并继续",
      },
    }, { onCardAction: () => { actions += 1; } });
    required.querySelector<HTMLButtonElement>(".chat-status-action")?.click();
    expect(actions).toBe(1);
  });
});

describe("附件卡（稿 cardHTML）", () => {
  test("文件卡：图标 + 文件名 + 说明，图标缺省 📄", () => {
    const card = renderChatAttachment({ kind: "file", icon: "📊", name: "Competitive_Analysis.xlsx", meta: "Spreadsheet · 24 KB" });
    expect(card.className).toBe("chat-card");
    expect(card.dataset.kind).toBe("file");
    expect(card.querySelector(".chat-card-file .chat-card-icon")?.textContent).toBe("📊");
    expect(card.querySelector(".chat-card-name")?.textContent).toBe("Competitive_Analysis.xlsx");
    expect(card.querySelector(".chat-card-meta")?.textContent).toBe("Spreadsheet · 24 KB");
    expect(renderChatAttachment({ kind: "file", name: "a.txt" }).querySelector(".chat-card-icon")?.textContent).toBe("📄");
  });

  test("图片卡：占位 + 说明文字，带 img 语义", () => {
    const card = renderChatAttachment({ kind: "image", alt: "Comparison chart screenshot" });
    const img = card.querySelector(".chat-card-img");
    expect(img?.textContent).toBe("Comparison chart screenshot");
    expect(img?.getAttribute("role")).toBe("img");
  });

  test("语音气泡：播放键 + 波形 + 时长；波形高度走 CSSOM 赋值且按时长稳定", () => {
    const card = renderChatAttachment({ kind: "audio", durationMs: 42_000 });
    expect(card.querySelector(".chat-card-dur")?.textContent).toBe("0:42");
    const bars = Array.from(card.querySelectorAll<HTMLElement>(".chat-card-wave i"));
    expect(bars).toHaveLength(CHAT_WAVEFORM_BARS);
    for (const bar of bars) {
      const height = Number.parseInt(bar.style.height, 10);
      expect(height).toBeGreaterThanOrEqual(3);
      expect(height).toBeLessThanOrEqual(17);
    }
    // 同一条每次打开一模一样；不同时长才不同。
    expect(stableWaveform(42_000)).toEqual(stableWaveform(42_000));
    expect(stableWaveform(42_000)).not.toEqual(stableWaveform(41_000));
    expect(formatClipDuration(65_400)).toBe("1:05");
    // 没给播放回调：播放键画出来但 disabled，不是假门。
    const play = card.querySelector<HTMLButtonElement>(".chat-card-play");
    expect(play?.disabled).toBeTrue();
  });

  test("给了播放回调的语音气泡可点，回调拿到这条附件", () => {
    const played: number[] = [];
    const card = renderChatAttachment(
      { kind: "audio", durationMs: 4_000, waveform: [5, 9, 12] },
      { onPlayAudio: (att) => played.push(att.durationMs) },
    );
    const play = card.querySelector<HTMLButtonElement>(".chat-card-play");
    expect(play?.disabled).toBeFalse();
    play?.click();
    expect(played).toEqual([4_000]);
    expect(card.querySelectorAll(".chat-card-wave i")).toHaveLength(3);
  });

  test("包内没有内联 style 属性（插件 CSP 无 unsafe-inline）", () => {
    const source = ["dom.ts", "message.ts", "composer.ts"]
      .map((name) => readFileSync(join(import.meta.dir, "..", "src", name), "utf8"))
      .join("\n")
      // 只查代码，注释里提到「别这么写」不算。
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(source).not.toMatch(/setAttribute\(\s*["']style["']/);
    expect(source).not.toMatch(/style=["']/);
    expect(source).not.toMatch(/\.cssText\s*=/);
  });
});

describe("输入坞（稿 .chat-input-bar）", () => {
  function mount(overrides: Partial<Parameters<typeof mountChatComposer>[1]> = {}) {
    const host = document.createElement("div");
    document.body.append(host);
    const sent: string[] = [];
    const drafts: string[] = [];
    let toggles = 0;
    const composer = mountChatComposer(host, {
      placeholder: "Say something or type…",
      onSend: (text) => sent.push(text),
      onDraftChange: (value) => drafts.push(value),
      mic: { state: "idle", onToggle: () => { toggles += 1; } },
      ...overrides,
    });
    return { host, composer, sent, drafts, toggles: () => toggles };
  }

  test("结构是 [+][输入框][麦克风]，文案透传；+ 钮无回调时 disabled 并带说明", () => {
    const { host, composer } = mount();
    const bar = host.querySelector(".chat-input-bar");
    expect(Array.from(bar?.children ?? []).map((node) => node.className))
      .toEqual(["chat-attach", "chat-input", "chat-mic"]);
    expect(composer.input.placeholder).toBe("Say something or type…");
    const attach = host.querySelector<HTMLButtonElement>(".chat-attach");
    expect(attach?.disabled).toBeTrue();
    expect(attach?.title).toBe("暂不支持添加附件");
    expect(host.querySelector(".chat-mic")?.getAttribute("aria-label")).toBe("语音输入");
  });

  test("给了 onAttach 时 + 钮可点", () => {
    let attached = 0;
    const { host } = mount({ onAttach: () => { attached += 1; } });
    const attach = host.querySelector<HTMLButtonElement>(".chat-attach");
    expect(attach?.disabled).toBeFalse();
    attach?.click();
    expect(attached).toBe(1);
  });

  test("hideAttach removes the entry while preserving text and microphone interaction", () => {
    let attached = 0;
    const { host, composer, sent, toggles } = mount({ hideAttach: true, onAttach: () => attached++ });
    expect(host.querySelector(".chat-attach")).toBeNull();
    expect(Array.from(composer.element.children).map(child => child.className)).toEqual(["chat-input", "chat-mic"]);
    composer.input.value = "synthetic plain text";
    composer.input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    host.querySelector<HTMLButtonElement>(".chat-mic")!.click();
    expect(sent).toEqual(["synthetic plain text"]);
    expect(toggles()).toBe(1);
    expect(attached).toBe(0);
    composer.dispose();
    expect(host.querySelector(".chat-input-bar")).toBeNull();
  });

  test("Enter 发送去空白后的文本，空串不发，输入法合成中的 Enter 不发；本包不替消费方清空", () => {
    const { composer, sent } = mount();
    const enter = () => composer.input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    enter();
    expect(sent).toEqual([]);
    composer.input.value = "  加一句：有问题随时联系我。 ";
    composer.input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, isComposing: true } as KeyboardEventInit));
    expect(sent).toEqual([]);
    enter();
    expect(sent).toEqual(["加一句：有问题随时联系我。"]);
    expect(composer.input.value).toBe("  加一句：有问题随时联系我。 ");
  });

  test("击键回调草稿；setDraft / appendDraft 只改这个输入框并通知", () => {
    const { composer, drafts } = mount({ draft: "hello" });
    expect(composer.input.value).toBe("hello");
    composer.input.value = "hello w";
    composer.input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(drafts).toEqual(["hello w"]);
    composer.appendDraft("world");
    expect(composer.input.value).toBe("hello w world");
    composer.setDraft("你好");
    composer.appendDraft("世界");
    expect(composer.input.value).toBe("你好世界");
    expect(drafts.at(-1)).toBe("你好世界");
    expect(document.activeElement).toBe(composer.input);
  });

  test("麦克风三态：idle 可点、listening 标成按下且文案换成收工、busy / disabled 不可点", () => {
    const idle = mount();
    idle.host.querySelector<HTMLButtonElement>(".chat-mic")?.click();
    expect(idle.toggles()).toBe(1);

    const listening = mount({
      mic: { state: "listening", onToggle: () => undefined, labels: { idle: "开始听写", listening: "完成听写" } },
    });
    const mic = listening.host.querySelector<HTMLButtonElement>(".chat-mic");
    expect(mic?.classList.contains("is-listening")).toBeTrue();
    expect(mic?.getAttribute("aria-pressed")).toBe("true");
    expect(mic?.title).toBe("完成听写");

    const busy = mount({ mic: { state: "busy", disabled: true, onToggle: () => undefined } });
    expect(busy.host.querySelector<HTMLButtonElement>(".chat-mic")?.disabled).toBeTrue();
    const disabledInput = mount({ disabled: true });
    expect(disabledInput.composer.input.disabled).toBeTrue();
  });

  test("dispose 把坞从 DOM 摘掉", () => {
    const { host, composer } = mount();
    composer.dispose();
    expect(host.querySelector(".chat-input-bar")).toBeNull();
  });
});

 test("locale changes preserve the composer input, draft, selection and IME behavior", () => {
  setVoiceLocale("zh");
  const host = document.createElement("div");
  document.body.append(host);
  let sends = 0;
  const composer = mountChatComposer(host, {
    placeholder: () => t("chat.message8"), draft: "正在写 draft", onSend: () => sends++,
    mic: { state: "idle", onToggle() {} },
  });
  const input = composer.input;
  input.focus();
  input.setSelectionRange(2, 4);
  setVoiceLocale("en");
  expect(composer.input).toBe(input);
  expect(input.placeholder).toBe("Say something or type…");
  expect(input.value).toBe("正在写 draft");
  expect(document.activeElement).toBe(input);
  expect([input.selectionStart, input.selectionEnd]).toEqual([2, 4]);
  expect(host.querySelector(".chat-attach")?.getAttribute("aria-label")).toBe("Add attachment");
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true }));
  expect(sends).toBe(0);
  composer.dispose();
  host.remove();
  setVoiceLocale("zh");
});

describe("过程折叠（稿 .voice-process）：一个回合一条，默认折叠", () => {
  const group = (status: "running" | "completed" | "failed", calls: ChatToolCallEntry[]) => renderChatMessage({
    from: "ai", text: "", at: AT,
    card: { kind: "tool-group", status, label: "已调用 3 个工具", meta: "用时 8 秒", icon: "globe", calls, totalCalls: calls.length },
  });

  test("摘要行一条：图标 + 主句 + 右侧补充 + 展开箭头；点开出全部明细，再点收起", () => {
    const row = group("completed", [
      { tool: "web_search", label: "联网搜索", status: "completed", at: AT, icon: "globe", durationMs: 1200 },
      { tool: "web_fetch", label: "读取网页", status: "failed", at: AT, icon: "globe", errorLabel: "目标网页拒绝读取（错误码 web_fetch_blocked）" },
      { tool: "read", label: "读取文件", status: "completed", at: AT },
    ]);
    expect(row.querySelectorAll(".chat-status-card")).toHaveLength(1);
    const head = row.querySelector<HTMLButtonElement>(".chat-status-head.chat-status-toggle")!;
    expect(head.querySelector(".chat-status-label")?.textContent).toBe("已调用 3 个工具");
    expect(head.querySelector(".chat-status-meta")?.textContent).toBe("用时 8 秒");
    expect(head.querySelector(".chat-status-chevron svg")).not.toBeNull();
    const calls = row.querySelector(".chat-status-calls")!;
    expect(head.getAttribute("aria-expanded")).toBe("false");
    expect(calls.hasAttribute("hidden")).toBeTrue();
    head.click();
    expect(head.getAttribute("aria-expanded")).toBe("true");
    expect(calls.hasAttribute("hidden")).toBeFalse();
    expect(Array.from(calls.querySelectorAll(".chat-status-call-name"), (node) => node.textContent))
      .toEqual(["联网搜索", "读取网页", "读取文件"]);
    expect(calls.querySelector(".chat-status-call[data-status='failed'] .chat-status-call-error")?.textContent)
      .toBe("目标网页拒绝读取（错误码 web_fetch_blocked）");
    expect(calls.querySelector(".chat-status-call-duration")?.textContent).toBe("1.2s");
    head.click();
    expect(head.getAttribute("aria-expanded")).toBe("false");
    expect(calls.hasAttribute("hidden")).toBeTrue();
  });

  test("联网 / 网页类用地球仪：只在运行中转动表面，外形不旋转；其他工具保持各自图标", () => {
    const running = group("running", [
      { tool: "web_search", status: "completed", at: AT, icon: "globe" },
      { tool: "web_fetch", status: "running", at: AT, icon: "globe" },
      { tool: "command", status: "running", at: AT },
    ]);
    const headGlobe = running.querySelector(".chat-status-head .chat-status-icon[data-icon='globe'] svg.chat-globe")!;
    expect(headGlobe.getAttribute("data-spinning")).toBe("true");
    // 外轮廓在裁剪组外、不动；动的只有裁剪圆里的表面组，且裁剪 id 每个实例唯一。
    expect(Array.from(headGlobe.children).some((node) => node.tagName.toLowerCase() === "circle")).toBeTrue();
    expect(headGlobe.querySelector("g[clip-path] .chat-globe-surface")).not.toBeNull();
    const rows = Array.from(running.querySelectorAll<HTMLElement>(".chat-status-call"));
    expect(rows[0]!.querySelector(".chat-globe")?.getAttribute("data-spinning")).toBe("false");
    expect(rows[1]!.querySelector(".chat-globe")?.getAttribute("data-spinning")).toBe("true");
    expect(rows[2]!.querySelector(".chat-globe")).toBeNull();
    expect(rows[2]!.querySelector(".chat-status-icon[data-icon='loader']")).not.toBeNull();
    const ids = Array.from(running.querySelectorAll("clipPath"), (node) => node.id);
    expect(new Set(ids).size).toBe(ids.length);
    const done = group("completed", [{ tool: "web_search", status: "completed", at: AT, icon: "globe" }]);
    expect(done.querySelector(".chat-status-head .chat-globe")?.getAttribute("data-spinning")).toBe("false");
    const failed = group("failed", [{ tool: "web_fetch", status: "failed", at: AT, icon: "globe" }]);
    expect(failed.querySelector(".chat-status-head .chat-globe")?.getAttribute("data-spinning")).toBe("false");
  });

  test("运行中的已用时间由消费方给活节点；样式只让转圈整颗旋转，地球仪只平移表面，减弱动态时静止", () => {
    const row = renderChatMessage({ from: "ai", text: "", at: AT,
      card: { kind: "tool-group", status: "running", label: "正在读取网页", calls: [{ tool: "web_fetch", status: "running", at: AT }] } },
    { renderToolGroupMeta: () => document.createTextNode("已用 6 秒") });
    expect(row.querySelector(".chat-status-meta")?.textContent).toBe("已用 6 秒");
    const css = readFileSync(join(import.meta.dir, "../src/chat-ui.css"), "utf8");
    expect(css).toMatch(/\.chat-globe\[data-spinning="true"\] \.chat-globe-surface\{animation:chat-globe-turn/);
    expect(css).toMatch(/@keyframes chat-globe-turn\{to\{transform:translateX\(-18px\)\}\}/);
    expect(css).not.toMatch(/\.chat-globe[^{]*\{[^}]*rotate/);
    expect(css).toMatch(/prefers-reduced-motion:reduce\)\{[^}]*\.chat-globe\[data-spinning="true"\] \.chat-globe-surface\{animation:none/);
  });
});
