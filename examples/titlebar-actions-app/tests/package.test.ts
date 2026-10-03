import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const manifest = JSON.parse(readFileSync(join(root, "app.manifest.json"), "utf8"));
const source = readFileSync(join(root, "src/app.ts"), "utf8");

describe("titlebar actions example package", () => {
  test("keeps the declared titlebar action wired to a visible Surface state", () => {
    expect(manifest).toMatchObject({
      appId: "com.example.titlebar-actions-demo",
      version: "1.0.2",
      requires: {
        hostCapabilities: expect.arrayContaining(["surface.main@1", "titlebar.action@1"]),
      },
    });
    expect(manifest.contributes.titlebarActions).toHaveLength(1);
    expect(source).toContain("host.titlebarAction");
    expect(source).toContain("dataset.titlebarDemoStatus");
  });

  test("正文首容器不再自画与 App 名重复的大标题", () => {
    // 面包屑已经显示插件名，src/app.ts 曾经再画一遍 h1「Titlebar Actions Demo」，
    // 两处标题叠在一起（plugin-design-system-v1 §4.5/§4.6）。
    expect(source).not.toContain('textContent = "Titlebar Actions Demo"');
    expect(source).toContain("padding:12px 40px 40px");
  });
});
