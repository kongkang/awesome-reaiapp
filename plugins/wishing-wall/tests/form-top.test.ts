/**
 * 左栏表单顶部不再自画与 App 名重复的大标题。
 *
 * 面包屑已经显示插件名「AI许愿墙」，表单顶部曾经再画一遍 `.ww-form-title`
 * 「AI许愿墙」文字，两处标题叠在一起。这里守住去重后的结构不再回退。
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

describe("许愿墙表单去重复页头", () => {
  const view = read("src/wishing-wall-view.ts");
  const style = read("src/wishing-wall.css");

  test("视图源码中标题元素不再带文本", () => {
    expect(view).not.toMatch(/"ww-form-title",\s*"/);
    expect(view).not.toContain('"AI许愿墙")');
  });

  test(".ww-form-top 正文首容器顶部留白收紧到 12px 以内", () => {
    const block = style.match(/\.ww-form-top\s*\{([^}]*)\}/s)?.[1];
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
