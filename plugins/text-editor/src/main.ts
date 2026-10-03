/**
 * 文本编辑器（com.reai.text-editor）—— 本地 Markdown / 源码 / 变更三视图。
 *
 * 视图壳对齐设计稿 design/VoiceType_UI_Designs.html #app/texteditor：
 * ProseKit 富文本纸张、CodeMirror 源码、CodeMirror Merge 双栏变更共用同一个
 * te-page 外壳；文件访问只经 local.files@1 的 Host Broker（授权工作文件夹或
 * 短时 handoff），不存在任何路径自授权。
 */
import { defaultKeymap, history, historyKeymap, redo, undo } from "@codemirror/commands";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { syntaxHighlighting, defaultHighlightStyle, type LanguageSupport } from "@codemirror/language";
import { MergeView } from "@codemirror/merge";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { defineApp, type AppContext, type HostTitlebarActionIntent, type LocalTextDocument, type LocalWorkspace, type SurfaceHandle } from "@reai/app-sdk/v1";
import { createEditor, defineDocChangeHandler, union, type Editor } from "prosekit/core";
import { defineBasicExtension } from "prosekit/basic";
import rehypeParse from "rehype-parse";
import rehypeRemark from "rehype-remark";
import rehypeStringify from "rehype-stringify";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import remarkStringify from "remark-stringify";
import { unified } from "unified";
import "./styles.css";

import { countChangedLines, diffLineOps, changedLineNumbersOnNext, fileLanguage, humanSize, isMarkdownPath, type LineDiffOp } from "./util";
import { isTeMode, type TeMode } from "./mode";
import {
  createTextEditorViewStateWriter,
  loadTextEditorViewState,
  restoreTextEditorViewState,
} from "./view-state";
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
  type FileRow,
  type FileSection,
  type SaveState,
  type ShellRefs,
  type ToolName,
} from "./ui";

/** open-document / view-diff 的输入：token 必带，mode 是可选的初始视图（与 Codex App 面板概念对齐）。 */
type EditorIntent =
  | (HostTitlebarActionIntent<{ type: "pick-workspace" }>)
  | { token?: string; mode?: TeMode; type?: "pick-workspace" };

interface OpenDocument extends LocalTextDocument {
  baseContent: string;
  dirty: boolean;
  conflict: boolean;
}

async function markdownToHtml(value: string): Promise<string> {
  return String(
    await unified()
      .use(remarkParse)
      .use(remarkGfm)
      .use(remarkRehype)
      .use(rehypeStringify)
      .process(value),
  );
}

async function htmlToMarkdown(value: string): Promise<string> {
  return String(
    await unified()
      .use(rehypeParse, { fragment: true })
      .use(rehypeRemark)
      .use(remarkGfm)
      .use(remarkStringify, { bullet: "-", fences: true })
      .process(value),
  );
}

function languageFor(path: string): LanguageSupport | undefined {
  if (isMarkdownPath(path)) return markdown();
  if (/\.jsonc?$/i.test(path)) return json();
  if (/\.(?:[cm]?js|jsx|ts|tsx)$/i.test(path)) {
    return javascript({ jsx: /x$/i.test(path), typescript: /\.(?:ts|tsx)$/i.test(path) });
  }
  return undefined;
}

function intentPayload(value: unknown): { token?: string; mode?: TeMode; pickWorkspace: boolean } {
  if (!value || typeof value !== "object") return { pickWorkspace: false };
  const row = value as Record<string, unknown>;
  if (row.source === "host.titlebarAction") {
    const payload = row.payload as Record<string, unknown> | undefined;
    return { pickWorkspace: payload?.type === "pick-workspace" };
  }
  return {
    ...(typeof row.token === "string" ? { token: row.token } : {}),
    ...(!isTeMode(row.mode) ? {} : { mode: row.mode }),
    pickWorkspace: row.type === "pick-workspace",
  };
}

/** 富文本工具条动作 → ProseKit basic 扩展的同名义命令。 */
const DOCUMENT_TOOL_COMMANDS: Partial<Record<ToolName, string>> = {
  标题: "toggleHeading",
  粗体: "toggleBold",
  斜体: "toggleItalic",
  列表: "toggleBulletList",
  引用: "toggleBlockquote",
  代码: "toggleCodeBlock",
};

interface ListingModel {
  sections: FileSection[];
  handlers: Map<string, () => void>;
  /** 无命中/无内容时列表区显示的空态文案。 */
  emptyText: string;
  truncated: boolean;
}

function mountTextEditor(ctx: AppContext, surface: SurfaceHandle<EditorIntent>) {
  let disposed = false;
  let workspaces: LocalWorkspace[] = [];
  let selectedWorkspaceId = "";
  let directory = "";
  let currentDoc: OpenDocument | undefined;
  let mode: TeMode = "document";
  let proseEditor: Editor | undefined;
  let sourceView: EditorView | undefined;
  let mergeView: MergeView | undefined;
  let editorGeneration = 0;
  let documentLoadGeneration = 0;
  let modeChangeGeneration = 0;
  /** 当前文档相对上次保存的增删行数；null 表示超出可算范围（大量改动）。 */
  let changedCount: number | null = null;
  let mergeNavLines: number[] = [];
  let searchQuery = "";
  const wrapCompartment = new Compartment();
  let wrapOn = true;
  const viewStateStore = ctx.storage.private("text-editor-view-state");
  const viewStateWriter = createTextEditorViewStateWriter(viewStateStore);

  const surfaceRoot = surface.root;

  let refs: ShellRefs | undefined;
  let diffCountTimer: ReturnType<typeof setTimeout> | undefined;

  function report(cause: unknown) {
    surface.reportError(new Error("文本编辑器操作失败", { cause }));
  }

  const fileName = (path: string): string => path.split("/").at(-1) ?? path;

  function persistViewState(): void {
    void viewStateWriter.save({
      schemaVersion: 1,
      workspaceId: selectedWorkspaceId,
      directory,
      ...(currentDoc?.workspaceId === selectedWorkspaceId
        ? { documentPath: currentDoc.path }
        : {}),
      mode,
      searchQuery,
      wrapOn,
    }).catch(report);
  }

  /** 设计稿路径样式：「工作文件夹 / 目录链 / 文件名」。 */
  const friendlyPath = (path: string): string => {
    const workspace = workspaces.find((item) => item.id === selectedWorkspaceId);
    const parts = path.split("/");
    return [workspace?.name, ...parts.slice(0, -1), parts.at(-1)]
      .filter((part): part is string => Boolean(part))
      .join(" / ");
  };

  const saveStateOf = (): SaveState =>
    currentDoc?.conflict ? "conflict" : currentDoc?.dirty ? "unsaved" : "saved";

  /* ------------------------------------------------------- 徽标计数与头部 */

  function computeDiffOps(document: OpenDocument): LineDiffOp[] {
    const ops = diffLineOps(document.baseContent, document.content);
    changedCount = countChangedLines(ops);
    mergeNavLines = changedLineNumbersOnNext(ops);
    return ops ?? [];
  }

  function scheduleDiffCount(document: OpenDocument) {
    clearTimeout(diffCountTimer);
    diffCountTimer = setTimeout(() => {
      if (disposed || currentDoc !== document) return;
      computeDiffOps(document);
      renderChrome();
    }, 200);
  }

  const changedCountText = (): string =>
    changedCount === null ? "大量改动" : `${changedCount} 处变更`;

  function saveSpec(): { label: string; disabled: boolean } {
    if (!currentDoc) return { label: "保存", disabled: true };
    const state = saveStateOf();
    if (state === "conflict") return { label: "保留我的版本", disabled: false };
    if (state === "unsaved") return { label: "保存", disabled: false };
    return { label: "已保存", disabled: true };
  }

  /** 数据驱动的头部刷新：模式 tab、工具条、路径行、状态栏一次摆平。 */
  function renderChrome(): void {
    if (!refs || disposed) return;

    setDocumentHeading(
      refs,
      currentDoc ? { name: fileName(currentDoc.path), path: friendlyPath(currentDoc.path) } : undefined,
    );
    setSaveChip(refs, saveStateOf());

    const tabs = buildModeTabs(
      [
        {
          mode: "document",
          label: "文档",
          disabled: !currentDoc || !isMarkdownPath(currentDoc.path),
          badge: null,
        },
        { mode: "source", label: "源码", disabled: !currentDoc, badge: null },
        {
          mode: "diff",
          label: "变更",
          disabled: !currentDoc,
          badge: currentDoc && changedCount !== null ? Math.max(changedCount, 0) : null,
        },
      ],
      mode,
      selectMode,
    );
    refs.modesHost.replaceChildren(...Array.from(tabs.childNodes));

    const saveButtonSpec = saveSpec();
    const toolbar = buildToolbar(
      {
        mode,
        languageLabel: currentDoc ? fileLanguage(currentDoc.path) : "文本",
        wrapActive: wrapOn,
        saveLabel: saveButtonSpec.label,
        saveDisabled: saveButtonSpec.disabled,
        changedCount,
      },
      { onTool: handleTool, onSave: () => void save(Boolean(currentDoc?.conflict)).catch(report) },
    );
    mountToolbar(refs.toolbarHost, toolbar);

    if (currentDoc) {
      fillStatus(refs.statusEl, {
        kind: "document",
        language: fileLanguage(currentDoc.path),
        lineCount: currentDoc.content.split("\n").length,
        mode,
      });
    } else {
      fillStatus(refs.statusEl, { kind: "idle" });
    }
  }

  /* ---------------------------------------------------------------- 引擎 */

  function clearEditors(): void {
    editorGeneration += 1;
    proseEditor?.unmount();
    proseEditor = undefined;
    sourceView?.destroy();
    sourceView = undefined;
    mergeView?.destroy();
    mergeView = undefined;
  }

  const codeExtensions = (
    path: string,
    readOnly: boolean,
    onChange?: (value: string) => void,
  ) => [
    lineNumbers(),
    history(),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    keymap.of([...defaultKeymap, ...historyKeymap]),
    wrapCompartment.of(wrapOn ? EditorView.lineWrapping : []),
    ...(readOnly ? [EditorState.readOnly.of(true)] : []),
    EditorState.allowMultipleSelections.of(true),
    ...(languageFor(path) ? [languageFor(path)!] : []),
    ...(onChange
      ? [
          EditorView.updateListener.of((update) => {
            if (update.docChanged) onChange(update.state.doc.toString());
          }),
        ]
      : []),
  ];

  async function mountCurrentMode(generation: number): Promise<void> {
    const document = currentDoc;
    if (!document || !refs || generation !== editorGeneration) return;
    // 防呆：文档（富文本）视图只属于 Markdown，其他文件一律落源码视图。
    const effective: TeMode =
      mode === "document" && !isMarkdownPath(document.path) ? "source" : mode;

    if (effective === "document") {
      // ProseKit：Markdown 进「纸张」，contenteditable 富文本，回写走 HTML→MD。
      let acceptingChanges = false;
      let conversionGeneration = 0;
      const extension = union(
        defineBasicExtension(),
        defineDocChangeHandler((view) => {
          if (!acceptingChanges) return;
          const conversion = ++conversionGeneration;
          void htmlToMarkdown(proseEditor?.getDocHTML() ?? view.dom.innerHTML)
            .then((content) => {
              if (generation === editorGeneration && conversion === conversionGeneration) {
                markContent(content, document);
              }
            })
            .catch(report);
        }),
      );
      const defaultContent = await markdownToHtml(document.content);
      if (disposed || generation !== editorGeneration || currentDoc !== document || !refs) return;
      proseEditor = createEditor({ extension, defaultContent });
      proseEditor.mount(refs.paperWrap);
      acceptingChanges = true;
      return;
    }

    if (effective === "diff") {
      const { head, card } = buildDiffCardParts(fileName(document.path));
      refs.diffWrap.replaceChildren(head, card);
      mergeView = new MergeView({
        a: { doc: document.baseContent, extensions: codeExtensions(document.path, true) },
        b: {
          doc: document.content,
          extensions: codeExtensions(document.path, false, (content) => markContent(content, document)),
        },
        parent: card,
        orientation: "a-b",
        highlightChanges: true,
        gutter: true,
        collapseUnchanged: { margin: 3, minSize: 8 },
      });
      return;
    }

    sourceView = new EditorView({
      doc: document.content,
      extensions: codeExtensions(document.path, false, (content) => markContent(content, document)),
      parent: refs.sourceHost,
    });
  }

  /* ------------------------------------------------------------- 数据动作 */

  function markContent(content: string, document?: OpenDocument): void {
    if (!document || currentDoc !== document) return;
    document.content = content;
    document.dirty = content !== document.baseContent;
    scheduleDiffCount(document);
    renderChrome();
    updateActiveRowMeta(document);
  }

  /** 打开后的默认视图：请求优先，其次 Markdown 进文档、其他进源码。 */
  const resolveInitialMode = (path: string, requested?: TeMode): TeMode => {
    const wanted = requested ?? (isMarkdownPath(path) ? "document" : "source");
    return wanted === "document" && !isMarkdownPath(path) ? "source" : wanted;
  };

  async function readDocument(workspaceId: string, path: string, requestedMode?: TeMode): Promise<void> {
    const generation = ++documentLoadGeneration;
    const loaded = await ctx.localFiles.readDocument(workspaceId, path);
    if (disposed || generation !== documentLoadGeneration) return;
    currentDoc = { ...loaded, baseContent: loaded.content, dirty: false, conflict: false };
    selectedWorkspaceId = workspaceId;
    mode = resolveInitialMode(path, requestedMode);
    computeDiffOps(currentDoc);
    surface.reportNav?.({ key: path, label: fileName(path) });
    persistViewState();
    render();
  }

  async function restoreViewState(): Promise<void> {
    const generation = ++documentLoadGeneration;
    let savedState;
    try {
      savedState = await loadTextEditorViewState(viewStateStore);
    } catch (cause) {
      report(new Error("无法读取文本编辑器的视图状态，已使用安全默认值", { cause }));
    }
    const restored = await restoreTextEditorViewState(
      savedState,
      workspaces.map((workspace) => workspace.id),
      ctx.localFiles,
    );
    if (disposed || generation !== documentLoadGeneration) return;
    selectedWorkspaceId = restored.state.workspaceId;
    directory = restored.state.directory;
    searchQuery = restored.state.searchQuery;
    mode = restored.state.mode;
    wrapOn = restored.state.wrapOn;
    if (restored.document) {
      currentDoc = {
        ...restored.document,
        baseContent: restored.document.content,
        dirty: false,
        conflict: false,
      };
      mode = resolveInitialMode(restored.document.path, restored.state.mode);
      computeDiffOps(currentDoc);
      surface.reportNav?.({
        key: restored.document.path,
        label: fileName(restored.document.path),
      });
    } else {
      currentDoc = undefined;
      surface.reportNav?.(null);
    }
    persistViewState();
    render();
  }

  async function claimHandoff(token: string, requestedMode?: TeMode): Promise<void> {
    const handoff = await ctx.localFiles.claimHandoff(token);
    workspaces = await ctx.localFiles.listWorkspaces();
    selectedWorkspaceId = handoff.workspaceId;
    directory = handoff.path.split("/").slice(0, -1).join("/");
    await readDocument(handoff.workspaceId, handoff.path, requestedMode);
  }

  async function pickWorkspace(): Promise<void> {
    const picked = await ctx.localFiles.pickWorkspace();
    if (!picked) return;
    workspaces = await ctx.localFiles.listWorkspaces();
    selectedWorkspaceId = picked.id;
    documentLoadGeneration += 1;
    directory = "";
    searchQuery = "";
    currentDoc = undefined;
    surface.reportNav?.(null);
    persistViewState();
    if (refs) showToast(refs.toastEl, `已打开工作文件夹「${picked.name}」`);
    render();
  }

  async function save(confirmConflict = false): Promise<void> {
    const document = currentDoc;
    if (!document || !document.dirty) return;
    if (document.conflict && !confirmConflict) {
      // 产品承诺：外部变化先比较，绝不悄悄覆盖用户磁盘上的新内容。
      if (refs) showToast(refs.toastEl, "文件已在外部变化，请在比较后点“保留我的版本”");
      renderChrome();
      return;
    }
    if (proseEditor && mode === "document") {
      const content = await htmlToMarkdown(proseEditor.getDocHTML());
      if (currentDoc !== document) return;
      document.content = content;
    } else if (sourceView) {
      document.content = sourceView.state.doc.toString();
    } else if (mergeView) {
      document.content = mergeView.b.state.doc.toString();
    }
    try {
      const saved = await ctx.localFiles.writeDocument({
        workspaceId: document.workspaceId,
        path: document.path,
        content: document.content,
        expectedRevision: document.revision,
      });
      if (currentDoc !== document) return;
      document.revision = saved.revision;
      document.baseContent = document.content;
      document.dirty = false;
      document.conflict = false;
      computeDiffOps(document);
      if (refs) showToast(refs.toastEl, "已保存到原文件");
      render();
    } catch (cause) {
      const message = String(cause);
      if (message.includes("FILE_REVISION_CONFLICT") || message.includes("REVISION")) {
        const latest = await ctx.localFiles.readDocument(document.workspaceId, document.path);
        if (currentDoc !== document) return;
        document.baseContent = latest.content;
        document.revision = latest.revision;
        document.dirty = document.content !== latest.content;
        document.conflict = document.dirty;
        computeDiffOps(document);
        mode = "diff";
        persistViewState();
        if (refs) showToast(refs.toastEl, "文件已在外部变化，请比较后再保存");
        render();
        return;
      }
      throw cause;
    }
  }

  /* --------------------------------------------------------------- 工具条 */

  /** 源码视图换行开关：Compartment 重配，编辑器不重建。 */
  function toggleWrap(): void {
    wrapOn = !wrapOn;
    for (const view of [sourceView, mergeView?.a, mergeView?.b]) {
      view?.dispatch({
        effects: wrapCompartment.reconfigure(wrapOn ? EditorView.lineWrapping : []),
      });
    }
    persistViewState();
    renderChrome();
  }

  function navigateMerge(direction: 1 | -1): void {
    const view = mergeView?.b;
    if (!view || mergeNavLines.length === 0) return;
    const totalLines = view.state.doc.lines;
    const cursorLine = view.state.doc.lineAt(view.state.selection.main.head).number - 1;
    const ordered = direction === 1 ? mergeNavLines : [...mergeNavLines].reverse();
    const found = ordered.find((line) => (direction === 1 ? line > cursorLine : line < cursorLine));
    const next = found ?? mergeNavLines[0];
    if (next === undefined) return;
    const target = view.state.doc.line(Math.min(next + 1, totalLines));
    view.dispatch({ selection: { anchor: target.from }, scrollIntoView: true });
    view.focus();
  }

  function runProseCommand(commandName: string): boolean {
    const commands = proseEditor?.commands as unknown as
      | Record<string, (() => boolean) | undefined>
      | undefined;
    const command = commandName ? commands?.[commandName] : undefined;
    if (typeof command !== "function") return false;
    return command.call(commands) !== false;
  }

  function activeView(): EditorView | undefined {
    return mode === "diff" ? mergeView?.b ?? undefined : sourceView;
  }

  function handleTool(name: ToolName): void {
    switch (name) {
      case "撤销":
      case "重做": {
        if (mode === "document" && proseEditor) {
          runProseCommand(name === "撤销" ? "undo" : "redo");
        } else {
          const view = activeView();
          if (view) (name === "撤销" ? undo : redo)(view);
        }
        break;
      }
      case "标题":
      case "粗体":
      case "斜体":
      case "列表":
      case "引用":
      case "代码": {
        const commandName = DOCUMENT_TOOL_COMMANDS[name];
        if (commandName && !runProseCommand(commandName) && refs) {
          showToast(refs.toastEl, `${name} 只对文档模式里的 Markdown 生效`);
        }
        break;
      }
      case "自动换行":
        toggleWrap();
        break;
      case "查找":
        if (refs) showToast(refs.toastEl, "查找面板尚未接入");
        break;
      case "上一处":
        navigateMerge(-1);
        break;
      case "下一处":
        navigateMerge(1);
        break;
    }
  }

  /* ------------------------------------------------------------- 文件列表 */

  /** 单次遍历构建：行数据 + 点击语义 + 空态文案一起出。 */
  async function listingModel(generation: number): Promise<ListingModel> {
    const model: ListingModel = {
      sections: [],
      handlers: new Map(),
      emptyText: "没有找到文件",
      truncated: false,
    };

    if (!selectedWorkspaceId) {
      model.emptyText =
        workspaces.length > 0
          ? "选择一个工作文件夹查看里面的文件"
          : "点击右上角的“＋”打开一个工作文件夹";
      model.sections = [
        {
          heading: "当前工作",
          rows: workspaces.map<FileRow>((workspace) => ({
            key: workspace.id,
            name: workspace.name,
            meta: "已授权文件夹",
            kind: "workspace",
          })),
        },
      ];
      for (const workspace of workspaces) {
        model.handlers.set(workspace.id, () => enterWorkspace(workspace.id));
      }
      return model;
    }

    try {
      const listing = await ctx.localFiles.listDirectory(selectedWorkspaceId, directory);
      if (disposed || generation !== documentLoadGeneration) return model;
      model.truncated = listing.truncated;
      model.emptyText = "这个文件夹还没有文件";

      const rows: FileRow[] = [];
      if (directory) {
        rows.push({ key: "..", name: "上一级", kind: "up" });
        model.handlers.set("..", goUp);
      }

      const folderRows: FileRow[] = [];
      const fileRows: FileRow[] = [];
      const activeDoc =
        currentDoc?.workspaceId === selectedWorkspaceId ? currentDoc : undefined;
      for (const entry of listing.entries) {
        if (entry.kind === "directory") {
          folderRows.push({ key: entry.path, name: entry.name, meta: "文件夹", kind: "directory" });
          model.handlers.set(entry.path, () => enterDirectory(entry.path));
        } else {
          const isActive = activeDoc?.path === entry.path;
          const changeNote = isActive && (activeDoc.dirty || changedCount !== null)
            ? ` · ${changedCountText()}`
            : "";
          fileRows.push({
            key: entry.path,
            name: entry.name,
            meta: `${fileLanguage(entry.path)}${entry.size ? ` · ${humanSize(entry.size)}` : ""}${changeNote}`,
            kind: "file",
            active: isActive,
            changedDot: Boolean(isActive && activeDoc?.dirty),
          });
          model.handlers.set(entry.path, () => {
            void readDocument(selectedWorkspaceId, entry.path).catch(report);
          });
        }
      }
      if (folderRows.length > 0) model.sections.push({ heading: "文件夹", rows: folderRows });
      if (fileRows.length > 0) model.sections.push({ heading: "文件", rows: fileRows });
      if (rows.length > 0) model.sections.unshift({ rows });
    } catch (cause) {
      model.sections = [];
      model.handlers.clear();
      model.truncated = false;
      model.emptyText = `文件夹读不了：${String(cause)}`;
    }
    return model;
  }

  function enterWorkspace(id: string): void {
    selectedWorkspaceId = id;
    documentLoadGeneration += 1;
    directory = "";
    searchQuery = "";
    currentDoc = undefined;
    surface.reportNav?.(null);
    persistViewState();
    render();
  }

  function enterDirectory(path: string): void {
    directory = path;
    documentLoadGeneration += 1;
    if (refs) refs.searchInput.value = "";
    searchQuery = "";
    persistViewState();
    renderFileList();
  }

  function goUp(): void {
    if (directory) {
      directory = directory.split("/").slice(0, -1).join("/");
    } else if (selectedWorkspaceId) {
      // 工作文件夹根再往上一级＝回到已授权文件夹清单。
      selectedWorkspaceId = "";
      currentDoc = undefined;
      surface.reportNav?.(null);
    }
    documentLoadGeneration += 1;
    if (refs) refs.searchInput.value = "";
    searchQuery = "";
    persistViewState();
    renderFileList();
  }

  async function renderFileList(): Promise<void> {
    if (!refs || disposed) return;
    const generation = documentLoadGeneration;
    const model = await listingModel(generation);
    if (disposed || !refs || generation !== documentLoadGeneration) return;

    const query = searchQuery.trim().toLowerCase();
    const visible = query
      ? [
          {
            rows: model.sections.flatMap((section) => section.rows).filter((row) =>
              row.name.toLowerCase().includes(query),
            ),
          },
        ]
      : model.sections;

    refs.fileListHost.replaceChildren(
      buildFileSections(visible, query ? "没有找到文件" : model.emptyText),
    );
    if (model.truncated && !query) {
      const note = document.createElement("p");
      note.className = "te-empty";
      note.textContent = "这里只显示前 500 项，请进入更具体的文件夹。";
      refs.fileListHost.append(note);
    }
    for (const child of Array.from(refs.fileListHost.children)) {
      const button = child as HTMLElement & { dataset: DOMStringMap };
      const handler = button.dataset?.teFile ? model.handlers.get(button.dataset.teFile) : undefined;
      if (handler) button.addEventListener("click", handler);
    }
  }

  /** 当前文档脏态变化时，只原地更新它在文件栏里那一行的圆点与 meta。 */
  function updateActiveRowMeta(doc: OpenDocument): void {
    if (doc.workspaceId !== selectedWorkspaceId || !refs) return;
    const row = refs.fileListHost.querySelector<HTMLElement>(
      `[data-te-file="${CSS.escape(doc.path)}"]`,
    );
    if (!row) return;
    row.querySelector(".te-file-dot")?.remove();
    if (doc.dirty) {
      const dot = document.createElement("span");
      dot.className = "te-file-dot";
      row.append(dot);
    }
    const metaNode = row.querySelector<HTMLElement>(".te-file-m");
    if (metaNode && changedCount !== null) {
      const sizePart = doc.size ? ` · ${humanSize(doc.size)}` : "";
      metaNode.textContent = `${fileLanguage(doc.path)}${sizePart} · ${changedCountText()}`;
    }
  }

  /* -------------------------------------------------------------- 模式切换 */

  function selectMode(next: TeMode): void {
    const document = currentDoc;
    if (!document || mode === next) return;
    const change = ++modeChangeGeneration;
    void (async () => {
      if (proseEditor && mode === "document") {
        const content = await htmlToMarkdown(proseEditor.getDocHTML());
        if (currentDoc !== document || change !== modeChangeGeneration) return;
        markContent(content, document);
      }
      if (sourceView) markContent(sourceView.state.doc.toString(), document);
      if (mergeView) markContent(mergeView.b.state.doc.toString(), document);
      if (currentDoc !== document || change !== modeChangeGeneration) return;
      mode = next;
      persistViewState();
      render();
    })().catch(report);
  }

  /* ------------------------------------------------------------ 整体渲染 */

  function render(): void {
    if (disposed) return;
    clearEditors();

    const shell = buildShell({
      onOpen: () => void pickWorkspace().catch(report),
      onSearchInput: (query) => {
        searchQuery = query;
        persistViewState();
        void renderFileList();
      },
    });
    surfaceRoot.replaceChildren(shell.page);
    refs = shell;
    shell.searchInput.value = searchQuery;

    if (!currentDoc) {
      shell.paperWrap.replaceChildren(buildStageEmpty(() => void pickWorkspace().catch(report)));
    }
    setModeVisibility(shell, mode);
    renderChrome();
    void renderFileList();

    if (currentDoc) {
      const generation = editorGeneration;
      void mountCurrentMode(generation).catch(report);
    }
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      void save().catch(report);
    }
  };

  const applyIntent = (value: unknown): void => {
    const payload = intentPayload(value);
    if (payload.token) void claimHandoff(payload.token, payload.mode).catch(report);
    if (payload.pickWorkspace) void pickWorkspace().catch(report);
  };

  document.addEventListener("keydown", onKeyDown);
  const stopIntent = surface.onIntent(applyIntent);
  render();
  void ctx.localFiles
    .listWorkspaces()
    .then(async (items) => {
      if (disposed) return;
      workspaces = items;
      await restoreViewState();
      if (disposed) return;
      applyIntent(surface.initialIntent);
    })
    .catch(report);

  return () => {
    disposed = true;
    stopIntent();
    document.removeEventListener("keydown", onKeyDown);
    clearTimeout(diffCountTimer);
    if (refs) hideToast(refs.toastEl);
    clearEditors();
    surface.root.replaceChildren();
  };
}

export default defineApp({
  async activate(ctx) {
    ctx.surfaces.register<EditorIntent>("main", (surface) => {
      try {
        const cleanup = mountTextEditor(ctx, surface);
        surface.ready();
        return cleanup;
      } catch (cause) {
        surface.fail(new Error("文本编辑器界面起不来", { cause }));
      }
    });
  },
});
