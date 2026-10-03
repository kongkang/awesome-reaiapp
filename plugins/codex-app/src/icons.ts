// 设计稿 design/VoiceType_UI_Designs.html 的图标表机械映射：
// 键名即 lucide 官方名（设计稿 ICONS 表同源），path 数据逐字取自设计稿，
// 不在本仓库内自造图形。品牌标记 codex 是 fill 型，不走描边体系。
//
// 插件跑在隔离 WebView 里，宿主不提供 <svg> 雪碧图；按 voice-app 同样的
// 「名字 → 内嵌 SVG」落地方式在构建期拼进 DOM。

const STROKE_ICONS: Readonly<Record<string, string>> = {
  check: '<polyline points="20 6 9 17 4 12"/>',
  x: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
  plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
  search: '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
  "chevron-right": '<polyline points="9 18 15 12 9 6"/>',
  "arrow-left": '<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>',
  folder: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>',
  sparkles:
    '<path d="M12 3l1.9 5.8L19.7 10l-5.8 1.9L12 17.7l-1.9-5.8L4.3 10l5.8-1.9z"/>' +
    '<path d="M19 3l.7 2.1L21.8 6l-2.1.7L19 8.8l-.7-2.1L16.2 6l2.1-.7z"/>',
  send: '<line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>',
  globe: '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>',
  workflow:
    '<rect width="8" height="8" x="3" y="3" rx="2"/><path d="M7 11v4a2 2 0 0 0 2 2h4"/><rect width="8" height="8" x="13" y="13" rx="2"/>',
  layers:
    '<polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/>',
  // 设计稿 ICONS 表缺了 file-text 这一条（data-icon="file-text" 渲染成空），
  // 这里按 lucide 官方 file-text 补齐，避免插件里文件图标空一块。
  "file-text":
    '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>' +
    '<polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/>' +
    '<line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/>',
  "external-link":
    '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>' +
    '<polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>',
};

/** 品牌/填充型图标：currentColor 填充、无描边。与设计稿 FILL_ICONS 一致。 */
const FILL_ICONS: Readonly<Record<string, string>> = {
  codex:
    '<path fill-rule="evenodd" clip-rule="evenodd" d="M8.086.457a6.105 6.105 0 013.046-.415c1.333.153 2.521.72 3.564 1.7a.117.117 0 00.107.029c1.408-.346 2.762-.224 4.061.366l.063.03.154.076c1.357.703 2.33 1.77 2.918 3.198.278.679.418 1.388.421 2.126a5.655 5.655 0 01-.18 1.631.167.167 0 00.04.155 5.982 5.982 0 011.578 2.891c.385 1.901-.01 3.615-1.183 5.14l-.182.22a6.063 6.063 0 01-2.934 1.851.162.162 0 00-.108.102c-.255.736-.511 1.364-.987 1.992-1.199 1.582-2.962 2.462-4.948 2.451-1.583-.008-2.986-.587-4.21-1.736a.145.145 0 00-.14-.032c-.518.167-1.04.191-1.604.185a5.924 5.924 0 01-2.595-.622 6.058 6.058 0 01-2.146-1.781c-.203-.269-.404-.522-.551-.821a7.74 7.74 0 01-.495-1.283 6.11 6.11 0 01-.017-3.064.166.166 0 00.008-.074.115.115 0 00-.037-.064 5.958 5.958 0 01-1.38-2.202 5.196 5.196 0 01-.333-1.589 6.915 6.915 0 01.188-2.132c.45-1.484 1.309-2.648 2.577-3.493.282-.188.55-.334.802-.438.286-.12.573-.22.861-.304a.129.129 0 00.087-.087A6.016 6.016 0 015.635 2.31C6.315 1.464 7.132.846 8.086.457zm-.804 7.85a.848.848 0 00-1.473.842l1.694 2.965-1.688 2.848a.849.849 0 001.46.864l1.94-3.272a.849.849 0 000-.854l-1.94-3.393zm5.446 6.24a.849.849 0 000 1.695h4.848a.849.849 0 000-1.696h-4.848z"/>',
};

export type IconName = keyof typeof STROKE_ICONS | keyof typeof FILL_ICONS;

/** 按名渲染 SVG；查不到返回空串——少一个图标比多一个方块好认。 */
export function iconSvg(name: string, size = 16): string {
  const strokePath = STROKE_ICONS[name];
  if (strokePath !== undefined) {
    return (
      `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none"` +
      ' stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      `${strokePath}</svg>`
    );
  }
  const fillPath = FILL_ICONS[name];
  if (fillPath !== undefined) {
    return (
      `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor">` +
      `${fillPath}</svg>`
    );
  }
  return "";
}

/** 设计稿静态 DOM 的 `<span data-icon="x" data-sz="n"></span>` 等价物。 */
export function iconSpan(name: string, size = 16): HTMLSpanElement {
  const span = document.createElement("span");
  span.setAttribute("data-icon", name);
  span.innerHTML = iconSvg(name, size);
  return span;
}
