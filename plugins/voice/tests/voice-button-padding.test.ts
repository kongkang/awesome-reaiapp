/**
 * 设计规范 §3.5「按钮四周都要留白」（#button-padding）与 §6.0 文案底线的静态守卫。
 * 仓库还没有通用的 §3.5 合同测试，Voice 先在自己的测试里守住：
 * - 五个刻意纯文字的按钮必须在样式旁注明 §3.5 例外，且悬停 / 按下都不能铺底色（铺了就不再是例外）；
 * - 新增的「查看诊断」有悬停底色，四周留白不得低于紧凑档（左右 ≥ 4px、上下 ≥ 2px）；
 * - 等待 / 失败文案不得再出现「较长时间」「请稍候」「请稍等」这类空话。
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

const EXCEPTIONS: Array<[file: string, className: string]> = [
  ["src/voice.css", "voice-cap-action"],
  ["src/voice.css", "voice-warn-go"],
  ["src/voice.css", "ctx-tab"],
  ["src/voice.css", "ctx-empty-fold-title"],
  ["packages/chat-ui/src/chat-ui.css", "chat-status-toggle"],
];

/** 顶层规则（含注释剥离后的选择器与声明）。@media 里的规则也拆出来。 */
function rules(css: string): Array<{ selector: string; body: string }> {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: Array<{ selector: string; body: string }> = [];
  const pattern = /([^{}]+)\{([^{}]*)\}/g;
  for (let match = pattern.exec(stripped); match; match = pattern.exec(stripped)) {
    out.push({ selector: match[1]!.replace(/@media[^{]*$/, "").trim(), body: match[2]! });
  }
  return out;
}

test.each(EXCEPTIONS)("%s .%s 注明了 §3.5 例外", (file, className) => {
  const css = read(file);
  const first = css.search(new RegExp(`(^|\\n|\\})\\s*\\.${className}\\s*\\{`));
  expect(first, `${className} 的基础规则不存在`).toBeGreaterThanOrEqual(0);
  const before = css.slice(Math.max(0, first - 500), first + 2);
  const comment = before.slice(before.lastIndexOf("/*"));
  expect(comment, `${className} 前面没有 §3.5 注明`).toContain("§3.5");
  expect(comment).toContain("刻意");
});

test.each(EXCEPTIONS)("%s .%s 悬停 / 按下不铺底色（铺了就必须补四周留白）", (file, className) => {
  const interactive = new RegExp(`\\.${className}(?:\\[[^\\]]*\\])?:(hover|active)`);
  for (const rule of rules(read(file))) {
    if (!interactive.test(rule.selector)) continue;
    // background / background-color / background-image（渐变铺底）都算铺底色。
    expect(rule.body, `${rule.selector} 铺了底色`).not.toMatch(/background[a-z-]*\s*:/);
  }
});

test("「查看诊断」有悬停底色，四周留白不低于 §3.5 紧凑档", () => {
  const css = read("src/voice.css");
  const base = rules(css).find((rule) => rule.selector === ".voice-diag-toggle")!;
  const hover = rules(css).find((rule) => rule.selector === ".voice-diag-toggle:hover")!;
  expect(hover.body).toMatch(/background\s*:/);
  const padding = /padding:\s*(\d+)px\s+(\d+)px\s*;/.exec(base.body);
  expect(padding).not.toBeNull();
  expect(Number(padding![1])).toBeGreaterThanOrEqual(2);
  expect(Number(padding![2])).toBeGreaterThanOrEqual(4);
});

test("等待 / 失败文案不再写空话（§6.0 与负责人底线）", () => {
  const zh = read("assets/locales/zh.json");
  const en = read("assets/locales/en.json");
  for (const banned of ["较长时间", "请稍候", "请稍等", "出错了"]) expect(zh).not.toContain(banned);
  for (const banned of [/after a long wait/i, /please wait/i]) expect(en).not.toMatch(banned);
});
