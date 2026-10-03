/**
 * 可拖宽栏的手柄（A4-22，对照设计稿 makeResizer / tmResize，V1.5.1 §「可拖拽栏宽」）。
 *
 * 形态与交互逐字对稿：命中区 8px 贴栏右缘（right:-3px；栏自身 overflow:hidden
 * 时悬出部分被裁、有效热区为栏内 5px——与稿 .tm-side 同几何）、
 * 平时隐形，hover / 拖拽时一条 2px 强调竖线淡入（opacity .85 / .15s）。
 * 交互用 pointer 事件 + setPointerCapture——拖出手柄范围甚至拖出窗口都不丢事件；
 * move/up 挂 document 而不是手柄：捕获失败（部分 WebView 会拒绝）时也还收得到，
 * 一条路径覆盖两种情况。宽度纪律照搬 Host layout.ts 踩过的坑：
 * 用户意愿（intent）与显示宽度（display）分离——窗口被拉窄只影响显示值，
 * 一个字节都不落盘；只有用户动作（拖、双击复位）才写 localStorage。
 */
import { element } from "./dom";
import { createAgentUiI18n, type AgentUiI18n } from "./i18n";

/** 稿 PANE_MAX=540：1080 基准窗口的一半，栏最多占一半 */
const PANE_MAX = 540;
/** 稿 CENTER_MIN=320：右侧内容区下界，栏再怎么拉也不能把它挤没 */
const CENTER_MIN = 320;
/** 手柄写到栏上的 CSS 变量；窄档断点以下由样式表窄档接管宽度，此变量移除 */
const PANE_W_VAR = "--pane-w";

export interface PaneResizerOptions {
  /** localStorage 键（按调用方 app 前缀，如 "agents-tasks.paneWidth"） */
  storageKey: string;
  /** 默认宽度（双击复位也回到它）。tasks 对稿 TM_DEF=264，恰与 --agent-pane 默认一致 */
  def: number;
  /** 最小宽度（稿 TM_MIN=260：任务卡第二行不换行且完整的下界） */
  min: number;
  /** 右侧固定占用（如推挤抽屉展开的 236px；对稿 sideCost——两栏拉满不能把聊天区挤到几十像素） */
  sideCost?: () => number;
  /** 窄于该视口宽时宽度概念失效（稿 520 是稿自己的横排断点；此处对齐样式表把
   *  宽度钉死的窄档，如 agent-ui 的 720），手柄停用且记忆值让位 */
  narrowBreakpoint?: number;
  /** 手柄的 aria-label（说明拖的是什么栏；消费者文案，不随语言实例翻译） */
  ariaLabel: string;
  /** 实例级语言入口：只管手柄 title 提示；缺省沿用历史内置中文。 */
  i18n?: AgentUiI18n;
}

export interface PaneResizer {
  dispose(): void;
}

/* 存储容错照稿 safeNum：file:// 或受限 WebView 里 localStorage 可能直接抛异常，
   存不了就只保留内存态，不能因此打断交互。 */
function readLocalNum(key: string, fallback: number): number {
  try {
    const value = Number.parseFloat(localStorage.getItem(key) ?? "");
    return Number.isFinite(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

function writeLocalNum(key: string, value: number): void {
  try {
    localStorage.setItem(key, String(Math.round(value)));
  } catch {
    // 存不了就算了，本次运行仍生效
  }
}

/**
 * 在 pane 右缘挂一个拖宽手柄。pane 需要自身 position:relative（手柄的定位锚点，
 * 缺了会跑到更外层容器上错位——稿 .al 同一条注释）。
 */
export function mountPaneResizer(pane: HTMLElement, appEl: HTMLElement, options: PaneResizerOptions): PaneResizer {
  const paneMax = PANE_MAX;
  const centerMin = CENTER_MIN;
  const narrow = options.narrowBreakpoint ?? 720;
  const sideCost = options.sideCost ?? (() => 0);
  const i18n = options.i18n ?? createAgentUiI18n();

  const handle = element("div", "rs-handle");
  handle.title = i18n.t("agentUi.resizer.hint");
  i18n.bindAttribute(handle, "title", () => i18n.t("agentUi.resizer.hint"));
  handle.setAttribute("role", "separator");
  handle.setAttribute("aria-orientation", "vertical");
  handle.setAttribute("aria-label", options.ariaLabel);
  handle.setAttribute("aria-valuemin", String(options.min));
  handle.setAttribute("aria-valuemax", String(paneMax));
  pane.appendChild(handle);

  /* 窄档判断走媒体查询口径（含滚动条的视口宽）——与 CSS 断点同一把尺子；
     innerWidth 不含滚动条，Windows 经典滚动条下两者差十几像素，那区间会出现
     「手柄可见却拖不动」的死区。matchMedia 不可用的极老 WebView 退回 innerWidth。 */
  const narrowQuery = typeof window.matchMedia === "function"
    ? window.matchMedia(`(max-width: ${narrow}px)`)
    : null;
  function isNarrow(): boolean {
    return narrowQuery ? narrowQuery.matches : window.innerWidth <= narrow;
  }

  /* 用户意愿宽：只有用户动作能改它；恢复时读盘，读不到用默认 */
  let intentW = readLocalNum(options.storageKey, options.def);
  let disposed = false;

  /* 测试环境量不出布局（clientWidth=0）时按稿的基准窗口 1080 兜底（winW 同款） */
  function appWidth(): number {
    return appEl.clientWidth || 1080;
  }

  function maxWidth(): number {
    return Math.max(options.min, Math.min(paneMax, appWidth() - sideCost() - centerMin));
  }

  /**
   * 唯一写出口（对稿 applyUI）：把意愿夹进「当前容器放得下」的区间画出去。
   * persist=false 用于拖拽途中——每帧写 localStorage 就是每秒两百多次同步 I/O，
   * 松手落一次盘就够。窄档下移除变量：宽度交还样式表窄档（如 --agent-pane:226px），
   * 记忆值只在宽度概念成立的区间生效。
   */
  function apply(persist: boolean): void {
    const display = Math.min(Math.max(intentW, options.min), maxWidth());
    if (isNarrow()) pane.style.removeProperty(PANE_W_VAR);
    else pane.style.setProperty(PANE_W_VAR, `${Math.round(display)}px`);
    handle.setAttribute("aria-valuenow", String(Math.round(display)));
    if (persist) writeLocalNum(options.storageKey, intentW);
  }

  /* ===== 拖拽（对稿 makeResizer 逐事件照搬） ===== */
  let startX = 0;
  let startW = 0;
  let pid: number | null = null;

  const onMove = (event: PointerEvent): void => {
    if (pid === null || event.pointerId !== pid) return;
    /* 拖拽是用户意愿：夹一次再记，夹的是他拖到的位置。只夹不记的话，
       从默认宽一把拖过头会把越界值当意愿存下来，窗口一变大又「弹」出来。 */
    intentW = Math.min(Math.max(startW + (event.clientX - startX), options.min), maxWidth());
    apply(false);
  };

  const stop = (event?: PointerEvent, settle = true): void => {
    if (pid === null || (event && event.pointerId !== pid)) return;
    /* 先复位 pid / 摘监听 / 摘类，再 release：lostpointercapture 的处理器就是
       stop 本体，个别 WebView 会同步派发它——门口先短路，重入进来是 no-op，
       不会带着 settle 语义再落一次盘。 */
    const captured = pid;
    pid = null;
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", stop);
    document.removeEventListener("pointercancel", stop);
    handle.classList.remove("dragging");
    document.body.classList.remove("rs-dragging");
    try {
      handle.releasePointerCapture(captured);
    } catch {
      // 捕获早就被系统收走了，这里只是复位，收不回来无所谓
    }
    /* settle=true：松手是用户动作的终点，落一次盘；dispose 复用复位逻辑时
       传 false——视图卸载不是用户意图，不该把拖到一半的值永久写进本地。 */
    if (settle) apply(true);
  };

  const onDown = (event: PointerEvent): void => {
    /* 窄档下宽度由样式表接管，「拖着改宽度」不成立（稿小屏短路同一条判断） */
    if (isNarrow()) return;
    event.preventDefault(); // 连同 CSS 的 touch-action:none 一起挡掉触控板滚动/选中抖动
    pid = event.pointerId;
    try {
      handle.setPointerCapture(pid);
    } catch {
      // 部分 WebView 会拒绝捕获；move/up 挂 document，照样收得到
    }
    startX = event.clientX;
    startW = Math.min(Math.max(intentW, options.min), maxWidth()); // 从屏幕上看到的宽度起拖，第一帧不跳
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", stop);
    document.addEventListener("pointercancel", stop);
    handle.classList.add("dragging");
    document.body.classList.add("rs-dragging"); // 锁死整页光标与选区（拖出栏外不再变文本光标）
  };

  const onDblClick = (event: MouseEvent): void => {
    if (isNarrow()) return;
    event.preventDefault();
    intentW = options.def;
    apply(true);
  };

  /* 窗口尺寸变了：只重算显示宽度，不落盘——窗口被拉窄不等于用户想要更窄的栏，
     拉回去时他期待栏也回来（Host layout.ts 踩过的坑，稿 rsRaf 同款 rAF 节流）。 */
  let reflowRaf = 0;
  const onResize = (): void => {
    if (reflowRaf) return;
    reflowRaf = requestAnimationFrame(() => {
      reflowRaf = 0;
      if (!disposed) apply(false);
    });
  };

  handle.addEventListener("pointerdown", onDown);
  handle.addEventListener("lostpointercapture", stop as EventListener); // 捕获被系统收走时兜底复位
  handle.addEventListener("dblclick", onDblClick);
  window.addEventListener("resize", onResize);
  apply(false); // 启动只画不写盘：窗口可能还没定型，量出来的值不该变成永久设置

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      stop(undefined, false); // 卸载不是用户意图，不落盘
      if (reflowRaf) cancelAnimationFrame(reflowRaf);
      window.removeEventListener("resize", onResize);
      i18n.releaseBindings(handle);
      handle.remove();
      document.body.classList.remove("rs-dragging");
    },
  };
}
