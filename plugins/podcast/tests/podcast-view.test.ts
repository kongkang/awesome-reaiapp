/**
 * Podcast 视图 DOM 回归：双语首屏、zh→en→zh 原地切换、未知语言回退、
 * 播放状态与进度连续（受控时钟）、多实例独立与销毁释放。全程无真实音频。
 */
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

import { mountPodcastView, type PodcastView } from "../src/podcast-view";
import { podcastLocale, releaseLocaleBindings, setPodcastLocale } from "../src/podcast-i18n";

beforeAll(() => {
  if (typeof document === "undefined") GlobalRegistrator.register();
});
afterEach(() => {
  releaseLocaleBindings(document.body);
  document.body.replaceChildren();
  setPodcastLocale("zh");
});

/** 受控时钟：接管全局 setInterval/clearInterval，手动推进并统计 timer 数量。 */
function installControlledClock() {
  const real = {
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
  };
  const active = new Map<number, () => void>();
  let created = 0;
  let nextId = 1;
  globalThis.setInterval = ((handler: () => void) => {
    const id = nextId++;
    created++;
    active.set(id, handler);
    return id;
  }) as typeof setInterval;
  globalThis.clearInterval = ((id: number) => {
    active.delete(id);
  }) as typeof clearInterval;
  return {
    created: () => created,
    active: () => active.size,
    tick(times = 1) {
      for (let i = 0; i < times; i++) {
        for (const handler of [...active.values()]) handler();
      }
    },
    restore() {
      globalThis.setInterval = real.setInterval;
      globalThis.clearInterval = real.clearInterval;
    },
  };
}

function mount(): { root: HTMLElement; view: PodcastView } {
  const root = document.createElement("div");
  document.body.append(root);
  const view = mountPodcastView(root);
  return { root, view };
}

// 中文残留扫描含全角标点区（U+3000–303F、U+FF00–FFEF）；happy-dom 无真实布局，
// scrollTop 断言只能证明容器节点未重建，真实滚动保留留给签名 Host 手测。
const CHINESE = /[\u3000-\u303f\u3400-\u9fff\uff00-\uffef]+/g;

function attrText(root: HTMLElement): string {
  return Array.from(root.querySelectorAll("*"))
    .flatMap((node) => ["title", "aria-label", "placeholder"].map((attr) => node.getAttribute(attr) ?? ""))
    .join("\n");
}

/** 节点身份断言：逐元素引用相等（toEqual 是深比较，对结构相同的新节点会假阳性）。 */
function expectSameNodes(actual: Element[], expected: Element[]): void {
  expect(actual.length).toBe(expected.length);
  for (const [i, node] of actual.entries()) {
    expect(node).toBe(expected[i]);
  }
}

describe("Podcast 视图语言", () => {
  test("中文冷启动：首屏即中文，含 aria/title 与 TBC 说明", () => {
    setPodcastLocale("zh");
    const { root, view } = mount();
    expect(root.querySelector(".pod-notes-kicker")?.textContent).toBe("本期提要");
    expect(root.querySelector(".pod-notes-title")?.textContent).toBe("今天值得继续听的三条线索");
    expect(root.querySelector(".pod-drawer-title")?.textContent?.startsWith("往期节目")).toBe(true);
    const play = root.querySelector<HTMLButtonElement>(".pod-play")!;
    expect(play.getAttribute("aria-label")).toBe("播放");
    expect(play.title).toBe("播放");
    const prev = root.querySelector<HTMLButtonElement>(".pod-btn")!;
    expect(prev.getAttribute("aria-label")).toBe("上一集");
    expect(prev.title).toBe("上一集");
    const titles = Array.from(root.querySelectorAll<HTMLButtonElement>(".pod-btn")).map(
      (button) => button.title,
    );
    expect(titles).toEqual(["上一集", "后退 15 秒", "前进 15 秒", "下一集"]);
    const allText = (root.textContent ?? "") + attrText(root);
    expect(allText).toMatch(/本期提要/);
    expect(allText.match(/\b(view|tbc)\.[a-zA-Z]/)).toBeNull();
    const bar = root.querySelector('[role="slider"]')!;
    expect(bar.getAttribute("aria-label")).toBe("播放进度");
    const tag = root.querySelector<HTMLElement>('[data-tbc-id="tbc.podcast-content"]')!;
    expect(tag.getAttribute("aria-label")).toBe("TBC：节目内容来自静态演示数据");
    // 节目标题是内容数据：中文界面同样保留原文，不被批量翻译。
    expect(root.querySelector(".pod-title")?.textContent).toContain("Today's Briefing");
    expect(root.querySelector(".pod-meta")?.textContent).toBe("Jul 27, 2026 · 6 个来源 · 12 分钟");
    view.dispose();
  });

  test("英文冷启动：首屏直接英文，可见文案与无障碍属性无中文", () => {
    setPodcastLocale("en");
    const { root, view } = mount();
    const visible = root.textContent ?? "";
    expect(visible.match(CHINESE)).toBeNull();
    expect(root.querySelector(".pod-notes-kicker")?.textContent).toBe("Show notes");
    expect(root.querySelector(".pod-drawer-title")?.textContent?.startsWith("Episodes")).toBe(true);
    expect(root.querySelector(".pod-meta")?.textContent).toBe("Jul 27, 2026 · 6 sources · 12 min");
    const play = root.querySelector<HTMLButtonElement>(".pod-play")!;
    expect(play.getAttribute("aria-label")).toBe("Play");
    const enTitles = Array.from(root.querySelectorAll<HTMLButtonElement>(".pod-btn")).map(
      (button) => button.title,
    );
    expect(enTitles).toEqual(["Previous episode", "Back 15 seconds", "Forward 15 seconds", "Next episode"]);
    const tag = root.querySelector<HTMLElement>('[data-tbc-id="tbc.podcast-content"]')!;
    expect(tag.getAttribute("aria-label")).toBe("TBC: Episode content comes from static demo data");
    for (const node of Array.from(root.querySelectorAll("[aria-label],[title],[placeholder]"))) {
      for (const attr of ["aria-label", "title", "placeholder"]) {
        expect(node.getAttribute(attr)?.match(CHINESE) ?? null).toBeNull();
      }
    }
    // 无裸键：缺键回退会显示 "view.xxx" / "tbc.xxx" 字面量。
    expect((visible + attrText(root)).match(/\b(view|tbc)\.[a-zA-Z]/)).toBeNull();
    view.dispose();
  });

  test("zh→en→zh：原地更新，节点、滚动、抽屉、播放状态与进度全保留", () => {
    const clock = installControlledClock();
    try {
      setPodcastLocale("zh");
      const { root, view } = mount();
      view.toggleHistory(true);
      expect(root.querySelector(".pod-drawer")?.classList.contains("open")).toBe(true);
      const body = root.querySelector<HTMLElement>(".main-body")!;
      body.scrollTop = 137;
      const play = root.querySelector<HTMLButtonElement>(".pod-play")!;
      const bar = root.querySelector('[role="slider"]')!;
      const rowsBefore = Array.from(root.querySelectorAll(".pod-ep"));
      const playTbcBefore = play.querySelector("[data-tbc-id]")!;
      const titleTbcBefore = root.querySelector(".pod-title [data-tbc-id]")!;
      const titleTextBefore = root.querySelector(".pod-title")?.firstChild;
      const metaTextBefore = root.querySelector(".pod-meta")?.firstChild;
      play.click();
      clock.tick(3);
      expect(bar.getAttribute("aria-valuenow")).toBe("255");
      expect(play.getAttribute("aria-label")).toBe("暂停");
      // 播放 tick 不重建剧集行、TBC/标题节点与持久化文本节点。
      expectSameNodes(Array.from(root.querySelectorAll(".pod-ep")), rowsBefore);
      expect(play.querySelector("[data-tbc-id]")).toBe(playTbcBefore);
      expect(root.querySelector(".pod-title [data-tbc-id]")).toBe(titleTbcBefore);
      expect(root.querySelector(".pod-title")?.firstChild).toBe(titleTextBefore);
      expect(root.querySelector(".pod-meta")?.firstChild).toBe(metaTextBefore);

      const kickerBefore = root.querySelector(".pod-notes-kicker")!;
      setPodcastLocale("en");
      expect(podcastLocale()).toBe("en");
      expect(root.querySelector(".pod-notes-kicker")).toBe(kickerBefore);
      expect(kickerBefore.textContent).toBe("Show notes");
      expect(root.querySelector(".pod-drawer")?.classList.contains("open")).toBe(true);
      expect(body.scrollTop).toBe(137);
      expect(root.querySelector(".pod-play")).toBe(play);
      expect(play.getAttribute("aria-label")).toBe("Pause");
      expect(root.querySelector(".pod-meta")?.textContent).toBe("Jul 27, 2026 · 6 sources · 12 min");
      const episodeMeta = root.querySelector(".pod-ep-meta")?.textContent ?? "";
      expect(episodeMeta.startsWith("Jul 27 · 12 min · Playing")).toBe(true);
      // 切语言不重建剧集行、播放按钮 TBC、集标题 TBC、持久化文本节点——同一批节点只改文字/属性。
      expectSameNodes(Array.from(root.querySelectorAll(".pod-ep")), rowsBefore);
      expect(play.querySelector("[data-tbc-id]")).toBe(playTbcBefore);
      expect(playTbcBefore.getAttribute("aria-label"))
        .toBe("TBC: Playback controls only advance the demo progress; no audio is played");
      expect(root.querySelector(".pod-title [data-tbc-id]")).toBe(titleTbcBefore);
      expect(titleTbcBefore.getAttribute("aria-label"))
        .toBe("TBC: Episode content comes from static demo data");
      expect(root.querySelector(".pod-meta")?.firstChild).toBe(metaTextBefore);

      setPodcastLocale("zh");
      expect(kickerBefore.textContent).toBe("本期提要");
      expect(play.getAttribute("aria-label")).toBe("暂停");
      expect(root.querySelector(".pod-meta")?.textContent).toBe("Jul 27, 2026 · 6 个来源 · 12 分钟");
      expect((root.querySelector(".pod-ep-meta")?.textContent ?? "").endsWith("播放中")).toBe(true);
      expectSameNodes(Array.from(root.querySelectorAll(".pod-ep")), rowsBefore);

      // 切语言全程不新建 timer；进度在原有 timer 上继续推进。
      expect(clock.created()).toBe(1);
      clock.tick(1);
      expect(bar.getAttribute("aria-valuenow")).toBe("256");
      expect(clock.created()).toBe(1);
      expect(clock.active()).toBe(1);
      expectSameNodes(Array.from(root.querySelectorAll(".pod-ep")), rowsBefore);

      play.click();
      expect(clock.active()).toBe(0);
      view.dispose();
    } finally {
      clock.restore();
    }
  });

  test("切集与播放/暂停切换复用同一批行/图标/TBC 节点", () => {
    const clock = installControlledClock();
    try {
      setPodcastLocale("zh");
      const { root, view } = mount();
      const rows = Array.from(root.querySelectorAll(".pod-ep"));
      const play = root.querySelector<HTMLButtonElement>(".pod-play")!;
      const playTbc = play.querySelector("[data-tbc-id]")!;
      const playSvg = play.querySelector("svg")!;

      // 播放：图标换成持久 pause 节点；再暂停：换回同一个 play 节点。
      play.click();
      const pauseSvg = play.querySelector("svg")!;
      expect(pauseSvg).not.toBe(playSvg);
      clock.tick(1);
      expect(play.querySelector("svg")).toBe(pauseSvg);
      play.click();
      expect(play.querySelector("svg")).toBe(playSvg);
      // 再播一次仍是同一个 pause 节点（多轮切换复用）。
      play.click();
      expect(play.querySelector("svg")).toBe(pauseSvg);
      play.click();
      expectSameNodes(Array.from(root.querySelectorAll(".pod-ep")), rows);
      expect(play.querySelector("[data-tbc-id]")).toBe(playTbc);
      expect(play.querySelector("svg")).toBe(playSvg);

      // 点第二行切集（抽屉行点击路径）：行身份不变，active 与文案迁移。
      (rows[1] as HTMLElement).click();
      expectSameNodes(Array.from(root.querySelectorAll(".pod-ep")), rows);
      expect(rows[1]!.classList.contains("active")).toBe(true);
      expect(root.querySelector(".pod-title")?.textContent?.startsWith("Saturday Digest")).toBe(true);
      expect(root.querySelector(".pod-ep.active .pod-ep-title")?.textContent).toBe("Saturday Digest");
      view.dispose();
    } finally {
      clock.restore();
    }
  });

  test("未知语言回退英文渲染", () => {
    setPodcastLocale("ja");
    const { root, view } = mount();
    expect(root.querySelector(".pod-notes-kicker")?.textContent).toBe("Show notes");
    expect(podcastLocale()).toBe("en");
    view.dispose();
  });

  test("重复语言通知不产生额外渲染副作用，抽屉关闭动作在切语言后仍有效", () => {
    setPodcastLocale("zh");
    const { root, view } = mount();
    view.toggleHistory(true);
    setPodcastLocale("en");
    setPodcastLocale("en");
    setPodcastLocale("en");
    const close = root.querySelector<HTMLButtonElement>(".pod-drawer-close")!;
    expect(close.getAttribute("aria-label")).toBe("Close episode list");
    close.click();
    expect(root.querySelector(".pod-drawer")?.classList.contains("open")).toBe(false);
    view.toggleHistory(true);
    expect(root.querySelector(".pod-drawer")?.classList.contains("open")).toBe(true);
    view.dispose();
  });

  test("多实例：各自跟随语言，销毁后释放绑定与 timer，不影响存活实例", () => {
    const clock = installControlledClock();
    try {
      setPodcastLocale("zh");
      const first = mount();
      const second = mount();
      first.view.toggleHistory(true);
      first.root.querySelector<HTMLButtonElement>(".pod-play")!.click();
      expect(clock.active()).toBe(1);

      setPodcastLocale("en");
      expect(first.root.querySelector(".pod-notes-kicker")?.textContent).toBe("Show notes");
      expect(second.root.querySelector(".pod-notes-kicker")?.textContent).toBe("Show notes");

      const firstPrev = first.root.querySelector<HTMLButtonElement>(".pod-btn")!;
      first.view.dispose();
      expect(first.root.textContent).toBe("");
      expect(clock.active()).toBe(0);
      expect(clock.created()).toBe(1);

      setPodcastLocale("zh");
      // 已销毁实例的节点已清空、绑定已释放：不再有任何语言驱动更新。
      expect(first.root.querySelector(".pod-notes-kicker")).toBeNull();
      expect(firstPrev.getAttribute("aria-label")).toBe("Previous episode");
      expect(second.root.querySelector(".pod-notes-kicker")?.textContent).toBe("本期提要");
      second.view.dispose();
      expect(second.root.textContent).toBe("");
    } finally {
      clock.restore();
    }
  });
});
