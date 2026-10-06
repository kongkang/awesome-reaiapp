/**
 * 语音记录列表的复制按钮（2026-10-06 用户裁定）：默认隐身但保留占位，鼠标移到该条
 * 或键盘聚焦到该条才出现并可点；详情页的复制按钮不受影响；没有悬停能力的设备常显。
 * 测试环境没有真实布局与 :hover，这里静态守住 voice.css 里的规则。
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

type Rule = { media: string | null; selectors: string[]; decls: Map<string, string> };

/** 拆出全部规则，记下所在 @media（顶层为 null）；声明按「属性 → 完整值」存。 */
function parseRules(source: string): Rule[] {
  const css = source.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules: Rule[] = [];
  const walk = (text: string, media: string | null) => {
    let index = 0;
    while (index < text.length) {
      const open = text.indexOf("{", index);
      if (open < 0) break;
      const prelude = text.slice(index, open).trim();
      let depth = 1;
      let close = open + 1;
      for (; close < text.length && depth > 0; close++) {
        if (text[close] === "{") depth++;
        if (text[close] === "}") depth--;
      }
      const body = text.slice(open + 1, close - 1);
      if (prelude.startsWith("@media")) {
        walk(body, prelude.replace(/\s+/g, " "));
      } else if (!prelude.startsWith("@")) {
        const decls = new Map<string, string>();
        for (const decl of body.split(";")) {
          const colon = decl.indexOf(":");
          if (colon < 0) continue;
          decls.set(decl.slice(0, colon).trim(), decl.slice(colon + 1).trim().replace(/\s+/g, " "));
        }
        rules.push({ media, selectors: prelude.split(",").map(part => part.trim().replace(/\s+/g, " ")), decls });
      }
      index = close;
    }
  };
  walk(css, null);
  return rules;
}

const rules = parseRules(readFileSync(resolve(import.meta.dir, "../src/voice.css"), "utf8"));
const matching = (selector: string, media: string | null) =>
  rules.filter(rule => rule.media === media && rule.selectors.includes(selector));
const hidden = (rule: Rule) => rule.decls.get("opacity") === "0" && rule.decls.get("pointer-events") === "none";
const shown = (rule: Rule) => rule.decls.get("opacity") === "1" && rule.decls.get("pointer-events") === "auto";
const removesSpace = (rule: Rule) => rule.decls.get("display") === "none" || rule.decls.get("visibility") === "hidden";

test("列表复制按钮默认（顶层规则）隐身且不可点", () => {
  expect(matching(".task-item .task-copy-row", null).some(hidden)).toBe(true);
});

test("复制按钮保留占位：任何上下文都不用 display:none / visibility:hidden 藏它", () => {
  const offenders = rules.filter(rule =>
    rule.selectors.some(selector => /\.task-copy(-row)?\b/.test(selector)) && removesSpace(rule));
  expect(offenders.map(rule => rule.selectors.join(", "))).toEqual([]);
});

test.each([".task-item:hover .task-copy-row", ".task-item:focus-within .task-copy-row"])(
  "%s 时复制按钮出现并可点",
  selector => {
    expect(matching(selector, null).some(shown)).toBe(true);
  },
);

test("没有悬停能力的设备复制按钮常显", () => {
  expect(matching(".task-item .task-copy-row", "@media (hover: none)").some(shown)).toBe(true);
});

test("隐身只作用于列表行，详情页的复制按钮既不透明也不禁点", () => {
  const generic = rules.filter(rule => rule.selectors.some(selector => selector === ".task-copy-row" || selector === ".task-copy"));
  for (const rule of generic) {
    const label = rule.selectors.join(", ");
    expect(rule.decls.get("opacity"), `${label} 改了透明度`).toBeUndefined();
    expect(rule.decls.get("pointer-events"), `${label} 改了可点击性`).toBeUndefined();
  }
});
