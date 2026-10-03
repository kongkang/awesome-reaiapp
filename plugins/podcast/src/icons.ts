/**
 * 播放器用到的几个描边图标（路径与设计稿 ICONS 表一致，名字沿用 lucide 官方名）。
 *
 * 插件跑在隔离 WebView，看不到宿主的图标表，只能自带一份；颜色一律 currentColor，
 * 由外层 CSS 用宿主 token 决定，主题切换自动跟随。
 */
const PATHS: Record<string, string> = {
  podcast:
    '<path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"/>',
  "skip-back": '<polygon points="19 20 9 12 19 4 19 20"/><line x1="5" y1="19" x2="5" y2="5"/>',
  "skip-forward": '<polygon points="5 4 15 12 5 20 5 4"/><line x1="19" y1="5" x2="19" y2="19"/>',
  "rotate-ccw": '<path d="M1 4v6h6"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>',
  "rotate-cw": '<path d="M23 4v6h-6"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>',
  play: '<polygon points="5 3 19 12 5 21 5 3"/>',
  "pause-r": '<rect x="6" y="4" width="4" height="16" rx="1.5"/><rect x="14" y="4" width="4" height="16" rx="1.5"/>',
  clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  "chevron-right": '<polyline points="9 18 15 12 9 6"/>',
  x: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
};

export interface IconOptions {
  /** 实心图标（播放/暂停）：给 fill 就不描边。 */
  filled?: boolean;
  /** 描边粗细，默认 2。 */
  width?: number;
}

export function icon(name: keyof typeof PATHS, size: number, options: IconOptions = {}): SVGSVGElement {
  const node = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  node.setAttribute("width", String(size));
  node.setAttribute("height", String(size));
  node.setAttribute("viewBox", "0 0 24 24");
  node.setAttribute("aria-hidden", "true");
  if (options.filled) {
    node.setAttribute("fill", "currentColor");
  } else {
    node.setAttribute("fill", "none");
    node.setAttribute("stroke", "currentColor");
    node.setAttribute("stroke-width", String(options.width ?? 2));
    node.setAttribute("stroke-linecap", "round");
    node.setAttribute("stroke-linejoin", "round");
  }
  node.innerHTML = PATHS[name] ?? "";
  return node;
}
