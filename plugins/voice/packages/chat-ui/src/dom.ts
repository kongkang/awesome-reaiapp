import { bindText, type TextSource } from "./i18n";
export function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = "",
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

export function textElement<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text: TextSource,
): HTMLElementTagNameMap[K] {
  const node = element(tag, className);
  bindText(node, text);
  return node;
}

/**
 * 稿的线性图标体系（`svgi`：24 viewBox、stroke currentColor、stroke-width 2、圆头）。
 * 播放键按稿 `icon('play',10,{fill:'currentColor'})` 走填充；loader/check 是状态卡
 * 自创图形（稿没有这张卡），同规格补两枚。 */
const PATHS = {
  plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
  mic: '<rect x="9" y="1" width="6" height="13" rx="3"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="23" x2="12" y2="19"/>',
  play: '<polygon points="5 3 19 12 5 21 5 3"/>',
  /* loader 是 ¾ 开口弧——旋转中始终可读作 loading 的经典形状；别用「↗」这类
     方向性箭头当 spinner，转起来在截图/掉帧里就是「图标被转歪了」。 */
  loader: '<path d="M21 12a9 9 0 1 1-9-9"/>',
  check: '<polyline points="20 6 9 17 4 12"/>',
  /* 稿 icon('chevron-down')：过程折叠卡右侧的展开指示。 */
  chevronDown: '<polyline points="6 9 12 15 18 9"/>',
} as const;

export type ChatIconName = keyof typeof PATHS;

export function chatIcon(name: ChatIconName, size: number, fill = false): SVGSVGElement {
  const node = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  node.setAttribute("viewBox", "0 0 24 24");
  node.setAttribute("width", String(size));
  node.setAttribute("height", String(size));
  node.setAttribute("aria-hidden", "true");
  node.setAttribute("focusable", "false");
  if (fill) {
    node.setAttribute("fill", "currentColor");
  } else {
    node.setAttribute("fill", "none");
    node.setAttribute("stroke", "currentColor");
    node.setAttribute("stroke-width", "2");
    node.setAttribute("stroke-linecap", "round");
    node.setAttribute("stroke-linejoin", "round");
  }
  node.innerHTML = PATHS[name];
  return node;
}

/*
 * 联网 / 网页类工具的地球仪：外轮廓与赤道不动，裁剪圆里的经线与陆地整组横向平移一个周期
 * （18 个单位 = 圆的直径）后无缝循环，看起来像绕竖轴自转，而不是整颗图标打转。
 * 动不动只由 `data-spinning` 决定（运行中才转，完成 / 失败停住），动画与减弱动态在 CSS 里。
 * 全部是 SVG 属性，没有内联 style（插件 CSP 无 'unsafe-inline'）。
 */
const GLOBE_PERIOD =
  '<path d="M6 2v20M12 2v20M18 2v20" stroke-opacity=".55"/>' +
  '<path d="M4.4 8.3c1.2-1.7 3.5-2.1 4.7-1 .9.8.4 2.1-.6 2.6-1 .5-1.1 1.8-2.4 1.9-1.3.1-2.5-2-1.7-3.5z" fill="currentColor" fill-opacity=".4" stroke="none"/>' +
  '<path d="M12.6 14.1c1-.9 2.9-.8 3.8.2.8.9.3 2.4-.9 2.9-1.1.4-2.3 1.2-3.2.4-.7-.8-.6-2.7.3-3.5z" fill="currentColor" fill-opacity=".4" stroke="none"/>';
let globeSequence = 0;

export function chatGlobe(size: number, spinning: boolean): SVGSVGElement {
  const id = `chat-globe-clip-${++globeSequence}`;
  const node = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  node.setAttribute("viewBox", "0 0 24 24");
  node.setAttribute("width", String(size));
  node.setAttribute("height", String(size));
  node.setAttribute("aria-hidden", "true");
  node.setAttribute("focusable", "false");
  node.setAttribute("class", "chat-globe");
  node.dataset.spinning = String(spinning);
  node.setAttribute("fill", "none");
  node.setAttribute("stroke", "currentColor");
  node.setAttribute("stroke-width", "1.6");
  node.setAttribute("stroke-linecap", "round");
  node.setAttribute("stroke-linejoin", "round");
  node.innerHTML =
    `<defs><clipPath id="${id}"><circle cx="12" cy="12" r="9"/></clipPath></defs>` +
    `<g clip-path="url(#${id})"><g class="chat-globe-surface">${GLOBE_PERIOD}` +
    `<g transform="translate(18 0)">${GLOBE_PERIOD}</g></g>` +
    '<path d="M3 12h18" stroke-opacity=".55"/></g>' +
    '<circle cx="12" cy="12" r="9"/>';
  return node;
}
