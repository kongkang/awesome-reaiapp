/** Keep developer templates inside the business view. Do not execute template code. */
const TAGS = new Set('DIV SECTION ARTICLE HEADER FOOTER H1 H2 H3 H4 P SPAN STRONG EM SMALL UL OL LI TABLE THEAD TBODY TR TH TD CAPTION BR HR'.split(' '));
const DROP = new Set('SCRIPT STYLE IFRAME OBJECT EMBED LINK META SVG MATH IMG AUDIO VIDEO FORM INPUT BUTTON TEXTAREA SELECT'.split(' '));
const PROPERTIES = new Set('color background-color font-size font-weight line-height letter-spacing text-align padding padding-top padding-bottom padding-left padding-right margin margin-top margin-bottom margin-left margin-right border border-color border-width border-style border-radius display gap grid-template-columns align-items justify-content max-width'.split(' '));
const encoder = new TextEncoder();
const cssName = '[a-zA-Z_][a-zA-Z0-9_-]*';
const cssClass = `\\.${cssName}`;
const cssCompound = `(?:[a-zA-Z][a-zA-Z0-9-]*(?:${cssClass})*|(?:${cssClass})+)`;
const cssSelector = new RegExp(`^${cssCompound}(?:(?:\\s*>\\s*|\\s+)${cssCompound})*$`);

export function renderSafeTemplate(container: HTMLElement, html: string, values: Record<string, string>): void {
  if (encoder.encode(html).length > 16_384) throw new Error('页面模板不能超过 16 KiB');
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  const copy = (node: Node, parent: Node): void => {
    if (node.nodeType === 3) {
      const content = (node.textContent ?? '').replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (_match, key: string) => values[key] ?? '');
      parent.appendChild(document.createTextNode(content)); return;
    }
    if (node.nodeType !== 1) return;
    const element = node as Element;
    if (DROP.has(element.tagName)) return;
    if (!TAGS.has(element.tagName)) { for (const child of Array.from(node.childNodes)) copy(child, parent); return; }
    const safe = document.createElement(element.tagName.toLowerCase());
    const cls = element.getAttribute('class');
    if (cls && /^[a-zA-Z0-9_ -]{1,128}$/.test(cls)) safe.className = cls;
    for (const child of Array.from(node.childNodes)) copy(child, safe);
    parent.appendChild(safe);
  };
  const fragment = document.createDocumentFragment();
  for (const node of Array.from(parsed.body.childNodes)) copy(node, fragment);
  container.replaceChildren(fragment);
}

export function validateScopedCss(css: string): Array<{ selector: string; declarations: Array<[string, string]> }> {
  if (encoder.encode(css).length > 8_192) throw new Error('自定义 CSS 不能超过 8 KiB');
  if (/[@\\\x00-\x08\x0b\x0c\x0e-\x1f]|url\s*\(|expression\s*\(|\/\*/i.test(css)) throw new Error('CSS 含有不允许的外链、转义或 Host Token 覆盖');
  const rules: Array<{ selector: string; declarations: Array<[string, string]> }> = [];
  let remaining = css;
  while (remaining.trim()) {
    const match = /^\s*([^{}]+)\{([^{}]*)\}/.exec(remaining);
    if (!match) throw new Error('CSS 只支持普通选择器和样式声明');
    const selector = match[1]!.trim();
    if (selector.length > 160 || !selector.split(',').every(part=>cssSelector.test(part.trim()))) throw new Error('CSS 选择器不在允许范围');
    const declarations: Array<[string, string]> = [];
    for (const raw of match[2]!.split(';').filter(x => x.trim())) {
      const colon = raw.indexOf(':');
      const key = raw.slice(0, colon).trim().toLowerCase(); const value = raw.slice(colon + 1).trim();
      if (colon < 1 || !PROPERTIES.has(key) || !value || value.length > 160 || /[{}<>!]|(?:fixed|absolute|none|hidden)/i.test(value)) throw new Error(`CSS 属性不允许：${key}`);
      if (!/^[a-zA-Z0-9_#().,%\s\-]+$/.test(value)) throw new Error('CSS 值不在允许范围');
      declarations.push([key, value]);
    }
    rules.push({ selector, declarations }); remaining = remaining.slice(match[0].length);
  }
  return rules;
}

export function applyScopedCss(container: HTMLElement, css: string): () => void {
  const previous: Array<{ el: HTMLElement; key: string; value: string }> = [];
  for (const rule of validateScopedCss(css)) {
    for (const el of Array.from(container.querySelectorAll<HTMLElement>(rule.selector))) {
      for (const [key, value] of rule.declarations) {
        previous.push({ el, key, value: el.style.getPropertyValue(key) });
        el.style.setProperty(key, value);
      }
    }
  }
  return () => { for (const entry of previous.reverse()) entry.el.style.setProperty(entry.key, entry.value); };
}
