import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mountAgentsImView } from "../src/agents-im-view";

let ownsDomRegistration = false;

beforeAll(() => {
  if (typeof document === "undefined") {
    GlobalRegistrator.register();
    ownsDomRegistration = true;
  }
});

afterAll(() => {
  if (ownsDomRegistration) GlobalRegistrator.unregister();
});

beforeEach(() => document.body.replaceChildren());

describe("Agents · IM v17 design parity", () => {
  test("官方 surface 进入后直接打开置顶外脑，并使用设计稿列表文案", async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const view = await mountAgentsImView(root, { now: () => Date.parse("2026-08-12T08:00:30Z") });

    expect(root.querySelector('.ni-conversation-item[aria-current="true"]')?.textContent).toContain("外脑");
    expect(root.querySelector(".ni-conversation-title")?.textContent).toContain("外脑");
    expect((root.querySelector(".ni-conversation-search") as HTMLInputElement).placeholder).toBe("搜索 agent");
    expect(root.textContent).toContain("Claude Code");
    expect(root.textContent).toContain("邮箱助手");
    expect(root.textContent).toContain("AI Board 01 发布小组");
    expect(root.textContent).toContain("Codex");
    view.dispose();
  });

  test("官方插件隐藏协议品牌栏，Host 统一承担插件身份", () => {
    const css = readFileSync(join(import.meta.dir, "../src/agents-im.css"), "utf8");
    expect(css).toMatch(/\.ni-sidebar-header\s*\{[^}]*display:\s*none/s);
  });

  test("manifest 对外名称与设计稿一致，协议预览事实保留在说明而不是页面品牌", () => {
    const manifest = JSON.parse(readFileSync(join(import.meta.dir, "../app.manifest.json"), "utf8"));
    expect(manifest.name).toBe("Agents · IM");
    expect(manifest.contributes.sidebarItems[0].label).toBe("Agents · IM");
    expect(manifest.description).toContain("协议预览");
  });
});
