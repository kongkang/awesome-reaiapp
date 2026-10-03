import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const driverRoot = join(import.meta.dir, "..");
const read = (relative: string) => readFileSync(join(driverRoot, relative), "utf8");

describe("文本编辑器原生 Surface 合同", () => {
  test("manifest 只声明本地编辑能力，不依赖 Codex 或终端", () => {
    const manifest = JSON.parse(read("app.manifest.json"));
    expect(manifest.appId).toBe("com.reai.text-editor");
    const capabilities = manifest.requires.hostCapabilities as string[];
    expect(capabilities).toEqual(expect.arrayContaining([
      "surface.main@1",
      "titlebar.action@1",
      "apps.intent@1",
      "local.files@1",
      "storage.kv@1",
    ]));
    for (const forbidden of [
      "agent.codex@1",
      "agent.codex.tasks@1",
      "terminal@1",
      "network.fetch@1",
      "git.write@1",
    ]) expect(capabilities).not.toContain(forbidden);
    expect(manifest.data.privateStores).toEqual([
      { id: "text-editor-view-state", schemaVersion: 1 },
    ]);
  });

  test("三种视图由 ProseKit、CodeMirror 与 Merge 实现，不夹带 IDE 功能", () => {
    const pkg = JSON.parse(read("package.json"));
    expect(Object.keys(pkg.dependencies ?? {})).toEqual(
      expect.arrayContaining(["prosekit", "@codemirror/view", "@codemirror/merge"]),
    );
    const source = read("src/main.ts");
    for (const marker of [
      "ProseKit",
      "EditorView",
      "MergeView",
      "expectedRevision",
      "documentLoadGeneration",
      "modeChangeGeneration",
      "currentDoc !== document",
      "保留我的版本",
    ]) expect(source).toContain(marker);
    expect(source).not.toContain("terminal");
    expect(source).not.toContain("git commit");
  });

  test("主题只消费 Host 已解析 token，不再自行跟随系统主题", () => {
    const css = read("src/styles.css");
    expect(css).not.toContain("prefers-color-scheme");
    for (const hostToken of [
      "--bg:",
      "--panel-bg:",
      "--text-primary:",
      "--text-secondary:",
      "--text-tertiary:",
      "--accent:",
      "--divider:",
      "--warn:",
    ]) {
      expect(css).not.toContain(hostToken);
    }
  });

  test("根节点占满 WebView，并且只消费一次 Host 标题栏安全区", () => {
    const css = read("src/styles.css");
    const pageRule = css.match(/\.te-page\s*\{(?<body>[\s\S]*?)\}/)?.groups?.body ?? "";
    expect(pageRule).toMatch(/width\s*:\s*100%/);
    expect(pageRule).toMatch(/height\s*:\s*100%/);
    expect(pageRule).toMatch(/min-height\s*:\s*0/);
    expect(pageRule).toMatch(/box-sizing\s*:\s*border-box/);
    expect(pageRule).toMatch(
      /padding-top\s*:\s*var\(--reai-plugin-titlebar-safe-top,\s*44px\)/,
    );
    expect(css.match(/--reai-plugin-titlebar-safe-top/g)).toHaveLength(1);
  });

  test("语法色由 Host color-scheme 选择精确值，并为旧 WebKit 保留 Host token 回退", () => {
    const css = read("src/styles.css");
    expect(css).toContain("--te-syn-key: var(--accent)");
    expect(css).toContain("--te-syn-key: light-dark(#6b55bd, #a99bf5)");
    expect(css).toContain("--te-diff-add-ink: var(--bound)");
    expect(css).toContain("--te-diff-del-ink: var(--alert)");
  });

  test("运行时把工具栏内容移入既有宿主，不产生双层 te-toolbar", () => {
    const source = read("src/main.ts");
    expect(source).not.toContain("refs.toolbarHost.replaceChildren(toolbar.root)");
    expect(source).toContain("mountToolbar(refs.toolbarHost, toolbar)");
  });

  test("变更视图只在可见时启用 flex，不让 ID 选择器压过 hidden", () => {
    const css = read("src/styles.css");
    expect(css).not.toMatch(/#te-diff-view\s*\{\s*display:\s*flex/);
    expect(css).toMatch(/#te-diff-view:not\(\.hidden\)\s*\{\s*display:\s*flex/);
  });

  test("重建壳层时把仍生效的搜索词同步回输入框", () => {
    const source = read("src/main.ts");
    expect(source).toContain("shell.searchInput.value = searchQuery");
  });

  test("Surface 重新挂载时恢复上次的工作文件夹、子目录与文件", () => {
    const source = read("src/main.ts");
    const stateSource = read("src/view-state.ts");
    expect(source).toContain('ctx.storage.private("text-editor-view-state")');
    expect(source).toContain("loadTextEditorViewState");
    expect(source).toContain("createTextEditorViewStateWriter");
    expect(source).toContain("restoreViewState");
    expect(source).toContain(
      "wrapCompartment.of(wrapOn ? EditorView.lineWrapping : [])",
    );
    expect(stateSource).toContain("saveTextEditorViewState");
    expect(stateSource).not.toMatch(/\b(localStorage|sessionStorage|indexedDB)\b/);
  });
});
