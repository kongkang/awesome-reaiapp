/**
 * 首屏不再自画与 App 名重复的大标题。
 *
 * 面包屑已经显示插件名「设备诊断助手」，页头曾经再画一遍 h1「设备诊断助手」，
 * 两处标题叠在一起。这里守住去重后的一行式页头结构不再回退。
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

describe("设备诊断助手首屏去重复页头", () => {
  const view = read("src/doctor-view.ts");
  const style = read("src/doctor.css");

  test("视图源码不再创建重复标题 h1", () => {
    expect(view).not.toContain('textContent = "设备诊断助手"');
    expect(view).not.toContain('element("h1"');
    expect(view).not.toContain("device-doctor-title\"");
  });

  test(".device-doctor-pill 仍能被找到，且与说明句同在一行", () => {
    expect(view).toContain("device-doctor-pill");
    expect(view).toContain("noteRow.append(note, pillHost)");
  });

  test(".device-doctor-header 正文首容器顶部留白收紧到 12px", () => {
    const block = style.match(/\.device-doctor-header\s*\{([^}]*)\}/s)?.[1];
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
