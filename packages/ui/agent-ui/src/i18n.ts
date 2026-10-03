/**
 * @reai/agent-ui 的实例级界面文案本地化。
 *
 * 库自身不持有语言状态，也不内置 Host 订阅：消费者（插件）按 Host locale
 * 快照创建一个实例、把自己的 assets/locales/*.json 资源表喂进来、挂载组件
 * 时注入，并在 ctx.locale.onChange 里 setLocale。资源格式与
 * platform/docs/plugin-i18n-v1.md 完全同构（嵌套对象 + 字符串叶子 + `{name}`
 * 插值），不引入第二套语言包格式；不注入实例的挂载沿用历史内置中文。
 *
 * 一个视图实例一个 AgentUiI18n；两个实例互不影响，也不存在全局可变 locale。
 */

/** 文案来源：字面量，或每次语言变化时重新求值的纯文本 getter。 */
export type AgentUiTextSource = string | (() => AgentUiTextSource);

/** 一份语言资源表：插件 assets/locales/<locale>.json 的原样解析结构。 */
export type AgentUiLocaleMessages = Record<string, unknown>;

export interface AgentUiI18nOptions {
  /** 初始语言标签（Host 解析后的 "zh" / "en"）。默认 "zh"。 */
  locale?: string;
  /** 消费者资源表，按语言标签索引；未覆盖的键按回退链走内置默认文案。 */
  messages?: Record<string, AgentUiLocaleMessages>;
}

interface TextBinding {
  node: WeakRef<Node>;
  attribute?: string;
  update(node: Node): void;
}

export interface AgentUiI18n {
  /** 当前语言标签。 */
  readonly locale: string;
  /** 取一条文案；缺键回退链见文档，最终 miss 时告警并返回键本身。 */
  t(key: string, params?: Record<string, string | number>): string;
  /**
   * 切换语言并原地更新本实例绑定的全部节点与订阅者。
   * 语言未变化时是幂等 no-op（Host onChange 会重放当前语言，可重复调用），
   * 返回是否真的发生了切换。
   */
  setLocale(locale: string): boolean;
  /**
   * 绑定节点文本。目标是元素时独占一个专用文本子节点（清掉既有子节点），
   * 语言变化只改这个文本节点，不重建元素——消费者挂在元素上的图标、
   * 控件和事件监听不受影响。
   */
  bindText(node: Node, source: AgentUiTextSource): void;
  /** 绑定元素属性（placeholder / title / aria-* 等），语言变化时重新求值。 */
  bindAttribute(element: Element, name: string, source: AgentUiTextSource): void;
  /** 丢弃 root 子树内的全部绑定（业务重渲染替换子树、或组件卸载时调用）。 */
  releaseBindings(root: Node): void;
  /** 订阅语言变化（文案已更新之后触发）；返回退订函数。 */
  onChange(listener: (locale: string) => void): () => void;
  /** 释放全部绑定与订阅（视图卸载）。之后 setLocale 不再触碰任何节点。 */
  dispose(): void;
}

/**
 * 内置默认文案：不注入实例时的历史中文行为来源，也是消费者资源缺键时的
 * 兜底。键结构就是文档里的资源键映射表，消费者可直接抄进自己的
 * assets/locales/*.json 后按需改写。
 */
export const AGENT_UI_DEFAULT_MESSAGES: Record<string, AgentUiLocaleMessages> = {
  zh: {
    agentUi: {
      status: { wait: "等你确认", busy: "工作中", idle: "空闲", off: "离线" },
      message: { selfAvatar: "我" },
      card: { imageAlt: "图片" },
      anchor: { running: "进行中", done: "已完成" },
      work: { elapsed: "耗时 {duration}", running: "已运行 {duration}" },
      ask: { confirmed: "✓ 已确认", answer: "你的回答：{answer}" },
      composer: {
        backToLatest: "回到最新消息",
        expandPrompt: "展开待确认 Action 并回到最新",
        attach: "添加附件",
        voice: "语音输入",
        promptKind: "Action",
      },
      resizer: { hint: "拖动调整宽度 · 双击复位" },
      duration: {
        seconds: "{seconds} 秒",
        minutes: "{minutes} 分",
        minutesSeconds: "{minutes} 分 {seconds} 秒",
      },
    },
  },
  en: {
    agentUi: {
      status: { wait: "Needs confirmation", busy: "Working", idle: "Idle", off: "Offline" },
      message: { selfAvatar: "Me" },
      card: { imageAlt: "Image" },
      anchor: { running: "In progress", done: "Done" },
      work: { elapsed: "Took {duration}", running: "Running {duration}" },
      ask: { confirmed: "✓ Confirmed", answer: "Your answer: {answer}" },
      composer: {
        backToLatest: "Back to latest message",
        expandPrompt: "Expand pending action and go to latest",
        attach: "Add attachment",
        voice: "Voice input",
        promptKind: "Action",
      },
      resizer: { hint: "Drag to resize · double-click to reset" },
      duration: {
        seconds: "{seconds}s",
        minutes: "{minutes}m",
        minutesSeconds: "{minutes}m {seconds}s",
      },
    },
  },
};

/** 解析 TextSource：函数递归展开，非字符串（null/undefined 防御）归零为 ""。 */
export function readAgentUiText(source: AgentUiTextSource): string {
  return typeof source === "function" ? readAgentUiText(source()) : source ?? "";
}

function lookup(table: unknown, key: string): string | undefined {
  let value: unknown = table;
  for (const part of key.split(".")) {
    if (!value || typeof value !== "object" || !Object.hasOwn(value, part)) return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return typeof value === "string" ? value : undefined;
}

export function createAgentUiI18n(options: AgentUiI18nOptions = {}): AgentUiI18n {
  const custom = options.messages ?? {};
  let locale = options.locale ?? "zh";
  const bindings = new Set<TextBinding>();
  const listeners = new Set<(locale: string) => void>();

  const t = (key: string, params: Record<string, string | number> = {}): string => {
    // 回退链：所选语言的消费者资源 → 消费者英文 → 所选语言的内置默认 →
    // 内置英文 → 内置中文。避免混语优先落消费者自己的英文（规范要求），
    // 消费者完全没覆盖时才走内置表。
    const tables = [custom[locale], custom.en, AGENT_UI_DEFAULT_MESSAGES[locale], AGENT_UI_DEFAULT_MESSAGES.en, AGENT_UI_DEFAULT_MESSAGES.zh];
    for (const table of tables) {
      const message = lookup(table, key);
      if (message !== undefined) {
        // 单趟替换：插值参数按普通文本显示，不再作为消息或 HTML 解析。
        return message.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (match, name: string) =>
          Object.hasOwn(params, name) ? String(params[name]) : match);
      }
    }
    console.warn(`[agent-ui:i18n] Missing message: ${key}`);
    return key;
  };

  const releaseBindings = (root: Node): void => {
    for (const binding of [...bindings]) {
      const node = binding.node.deref();
      if (!node || node === root || root.contains(node)) bindings.delete(binding);
    }
  };

  return {
    get locale() { return locale; },
    t,
    setLocale(next: string): boolean {
      if (next === locale) return false;
      locale = next;
      for (const binding of [...bindings]) {
        const node = binding.node.deref();
        if (!node) { bindings.delete(binding); continue; }
        try { binding.update(node); } catch (cause) { console.warn("[agent-ui:i18n] Text binding failed", cause); }
      }
      for (const listener of [...listeners]) {
        try { listener(locale); } catch (cause) { console.warn("[agent-ui:i18n] Locale listener failed", cause); }
      }
      return true;
    },
    bindText(node: Node, source: AgentUiTextSource): void {
      // 独占一个文本节点：语言更新永远不替换元素本身，消费者随后 append
      // 的图标/控件也不会被清掉。
      let target = node;
      if (node.nodeType !== Node.TEXT_NODE) {
        for (const child of Array.from(node.childNodes)) releaseBindings(child);
        node.textContent = "";
        target = document.createTextNode("");
        node.appendChild(target);
      }
      const update = (text: Node) => {
        const value = readAgentUiText(source);
        if (text.textContent !== value) text.textContent = value;
      };
      update(target);
      bindings.add({ node: new WeakRef(target), update });
    },
    bindAttribute(element: Element, name: string, source: AgentUiTextSource): void {
      for (const binding of [...bindings]) {
        if (binding.node.deref() === element && binding.attribute === name) bindings.delete(binding);
      }
      const update = (node: Node) => {
        const target = node as Element;
        const value = readAgentUiText(source);
        if (target.getAttribute(name) !== value) target.setAttribute(name, value);
      };
      update(element);
      bindings.add({ node: new WeakRef(element), attribute: name, update });
    },
    releaseBindings,
    onChange(listener: (locale: string) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose(): void {
      bindings.clear();
      listeners.clear();
    },
  };
}
