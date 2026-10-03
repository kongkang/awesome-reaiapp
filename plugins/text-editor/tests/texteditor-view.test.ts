/**
 * 文本编辑器视图层单测 —— 结构与文案逐字对齐设计稿 #app/texteditor。
 *
 * 只建纯 DOM（happy-dom），不拉 ProseKit/CodeMirror；引擎接线由合同测试覆盖。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

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

import {
  buildDiffCardParts,
  buildFileSections,
  buildModeTabs,
  buildShell,
  buildStageEmpty,
  buildToolbar,
  fillStatus,
  hideToast,
  mountToolbar,
  setDocumentHeading,
  setModeVisibility,
  setSaveChip,
  showToast,
  type FileSection,
} from "../src/ui";
import {
  countChangedLines,
  diffLineOps,
  fileLanguage,
  isMarkdownPath,
} from "../src/util";
import { isTeMode } from "../src/mode";

const rowNames = (host: HTMLElement): string[] =>
  Array.from(host.querySelectorAll<HTMLElement>(".te-file-n")).map((el) => el.textContent ?? "");

const toolNames = (toolbar: HTMLElement): string[] =>
  Array.from(toolbar.querySelectorAll<HTMLButtonElement>("[data-te-tool]")).map(
    (button) => button.dataset.teTool ?? "",
  );

describe("文本编辑器文件栏", () => {
  test("头部：图标化的「文件」标题、打开按钮与「搜索文件…」占位符", () => {
    const refs = buildShell({ onOpen: () => {}, onSearchInput: () => {} });
    expect(refs.page.querySelector(".te-files-title")?.textContent).toContain("文件");
    expect(refs.openButton.getAttribute("title")).toBe("打开文件");
    expect(refs.openButton.getAttribute("aria-label")).toBe("打开文件");
    expect(refs.searchInput.placeholder).toBe("搜索文件…");
    expect(refs.searchInput.parentElement?.classList.contains("te-search")).toBe(true);
  });

  test("分组标题与行结构对齐设计稿（当前工作 / 文件夹 / 文件，icon + 名称 + meta）", () => {
    const sections: FileSection[] = [
      {
        heading: "文件夹",
        rows: [{ key: "work", name: "work", meta: "文件夹", kind: "directory" }],
      },
      {
        heading: "文件",
        rows: [
          {
            key: "docs/备忘录.md",
            name: "备忘录.md",
            meta: "Markdown · 6 处变更",
            kind: "file",
            active: true,
            changedDot: true,
          },
          { key: "plugin.json", name: "plugin.json", meta: "JSON · 1 KB", kind: "file" },
        ],
      },
    ];
    const fragment = buildFileSections(sections, "");
    const host = document.createElement("div");
    host.append(fragment);

    const headings = Array.from(host.querySelectorAll<HTMLElement>(".te-file-group")).map(
      (el) => el.textContent,
    );
    expect(headings).toEqual(["文件夹", "文件"]);

    const activeRow = host.querySelector<HTMLElement>(".te-file.active");
    expect(activeRow?.dataset.teFile).toBe("docs/备忘录.md");
    expect(activeRow?.querySelector(".te-file-dot")).not.toBeNull();
    const metas = Array.from(host.querySelectorAll<HTMLElement>(".te-file-m")).map(
      (el) => el.textContent,
    );
    expect(metas).toEqual(["文件夹", "Markdown · 6 处变更", "JSON · 1 KB"]);
    // 行名顺序：目录在前
    expect(rowNames(host)).toEqual(["work", "备忘录.md", "plugin.json"]);
  });

  test("搜索没有命中时显示设计稿空态「没有找到文件」", () => {
    const host = document.createElement("div");
    host.append(buildFileSections([], "没有找到文件"));
    expect(host.querySelector(".te-empty")?.textContent).toBe("没有找到文件");
  });

  test("无内容时的空态文案可以替换（例如引导授权）", () => {
    const host = document.createElement("div");
    host.append(buildFileSections([], "点击右上角的“＋”打开一个工作文件夹"));
    expect(host.querySelector(".te-empty")?.textContent).toBe("点击右上角的“＋”打开一个工作文件夹");
  });
});

describe("模式 tab（te-modes）", () => {
  test("三种模式逐字为「文档 / 源码 / 变更」，变更带计数徽标", () => {
    let selected = "";
    const tabs = buildModeTabs(
      [
        { mode: "document", label: "文档", disabled: false, badge: null },
        { mode: "source", label: "源码", disabled: false, badge: null },
        { mode: "diff", label: "变更", disabled: false, badge: 6 },
      ],
      "document",
      (mode) => {
        selected = mode;
      },
    );
    const buttons = Array.from(tabs.querySelectorAll<HTMLButtonElement>(".te-mode"));
    expect(buttons.map((button) => button.textContent)).toEqual(["文档", "源码", "变更6"]);
    expect(buttons[2]!.querySelector("b")?.textContent).toBe("6");
    expect(buttons[0]!.classList.contains("active")).toBe(true);
    expect(buttons[0]!.getAttribute("aria-selected")).toBe("true");
    expect(buttons[0]!.getAttribute("role")).toBe("tab");

    buttons[2]!.click();
    expect(selected).toBe("diff");
  });

  test("非 Markdown 时文档 tab 可被禁用", () => {
    const tabs = buildModeTabs(
      [{ mode: "document", label: "文档", disabled: true, badge: null }],
      "source",
      () => {},
    );
    expect(tabs.querySelector<HTMLButtonElement>(".te-mode")!.disabled).toBe(true);
  });

  test("mode 守卫只认三个白名单值", () => {
    expect(isTeMode("document")).toBe(true);
    expect(isTeMode("source")).toBe(true);
    expect(isTeMode("diff")).toBe(true);
    expect(isTeMode("preview")).toBe(false);
    expect(isTeMode(undefined)).toBe(false);
  });
});

describe("工具条（te-toolbar 随模式变化）", () => {
  test("文档模式：正文标签 + 撤销/重做/标题/粗体/斜体/列表/引用/代码 + 保存", () => {
    const toolbar = buildToolbar(
      {
        mode: "document",
        languageLabel: "",
        wrapActive: true,
        saveLabel: "保存",
        saveDisabled: false,
        changedCount: null,
      },
      { onTool: () => {}, onSave: () => {} },
    );
    expect(toolNames(toolbar.root)).toEqual([
      "撤销",
      "重做",
      "标题",
      "粗体",
      "斜体",
      "列表",
      "引用",
      "代码",
    ]);
    expect(toolbar.root.querySelector(".te-tool-label")?.textContent).toBe("正文");
    expect(toolbar.saveButton.textContent).toBe("保存");
    expect(toolbar.saveButton.disabled).toBe(false);
  });

  test("源码模式：语言标签、自动换行默认高亮、查找入口", () => {
    const toolbar = buildToolbar(
      {
        mode: "source",
        languageLabel: "Markdown",
        wrapActive: true,
        saveLabel: "已保存",
        saveDisabled: true,
        changedCount: null,
      },
      { onTool: () => {}, onSave: () => {} },
    );
    expect(toolNames(toolbar.root)).toEqual(["自动换行", "查找"]);
    expect(toolbar.root.querySelector(".te-tool-label")?.textContent).toBe("Markdown");
    expect(toolbar.wrapButton?.classList.contains("active")).toBe(true);
    expect(toolbar.saveButton.textContent).toBe("已保存");
    expect(toolbar.saveButton.disabled).toBe(true);
  });

  test("变更模式：「上次保存 → 当前内容」+ 上一处/下一处 + N 处变更", () => {
    const toolbar = buildToolbar(
      {
        mode: "diff",
        languageLabel: "",
        wrapActive: true,
        saveLabel: "保存",
        saveDisabled: false,
        changedCount: 4,
      },
      { onTool: () => {}, onSave: () => {} },
    );
    expect(toolNames(toolbar.root)).toEqual(["上一处", "下一处"]);
    const labels = Array.from(toolbar.root.querySelectorAll<HTMLElement>(".te-tool-label")).map(
      (el) => el.textContent,
    );
    expect(labels).toContain("上次保存 → 当前内容");
    expect(labels).toContain("4 处变更");
  });

  test("变更数未知显示「大量改动」，冲突时保存按钮变为「保留我的版本」", () => {
    const unknown = buildToolbar(
      {
        mode: "diff",
        languageLabel: "",
        wrapActive: true,
        saveLabel: "保存",
        saveDisabled: true,
        changedCount: null,
      },
      { onTool: () => {}, onSave: () => {} },
    );
    expect(Array.from(unknown.root.querySelectorAll<HTMLElement>(".te-tool-label")).map((el) => el.textContent)).toContain("大量改动");

    const conflict = buildToolbar(
      {
        mode: "document",
        languageLabel: "",
        wrapActive: true,
        saveLabel: "保留我的版本",
        saveDisabled: false,
        changedCount: null,
      },
      { onTool: () => {}, onSave: () => {} },
    );
    expect(conflict.saveButton.textContent).toBe("保留我的版本");
  });

  test("工具按钮把名字回传给回调", () => {
    const seen: string[] = [];
    const toolbar = buildToolbar(
      {
        mode: "document",
        languageLabel: "",
        wrapActive: true,
        saveLabel: "保存",
        saveDisabled: true,
        changedCount: null,
      },
      { onTool: (name) => seen.push(name), onSave: () => {} },
    );
    toolbar.root.querySelector<HTMLButtonElement>('[data-te-tool="粗体"]')!.click();
    expect(seen).toEqual(["粗体"]);
  });

  test("mountToolbar 复用壳层唯一工具栏，不嵌套第二个 te-toolbar", () => {
    const refs = buildShell({ onOpen: () => {}, onSearchInput: () => {} });
    const toolbar = buildToolbar(
      {
        mode: "source",
        languageLabel: "Markdown",
        wrapActive: true,
        saveLabel: "保存",
        saveDisabled: false,
        changedCount: null,
      },
      { onTool: () => {}, onSave: () => {} },
    );
    mountToolbar(refs.toolbarHost, toolbar);
    expect(refs.toolbarHost.querySelector(".te-toolbar")).toBeNull();
    expect(refs.page.querySelectorAll(".te-toolbar")).toHaveLength(1);
    expect(refs.toolbarHost.querySelector(".te-save")).toBe(toolbar.saveButton);
  });
});

describe("三视图显隐与状态栏", () => {
  test("setModeVisibility 只亮当前视图（其余挂 hidden）", () => {
    const refs = buildShell({ onOpen: () => {}, onSearchInput: () => {} });
    setModeVisibility(refs, "source");
    expect(refs.stageDocument.classList.contains("hidden")).toBe(true);
    expect(refs.stageSource.classList.contains("hidden")).toBe(false);
    expect(refs.stageDiff.classList.contains("hidden")).toBe(true);

    setModeVisibility(refs, "diff");
    expect(refs.stageDocument.classList.contains("hidden")).toBe(true);
    expect(refs.stageSource.classList.contains("hidden")).toBe(true);
    expect(refs.stageDiff.classList.contains("hidden")).toBe(false);
  });

  test("状态栏逐字：<语言><N 行><UTF-8><LF> + 视图角色文案", () => {
    const cases: Array<["document" | "source" | "diff", string]> = [
      ["document", "文档编辑"],
      ["source", "精确文本"],
      ["diff", "只读比较"],
    ];
    for (const [mode, word] of cases) {
      const status = document.createElement("footer");
      fillStatus(status, { kind: "document", language: "Markdown", lineCount: 18, mode });
      expect(status.querySelector("strong")?.textContent).toBe("Markdown");
      expect(status.textContent).toContain("18 行");
      expect(status.textContent).toContain("UTF-8");
      expect(status.textContent).toContain("LF");
      expect(status.textContent).toContain(word);
    }
  });

  test("未打开文件的状态栏保持待机文案", () => {
    const status = document.createElement("footer");
    fillStatus(status, { kind: "idle" });
    expect(status.textContent).toContain("文本编辑器");
    expect(status.textContent).toContain("本地文件工具");
  });
});

describe("保存状态徽标与文档头", () => {
  test("已保存 / 尚未保存 / 外部已修改 三态切换", () => {
    const refs = buildShell({ onOpen: () => {}, onSearchInput: () => {} });
    setSaveChip(refs, "saved");
    expect(refs.saveChipEl.textContent).toBe("已保存");
    expect(refs.saveChipEl.classList.contains("unsaved")).toBe(false);

    setSaveChip(refs, "unsaved");
    expect(refs.saveChipEl.textContent).toBe("尚未保存");
    expect(refs.saveChipEl.classList.contains("unsaved")).toBe(true);

    setSaveChip(refs, "conflict");
    expect(refs.saveChipEl.textContent).toBe("外部已修改");
  });

  test("未打开文件时清掉标题与路径行", () => {
    const refs = buildShell({ onOpen: () => {}, onSearchInput: () => {} });
    setDocumentHeading(refs, undefined);
    expect(refs.titleEl.textContent).toBe("");
    expect(refs.pathEl.textContent).toBe("");
    expect(refs.saveChipEl.classList.contains("hidden")).toBe(true);
  });

  test("路径与保存状态共享一行，状态文字不会被写进圆点", () => {
    const refs = buildShell({ onOpen: () => {}, onSearchInput: () => {} });
    setDocumentHeading(refs, { name: "备忘录.md", path: "work / docs / 备忘录.md" });
    setSaveChip(refs, "saved");

    expect(refs.saveChipEl.parentElement).toBe(refs.pathEl);
    expect(refs.pathEl.textContent).toContain("work / docs / 备忘录.md");
    expect(refs.saveChipEl.querySelector("i")?.textContent).toBe("");
    expect(refs.saveChipEl.textContent).toBe("已保存");

    setDocumentHeading(refs, undefined);
    expect(refs.pathEl.textContent).toBe("");
    expect(refs.saveChipEl.classList.contains("hidden")).toBe(true);
  });
});

describe("变更卡片头、主区空态与 toast", () => {
  test("变更头：文件名加粗 + 「逐行比较」", () => {
    const { head } = buildDiffCardParts("客户反馈决策备忘录.md");
    expect(head.querySelector("b")?.textContent).toBe("客户反馈决策备忘录.md");
    expect(head.textContent).toContain("逐行比较");
  });

  test("主区空态引导逐字沿用产品文案", () => {
    const empty = buildStageEmpty(() => {});
    expect(empty.querySelector("h2")?.textContent).toBe("打开一份本地文档");
    expect(empty.querySelector("p")?.textContent).toBe("选择工作文件夹，或从 Codex App 的文件变更中打开。");
  });

  test("toast 显隐走 show 类", () => {
    const refs = buildShell({ onOpen: () => {}, onSearchInput: () => {} });
    showToast(refs.toastEl, "已保存到原文件");
    expect(refs.toastEl.classList.contains("show")).toBe(true);
    expect(refs.toastEl.textContent).toBe("已保存到原文件");
    hideToast(refs.toastEl);
    expect(refs.toastEl.classList.contains("show")).toBe(false);
  });
});

describe("纯数据口径", () => {
  test("行级 LCS 的增删计数就是徽标的 N", () => {
    const base = ["# 标题", "", "旧的删除一行", "旧的另一行", ""].join("\n");
    const next = ["# 标题", "", "新增的一行", "", "尾部加行"].join("\n");
    const ops = diffLineOps(base, next)!;
    // 公共行 3（标题 + 两个空行），del 2 + add 2 ＝ 4
    expect(countChangedLines(ops)).toBe(4);
  });

  test("同一份内容计数为 0；超限返回 null（大量改动）", () => {
    expect(countChangedLines(diffLineOps("a\nb", "a\nb"))).toBe(0);
    expect(diffLineOps("\n".repeat(3000), "x")).toBeUndefined();
    expect(countChangedLines(undefined)).toBeNull();
  });

  test("语言识别驱动列表 meta 与状态栏 <strong>", () => {
    expect(fileLanguage("README.md")).toBe("Markdown");
    expect(fileLanguage("plugin.json")).toBe("JSON");
    expect(fileLanguage("main.ts")).toBe("TypeScript");
    expect(fileLanguage("notes.txt")).toBe("文本");
    expect(isMarkdownPath("a.MD")).toBe(true);
    expect(isMarkdownPath("a.markdown")).toBe(true);
    expect(isMarkdownPath("a.json")).toBe(false);
  });
});
