/**
 * Podcast 语言资源与适配模块测试。
 *
 * 资源唯一来源是 assets/locales/{zh,en}.json；本文件验证键/插值一致性、
 * 未知语言回退、重复通知幂等与绑定生命周期。DOM 回归见 podcast-view.test.ts。
 */
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

import en from "../assets/locales/en.json";
import zh from "../assets/locales/zh.json";
import {
  bindAttribute,
  bindText,
  onPodcastLocaleChange,
  releaseLocaleBindings,
  setPodcastLocale,
  t,
} from "../src/podcast-i18n";

beforeAll(() => {
  if (typeof document === "undefined") GlobalRegistrator.register();
});
afterEach(() => {
  releaseLocaleBindings(document.body);
  document.body.replaceChildren();
  setPodcastLocale("zh");
});

function flatten(value: Record<string, unknown>, prefix = ""): Record<string, string> {
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, item]) =>
      typeof item === "string"
        ? [[prefix + key, item]]
        : Object.entries(flatten(item as Record<string, unknown>, prefix + key + ".")),
    ),
  );
}

function variables(message: string): string[] {
  return [...new Set(message.match(/\{[A-Za-z][A-Za-z0-9_]*\}/g) ?? [])].sort();
}

describe("Podcast 语言资源", () => {
  test("中英文键路径一致、叶子非空、插值变量集合一致", () => {
    const z = flatten(zh);
    const e = flatten(en);
    expect(Object.keys(z).sort()).toEqual(Object.keys(e).sort());
    for (const key of Object.keys(z)) {
      expect(z[key]!.trim().length).toBeGreaterThan(0);
      expect(e[key]!.trim().length).toBeGreaterThan(0);
      expect(variables(z[key]!)).toEqual(variables(e[key]!));
    }
  });

  test("manifest 元数据键覆盖 name/description/侧栏/标题栏/商店 listing", () => {
    const z = flatten(zh);
    for (const key of [
      "metadata.name",
      "metadata.description",
      "metadata.sidebar.podcast.label",
      "metadata.surfaces.main.title",
      "metadata.actions.history.label",
      "metadata.actions.history.text",
      "metadataV2.category",
      "metadataV2.tagline",
      "metadataV2.longDescription",
      "metadataV2.capability0Label",
      "metadataV2.capability0Detail",
      "metadataV2.capability1Label",
      "metadataV2.capability1Detail",
      "metadataV2.capability2Label",
      "metadataV2.capability2Detail",
      "metadataV2.caption0",
      "metadataV2.caption1",
    ]) {
      expect(z[key]).toBeDefined();
    }
  });

  test("标题栏动作译文满足合同码点上限（label 48 / text 12）", () => {
    for (const table of [zh, en]) {
      const label = (table as Record<string, any>).metadata.actions.history.label as string;
      const text = (table as Record<string, any>).metadata.actions.history.text as string;
      expect([...label].length).toBeLessThanOrEqual(48);
      expect([...text].length).toBeLessThanOrEqual(12);
    }
  });
});

describe("Podcast i18n 运行时", () => {
  test("未知语言回退英文，插值参数按普通文本输出", () => {
    setPodcastLocale("ja");
    expect(t("view.drawerTitle")).toBe("Episodes");
    expect(
      t("view.tbcAria", { title: "<b>danger</b>" }),
    ).toBe("TBC: <b>danger</b>");
    expect(
      t("view.episodeSources", { sources: "{date}" }),
    ).toBe("{date} sources");
  });

  test("重复设置同一语言是幂等的：监听与绑定都不再触发", () => {
    let changes = 0;
    const stop = onPodcastLocaleChange(() => changes++);
    const node = document.createElement("div");
    document.body.append(node);
    let updates = 0;
    bindText(node, () => {
      updates++;
      return t("view.notesKicker");
    });
    setPodcastLocale("en");
    setPodcastLocale("en");
    setPodcastLocale("en");
    expect(changes).toBe(1);
    expect(updates).toBe(2);
    stop();
  });

  test("bindText/bindAttribute 原地更新且保留后追加的子节点", () => {
    const button = document.createElement("button");
    bindAttribute(button, "aria-label", () => t("view.play"));
    bindText(button, () => t("view.play"));
    const icon = document.createElement("span");
    icon.textContent = "icon";
    button.append(icon);
    document.body.append(button);
    setPodcastLocale("en");
    expect(button.getAttribute("aria-label")).toBe("Play");
    expect(button.contains(icon)).toBe(true);
    expect(button.textContent).toBe("Playicon");
    setPodcastLocale("zh");
    expect(button.getAttribute("aria-label")).toBe("播放");
    expect(button.textContent).toBe("播放icon");
  });

  test("releaseLocaleBindings 后节点不再跟随语言", () => {
    const node = document.createElement("div");
    bindText(node, () => t("view.notesKicker"));
    document.body.append(node);
    releaseLocaleBindings(node);
    setPodcastLocale("en");
    expect(node.textContent).toBe("本期提要");
  });

  test("缺键回退英文，英文也缺时告警并显示键名用于定位", () => {
    setPodcastLocale("zh");
    expect(t("view.doesNotExist")).toBe("view.doesNotExist");
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (message: unknown) => {
      warnings.push(String(message));
    };
    try {
      t("view.doesNotExist");
    } finally {
      console.warn = originalWarn;
    }
    expect(warnings.some((message) => message.includes("view.doesNotExist"))).toBe(true);
  });

  test("单个绑定抛错不影响其他绑定与监听", () => {
    const bad = document.createElement("span");
    const good = document.createElement("span");
    let fail = false;
    bindText(bad, () => {
      if (fail) throw new Error("boom");
      return "ok";
    });
    bindText(good, () => t("view.notesKicker"));
    document.body.append(bad, good);
    fail = true;
    expect(() => setPodcastLocale("en")).not.toThrow();
    expect(bad.textContent).toBe("ok");
    expect(good.textContent).toBe("Show notes");
  });
});
