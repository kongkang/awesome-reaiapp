/**
 * 文本编辑器界面用到的描边图标。
 *
 * 插件跑在隔离 WebView，看不到宿主的图标表，只能自带一份；做法与 podcast-app 一致：
 * path 与设计稿 ICONS 表同源（lucide 官方名与画法），颜色一律 currentColor，
 * 由外层 CSS 用主题 token 决定，明暗切换自动跟随。名字不在表里时返回空 SVG——
 * 少一个图标比渲染一个坏方块好认。
 */
const PATHS: Record<string, string> = {
  "file-text":
    '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>' +
    '<polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/>' +
    '<line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/>',
  code: '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>',
  plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
  search: '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
  folder: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>',
  "corner-left-up": '<polyline points="9 14 4 9 9 4"/><path d="M20 20v-7a4 4 0 0 0-4-4H4"/>',
  "rotate-ccw": '<path d="M1 4v6h6"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>',
  "rotate-cw": '<path d="M23 4v6h-6"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>',
  "list-todo":
    '<line x1="9" y1="6" x2="21" y2="6"/><line x1="9" y1="12" x2="21" y2="12"/>' +
    '<line x1="9" y1="18" x2="21" y2="18"/><circle cx="4" cy="6" r="1.4"/>' +
    '<circle cx="4" cy="12" r="1.4"/><circle cx="4" cy="18" r="1.4"/>',
};

export type IconName = keyof typeof PATHS;

export function icon(name: string, size: number): SVGSVGElement {
  const node = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  node.setAttribute("width", String(size));
  node.setAttribute("height", String(size));
  node.setAttribute("viewBox", "0 0 24 24");
  node.setAttribute("fill", "none");
  node.setAttribute("stroke", "currentColor");
  node.setAttribute("stroke-width", "2");
  node.setAttribute("stroke-linecap", "round");
  node.setAttribute("stroke-linejoin", "round");
  node.setAttribute("aria-hidden", "true");
  node.innerHTML = PATHS[name] ?? "";
  return node;
}
