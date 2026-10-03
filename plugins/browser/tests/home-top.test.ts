/**
 * 主页首屏不再自画与 App 名重复的大标题。
 *
 * 面包屑已经显示插件名「浏览器」，主页视图曾经再画一遍 `.rb-head`/`.rb-title`
 * 「内置浏览器」，两处标题叠在一起。这里守住去重后的结构不再回退。
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

describe("浏览器主页去重复页头", () => {
  const view = read("src/browser-view.ts");
  const style = read("src/browser.css");

  test("视图源码不再画重复标题", () => {
    expect(view).not.toContain("内置浏览器");
    expect(view).not.toContain("rb-title");
    expect(view).not.toContain("rb-head");
  });

  test(".rb-home 正文首容器顶部留白收紧到 12px", () => {
    const block = style.match(/\.rb-home\s*\{([^}]*)\}/s)?.[1];
    expect(block).toBeDefined();
    const paddingValue = block!.match(/(?:^|\s|;)padding\s*:\s*([^;]+);/)?.[1]?.trim();
    expect(paddingValue).toBeDefined();
    const top = Number.parseFloat(paddingValue!.split(/\s+/)[0]);
    expect(top).toBeLessThanOrEqual(12);
  });

  test("根安全区仍消费 Host 注入的标题栏安全线变量", () => {
    expect(style).toMatch(
      /\.plugin-main-frame\s*\{[^}]*padding-top\s*:\s*var\(--reai-plugin-titlebar-safe-top,\s*44px\)/s,
    );
  });
});
