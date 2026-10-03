// DOM 级对稿测试：视图层（codex-view）结构与文案逐字对照
// design/VoiceType_UI_Designs.html 的 pageCodexApp / pageCodexAppSettings。
// 数据一律来自本地 fixture，不触发任何真实协议。

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

import {
  deriveStatus,
  groupTasksByFolder,
  mountCodexView,
  relativeTime,
  type CxaViewState,
  type CxaViewHandlers,
} from "../src/codex-view";

import { setLocale, message } from "../src/i18n";
afterEach(() => setLocale("zh"));

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

const NOW = Date.UTC(2026, 7, 26, 12, 0, 0);
const MIN = 60_000;

const baseState = (): CxaViewState => ({
  view: "work",
  logged: true,
  loading: false,
  tasks: [
    { id: "t1", cwd: "~/Projects/example-app", name: "整理客户反馈", updatedAt: NOW - 12 * MIN, statusHint: "idle", needsDecision: false },
    { id: "t2", cwd: "~/Projects/example-app", name: "检查插件权限变更", updatedAt: NOW - 3 * MIN, statusHint: "", needsDecision: true },
    { id: "t3", cwd: "~/Documents/经营复盘", name: "准备季度复盘简报", updatedAt: NOW - 8 * MIN, statusHint: "active", needsDecision: false },
  ],
  selectedId: "t1",
  detail: {
    running: false,
    fileChanges: [{ path: "work/备忘录.md", label: "新增 · 5 处" }],
    materials: [],
    goal: "整理客户反馈",
    stream: [
      { kind: "user", text: "把反馈整理成备忘录" },
      { kind: "agent", lead: "已经整理完成。", body: "共 46 条，归成 5 个主题。" },
      {
        kind: "source",
        chips: [{ icon: "file-text" as const, label: "备忘录.md" }],
      },
      {
        kind: "artifact",
        icon: "file-text" as const,
        title: "客户反馈决策备忘录",
        sub: "Markdown · 已保存到工作文件夹",
      },
    ],
  },
  approvals: [],
  userInputs: [],
  unsupported: [],
  newWorkMode: false,
  runtime: { running: true, version: "codex-0.99.0" },
  linkedApps: [
    {
      appId: "com.reai.text-editor",
      name: "文本编辑器",
      installed: true,
      enabled: true,
    },
  ],
  skills: [
    {
      name: "test-first",
      displayName: "Test First",
      description: "先写失败测试，再实现功能",
      scope: "repo",
    },
  ],
  skillsCwd: "~/Projects/example-app",
  capabilitiesLoading: false,
  accountProbed: true,
  models: [
    {
      id: "gpt-real",
      displayName: "GPT Real",
      isDefault: true,
      defaultEffort: "high",
      efforts: [
        { value: "medium", label: "medium", description: "均衡" },
        { value: "high", label: "high", description: "深入" },
      ],
    },
  ],
  selectedModel: "gpt-real",
  selectedEffort: "high",
  usage: { primaryUsedPercent: 42, lifetimeTokens: 123456 },
});

type HandlerSpy = CxaViewHandlers & {
  selections: string[];
  newWorks: number;
  decisions: Array<[number, "approved" | "denied"]>;
  submits: Array<[number, Record<string, string[]>]>;
  externals: string[];
  sends: string[];
  interrupts: number;
  modelSelections: string[];
  effortSelections: string[];
  modeSelections: string[];
  repairs: number;
};

const noopHandlers = (): HandlerSpy => {
  const selections: string[] = [];
  const decisions: Array<[number, "approved" | "denied"]> = [];
  const submits: Array<[number, Record<string, string[]>]> = [];
  const externals: string[] = [];
  const sends: string[] = [];
  const modelSelections: string[] = [];
  const effortSelections: string[] = [];
  const modeSelections: string[] = [];
  let newWorks = 0;
  let interrupts = 0;
  let repairs = 0;
  return {
    onSelectTask: (id: string) => {
      selections.push(id);
    },
    onNewWork: () => {
      newWorks += 1;
    },
    onSend: async (text: string) => {
      sends.push(text);
    },
    onInterrupt: async () => {
      interrupts += 1;
    },
    onSelectModel: (model: string) => {
      modelSelections.push(model);
    },
    onSelectEffort: (effort: string) => {
      effortSelections.push(effort);
    },
    onSelectMode: (mode: string) => {
      modeSelections.push(mode);
    },
    onOpenExternal: (path: string) => {
      externals.push(path);
    },
    onApproval: (requestId: number, decision: "approved" | "denied") => {
      decisions.push([requestId, decision]);
    },
    onSubmitAnswers: (requestId: number, answers: Record<string, string[]>) => {
      submits.push([requestId, answers]);
    },
    onExitSettings: () => {},
    onLoginBrowser: () => {},
    onLoginDevice: () => {},
    onLogout: () => {},
    onCopyText: () => {},
    onRepairRuntime: () => {
      repairs += 1;
    },
    selections,
    decisions,
    submits,
    externals,
    sends,
    modelSelections,
    effortSelections,
    modeSelections,
    get newWorks() {
      return newWorks;
    },
    get interrupts() {
      return interrupts;
    },
    get repairs() {
      return repairs;
    },
  };
};

function mount(state = baseState(), handlers = noopHandlers()) {
  const root = document.createElement("div");
  document.body.append(root);
  const view = mountCodexView(root, state, handlers);
  return { root, view, handlers };
}

describe("三栏骨架与设计稿结构", () => {
  test("pageCodexApp 三栏与 auth/toast 容器一次搭好，不再挂载假编辑器面板", () => {
    const { root, view } = mount();
    expect(root.querySelector(".cxa-nav")).toBeTruthy();
    expect(root.querySelector(".cxa-center")).toBeTruthy();
    expect(root.querySelector(".cxa-inspector")).toBeTruthy();
    expect(root.querySelector("#cxaPluginPanel")).toBeFalsy();
    expect(root.querySelector("#cxaAuth")).toBeTruthy();
    expect(root.querySelector("#cxaToast")).toBeTruthy();
    expect(root.id).toBe("cxaPage");
    view.destroy();
    root.remove();
  });

  test("导航头品牌、搜索占位与新工作按钮逐字一致", () => {
    const { root, view } = mount();
    expect(root.querySelector<HTMLElement>(".cxa-brand")!.textContent).toBe("Codex App");
    expect(root.querySelector<HTMLInputElement>("#cxaSearch")!.placeholder).toBe(
      "搜索工作…",
    );
    expect(root.querySelector<HTMLButtonElement>(".cxa-new")!.title).toBe("新工作");
    view.destroy();
    root.remove();
  });

  test("账号状态仍在恢复时不提前显示登录遮罩", () => {
    const { root, view } = mount({ ...baseState(), logged: false, loading: true });
    expect(root.querySelector("#cxaAuth")!.classList.contains("show")).toBe(false);
    view.update({ loading: false });
    expect(root.querySelector("#cxaAuth")!.classList.contains("show")).toBe(true);
    view.destroy();
    root.remove();
  });

  test("compose 只保留真实发送动作，不展示没有后端的资料/模式/权限按钮", () => {
    const { root, view } = mount();
    expect(root.querySelector<HTMLTextAreaElement>("#cxaInput")!.placeholder).toBe(
      "继续交代工作，或指出要修改的地方…",
    );
    expect(root.querySelectorAll("[data-cxa-add],[data-cxa-menu]").length).toBe(0);
    expect(root.textContent).not.toContain("添加资料");
    expect(root.textContent).not.toContain("重要操作先问我");
    expect(root.querySelector<HTMLButtonElement>("#cxaSend")!.disabled).toBe(true);
    view.destroy();
    root.remove();
  });

  test("CODEXAPP-02 UX：未选工作文件夹时输入框禁用且占位明确引导，选中后恢复", () => {
    const { root, view } = mount({ ...baseState(), tasks: [], selectedId: "" });
    const input = root.querySelector<HTMLTextAreaElement>("#cxaInput")!;
    expect(input.disabled).toBe(true);
    expect(input.placeholder).toBe("请先在左侧选择或新建一个工作文件夹");
    // 语言切换后引导同样跟随 Host locale，不留死中文。
    view.refreshLocale("en");
    expect(input.placeholder).toBe("Select or create a work folder on the left to start");
    // 选中任务后回到常规占位并解除禁用。
    view.refreshLocale("zh");
    view.update({ tasks: baseState().tasks, selectedId: "t1" });
    expect(input.disabled).toBe(false);
    expect(input.placeholder).toBe("继续交代工作，或指出要修改的地方…");
    view.destroy();
    root.remove();
  });

  test("inspector 标题/副标题与三个 tab 文案", () => {
    const { root, view } = mount();
    expect(root.querySelector(".cxa-inspector-title")!.textContent).toBe("这项工作");
    expect(root.querySelector(".cxa-inspector-sub")!.textContent).toBe(
      "用到的资料、产生的改动和可用的应用",
    );
    expect(Array.from(root.querySelectorAll(".cxa-tab")).map((node) => node.textContent)).toEqual([
      "资料",
      "改动",
      "应用",
    ]);
    expect(root.querySelector<HTMLButtonElement>(".cxa-inspector-close")!.title).toBe(
      "关闭工作侧栏",
    );
    expect(root.querySelector("#cxaTabs")!.getAttribute("role")).toBe("tablist");
    expect(root.querySelector('[data-cxa-tab="context"]')!.getAttribute("role")).toBe("tab");
    expect(root.querySelector('[data-cxa-tab="context"]')!.getAttribute("aria-selected")).toBe("true");
    view.destroy();
    root.remove();
  });
});

describe("任务列表：分组折叠、状态徽标与搜索过滤", () => {
  test("新工作按钮只发起真实目录选择，成功返回后才切换输入态", () => {
    const { root, view, handlers } = mount();
    const input = root.querySelector<HTMLTextAreaElement>("#cxaInput")!;
    root.querySelector<HTMLButtonElement>(".cxa-new")!.click();
    expect(handlers.newWorks).toBe(1);
    expect(input.placeholder).toBe("继续交代工作，或指出要修改的地方…");
    view.update({ newWorkMode: true });
    expect(input.placeholder).toBe("描述要完成的工作、可用来源和期望产物…");
    view.destroy();
    root.remove();
  });

  test("按文件夹分组并显示计数 · N 与相对时间", () => {
    const { root, view } = mount();
    const folders = Array.from(root.querySelectorAll(".cxa-folder"));
    expect(folders.map((folder) => folder.textContent)).toContainEqual(
      expect.stringContaining("example-app"),
    );
    expect(root.querySelector(".cxa-folder-count")!.textContent).toBe("· 2");
    expect(root.querySelectorAll(".cxa-task").length).toBe(3);
    view.destroy();
    root.remove();
  });

  test("状态徽标映射：等你决定/正在做/已完成", () => {
    expect(deriveStatus({ statusHint: "", needsDecision: true })).toEqual({
      cls: "wait",
      text: "等你决定",
    });
    expect(deriveStatus({ statusHint: "active", needsDecision: false })).toEqual({
      cls: "run",
      text: "正在做",
    });
    expect(deriveStatus({ statusHint: "notStarted", needsDecision: false })).toEqual({
      cls: "ready",
      text: "待开始",
    });
    expect(deriveStatus({ statusHint: "idle", needsDecision: false })).toEqual({
      cls: "done",
      text: "已完成",
    });
  });

  test("搜索过滤命中为空时给「没有匹配的任务」", async () => {
    const { root, view } = mount();
    const search = root.querySelector<HTMLInputElement>("#cxaSearch")!;
    search.value = "不存在的词";
    search.dispatchEvent(new Event("input"));
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(root.textContent).toContain("没有匹配的任务");
    view.destroy();
    root.remove();
  });

  test("搜索能按真实工作目录过滤，任务点击交给 thread/read 链路", async () => {
    const { root, view, handlers } = mount();
    const search = root.querySelector<HTMLInputElement>("#cxaSearch")!;
    search.value = "经营复盘";
    search.dispatchEvent(new Event("input"));
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(root.querySelectorAll(".cxa-task").length).toBe(1);
    root.querySelector<HTMLButtonElement>(".cxa-task")!.click();
    expect(handlers.selections).toEqual(["t3"]);
    view.destroy();
    root.remove();
  });

  test("点文件夹折叠出「N 项工作」，再点展开", () => {
    const { root, view } = mount();
    const clickFolder = (): HTMLButtonElement =>
      root.querySelector<HTMLButtonElement>("[data-cxa-folder]")!;
    // renderTaskList 在折叠/展开后重建列表，必须重新取按钮引用。
    clickFolder().click();
    expect(root.querySelector(".cxa-proj.fold")).toBeTruthy();
    expect(root.textContent).toContain("2 项工作");
    clickFolder().click();
    expect(root.querySelector(".cxa-proj.fold")).toBeFalsy();
    view.destroy();
    root.remove();
  });

  test("groupTasksByFolder 按最近更新排序分组", () => {
    const groups = groupTasksByFolder(baseState().tasks);
    expect(groups[0]!.folder).toBe("~/Projects/example-app");
    expect(groups[0]!.rows.length).toBe(2);
  });

  test("relativeTime 输出设计稿风格的中文相对时间", () => {
    expect(relativeTime(NOW - 30_000, NOW)).toBe("刚刚");
    expect(relativeTime(NOW - 12 * MIN, NOW)).toBe("12 分钟前");
    expect(relativeTime(NOW - 3 * 60 * MIN, NOW)).toBe("3 小时前");
    expect(relativeTime(NOW - 24 * 60 * MIN - MIN, NOW)).toBe("昨天");
  });
});

describe("会话流：消息卡、审批卡与补充问题表单", () => {
  test("发送失败保留输入草稿，成功后才清空", async () => {
    const handlers = noopHandlers();
    handlers.onSend = async () => {
      throw new Error("runtime restarted");
    };
    const { root, view } = mount(baseState(), handlers);
    const input = root.querySelector<HTMLTextAreaElement>("#cxaInput")!;
    input.value = "这条不能丢";
    input.dispatchEvent(new Event("input"));
    root.querySelector<HTMLButtonElement>("#cxaSend")!.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(input.value).toBe("这条不能丢");
    expect(root.querySelector("#cxaToast")!.textContent).toContain("输入内容已保留");
    view.destroy();
    root.remove();
  });

  test("模型、effort、用量和停止按钮都来自真实状态并触发 handler", async () => {
    const state = baseState();
    state.detail = { ...state.detail!, running: true };
    const { root, view, handlers } = mount(state);
    const model = root.querySelector<HTMLSelectElement>("#cxaModel")!;
    const effort = root.querySelector<HTMLSelectElement>("#cxaEffort")!;
    expect(model.value).toBe("gpt-real");
    expect(effort.value).toBe("high");
    expect(root.querySelector(".cxa-usage")!.textContent).toContain("42%");
    expect(model.disabled).toBe(true);
    expect(effort.disabled).toBe(true);
    expect(root.querySelector<HTMLButtonElement>("#cxaSend")!.title).toBe("追加要求");
    root.querySelector<HTMLButtonElement>("#cxaInterrupt")!.click();
    await Promise.resolve();
    expect(handlers.interrupts).toBe(1);
    view.destroy();
    root.remove();
  });

  test("CODEXAPP-01：宽限占位只读展示——停止隐藏、发送禁用，权威详情落地后恢复", async () => {
    const state = baseState();
    // 首 turn 已接受、权威详情未落盘：占位投影 running=true 但没有 activeTurnId。
    state.detail = { ...state.detail!, running: true };
    state.firstTurnGrace = true;
    const handlers = noopHandlers();
    const { root, view } = mount(state, handlers);
    const input = root.querySelector<HTMLTextAreaElement>("#cxaInput")!;
    input.value = "趁权威详情未就绪再发一条";
    input.dispatchEvent(new Event("input"));
    const send = root.querySelector<HTMLButtonElement>("#cxaSend")!;
    // 停止/发送此刻必然失败（m154/m153）并进 Host 错误通道：入口禁用，标题
    // 也不切成「追加要求」。
    expect(send.disabled).toBe(true);
    expect(send.title).toBe("发送");
    expect(root.querySelector<HTMLButtonElement>("#cxaInterrupt")!.hidden).toBe(true);
    send.click();
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(handlers.sends).toEqual([]);
    expect(handlers.interrupts).toBe(0);
    // 权威详情落地（或窗口超时转真实失败路径）：入口恢复。
    view.update({ firstTurnGrace: false });
    const restored = root.querySelector<HTMLButtonElement>("#cxaSend")!;
    expect(restored.disabled).toBe(false);
    expect(restored.title).toBe("追加要求");
    expect(root.querySelector<HTMLButtonElement>("#cxaInterrupt")!.hidden).toBe(false);
    view.destroy();
    root.remove();
  });

  test("用户气泡靠右、agent 卡带 Codex 徽标", () => {
    const { root, view } = mount();
    expect(root.querySelector(".cxa-msg.user")).toBeTruthy();
    expect(root.querySelector(".cxa-agent-ic")).toBeTruthy();
    expect(root.querySelector(".cxa-msg-b b")!.textContent).toContain("已经整理完成");
    view.destroy();
    root.remove();
  });

  test("审批卡渲染拒绝/允许并把决定交给 handler", () => {
    const { root, view, handlers } = mount(baseState());
    view.update({
      approvals: [{ requestId: 42, title: "可以查看这次改动吗？", sub: "只读取当前项目" }],
    });
    const approvalCard = root.querySelector(".cxa-approval");
    expect(approvalCard).toBeTruthy();
    const buttons = Array.from(approvalCard!.querySelectorAll("button"));
    expect(buttons.map((btn) => btn.textContent)).toEqual(["拒绝", "允许"]);
    (buttons[1] as HTMLButtonElement).click();
    (buttons[1] as HTMLButtonElement).click();
    expect(handlers.decisions).toEqual([[42, "approved"]]);
    expect(buttons.every((button) => (button as HTMLButtonElement).disabled)).toBe(true);
    expect(root.querySelector("#cxaToast")!.textContent).toBe("已允许这项操作");
    view.destroy();
    root.remove();
  });

  test("补充问题表单校验并提交逐项答案", () => {
    const { root, view, handlers } = mount(baseState());
    view.update({
      userInputs: [
        {
          requestId: 9,
          questions: [
            { id: "q1", question: "先看哪一部分？", isOther: false, isSecret: false, options: [] },
          ],
        },
      ],
    });
    const form = root.querySelector<HTMLFormElement>(".cxa-user-input")!;
    expect(form).toBeTruthy();
    const input = form.querySelector<HTMLInputElement>(".cxa-answer")!;
    const submit = form.querySelector<HTMLButtonElement>("button[type=submit]")!;
    submit.click();
    expect(form.querySelector(".cxa-validation")!.textContent).toBe(
      "请回答每个问题后再继续。",
    );
    input.value = "收入部分";
    input.dispatchEvent(new Event("input"));
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    expect(handlers.submits).toEqual([[9, { q1: ["收入部分"] }]]);
    view.destroy();
    root.remove();
  });

  test("空任务态给出引导话术", () => {
    const { root, view } = mount({ ...baseState(), tasks: [], selectedId: "" });
    expect(root.textContent).toContain("还没有任务");
    expect(root.querySelector("#cxaThread")!.textContent).toContain("选择一项工作");
    view.destroy();
    root.remove();
  });

  test("空任务态也必须展示 runtime 错误，不能被空态提前返回吞掉", () => {
    const { root, view } = mount({
      ...baseState(),
      tasks: [],
      selectedId: "",
      error: "官方 Codex runtime 暂时不可用",
      loading: false,
    });
    expect(root.querySelector("#cxaThread")!.textContent).toContain(
      "官方 Codex runtime 暂时不可用",
    );
    view.destroy();
    root.remove();
  });

  test("已结算的补充问题必须清理草稿，请求 ID 复用时不能带出旧答案", () => {
    const { root, view } = mount(baseState());
    const question = {
      requestId: 9,
      questions: [
        { id: "q1", question: "输入答案", isOther: false, isSecret: false, options: [] },
      ],
    };
    view.update({ userInputs: [question] });
    const oldInput = root.querySelector<HTMLInputElement>(".cxa-answer")!;
    oldInput.value = "旧答案";
    oldInput.dispatchEvent(new Event("input"));
    view.update({ userInputs: [] });
    view.update({ userInputs: [question] });
    expect(root.querySelector<HTMLInputElement>(".cxa-answer")!.value).toBe("");
    view.destroy();
    root.remove();
  });

  test("进行中的线程在线程尾部给出旋转指示", () => {
    const state = baseState();
    state.selectedId = "t3";
    state.detail = { ...state.detail!, running: true };
    const { root, view } = mount(state);
    expect(root.querySelector(".cxa-actionline .spin")).toBeTruthy();
    view.destroy();
    root.remove();
  });
});

describe("inspector 三 tab 内容卡", () => {
  test("资料 tab：工作文件夹 / 要完成什么 / 线程真实报告的资料", () => {
    const { root, view } = mount();
    const sections = Array.from(root.querySelectorAll(".cxa-sec-t")).map((node) => node.textContent);
    expect(sections).toEqual(["工作文件夹", "要完成什么", "线程报告的资料"]);
    expect(root.querySelector(".cxa-summary-t")!.textContent).toBe("整理客户反馈");
    view.destroy();
    root.remove();
  });

  test("改动 tab：点击文件直接移交给真实文本编辑器，不打开占位面板", () => {
    const { root, view, handlers } = mount();
    (
      root.querySelector<HTMLButtonElement>('[data-cxa-tab="files"]') as HTMLButtonElement
    ).click();
    expect(root.querySelector(".cxa-sec-h .cxa-item-tag")!.textContent).toBe("1 项");
    const item = root.querySelector(".cxa-item")!;
    expect(item.querySelector(".cxa-item-t")!.textContent).toBe("备忘录.md");
    (item as HTMLButtonElement).click();
    expect(handlers.externals).toEqual(["work/备忘录.md"]);
    expect(root.querySelector("#cxaPluginPanel")).toBeFalsy();
    view.destroy();
    root.remove();
  });

  test("应用 tab 只显示 Host 注册表与 skills/list 的真实快照", () => {
    const { root, view } = mount();
    (
      root.querySelector<HTMLButtonElement>('[data-cxa-tab="capabilities"]') as HTMLButtonElement
    ).click();
    const body = root.querySelector("#cxaInspectorBody")!.textContent!;
    for (const copy of [
      "Host 关联应用",
      "文本编辑器",
      "已启用",
      "当前工作的 Skills",
      "Test First",
      "先写失败测试，再实现功能",
      "repo",
    ]) {
      expect(body).toContain(copy);
    }
    expect(body).not.toContain("浏览器");
    expect(body).not.toContain("Git 工具");
    expect(body).not.toContain("自动选择工作方式");
    view.destroy();
    root.remove();
  });

  test("右侧工作栏默认收起，并能从标题栏按钮打开后再次关闭", () => {
    const { root, view } = mount();
    const toggle = root.querySelector<HTMLButtonElement>("#cxaInspectToggle")!;
    expect(root.classList.contains("inspector-off")).toBe(true);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.title).toBe("打开工作侧栏");
    expect(root.querySelector("#cxaInspector")!.getAttribute("aria-hidden")).toBe("true");
    expect(root.querySelector<HTMLElement>("#cxaInspector")!.inert).toBe(true);
    toggle.click();
    expect(root.classList.contains("inspector-off")).toBe(false);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(root.querySelector("#cxaInspector")!.getAttribute("aria-hidden")).toBe("false");
    expect(root.querySelector<HTMLElement>("#cxaInspector")!.inert).toBe(false);
    root.querySelector<HTMLButtonElement>(".cxa-inspector-close")!.click();
    expect(root.classList.contains("inspector-off")).toBe(true);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    view.destroy();
    root.remove();
  });
});

describe("未登录连接卡 cxaAuth", () => {
  test("logged=false 时展示连接卡且文案逐字一致", () => {
    const { root, view } = mount({ ...baseState(), logged: false });
    const auth = root.querySelector("#cxaAuth")!;
    expect(auth.classList.contains("show")).toBe(true);
    expect(auth.querySelector(".cxa-auth-h")!.textContent).toBe("连接你的 Codex");
    expect(auth.querySelector(".cxa-auth-p")!.textContent).toBe(
      "使用 ChatGPT 订阅账户授权官方 Codex。登录在系统浏览器完成，Codex App 不读取或保存你的 ChatGPT 密码。",
    );
    expect(auth.querySelector("#cxaLogin")!.textContent).toBe("使用 ChatGPT 登录");
    expect(auth.querySelector(".cxa-auth-alt")!.textContent).toContain(
      "适用于支持 Codex 的 ChatGPT 订阅与工作区",
    );
    expect(auth.querySelector(".cxa-auth-alt")!.textContent).toContain(
      "API Key 是管理员可选项，不是默认登录方式",
    );
    view.destroy();
    root.remove();
  });

  test("logged=true 时连接卡隐藏", () => {
    const { root, view } = mount();
    expect(root.querySelector("#cxaAuth")!.classList.contains("show")).toBe(false);
    view.destroy();
    root.remove();
  });
});

describe("设置页只展示真实状态", () => {
  test("页眉标题副标题与「返回工作」", () => {
    const m = mount();
    m.view.update({ view: "settings" });
    expect(m.root.querySelector(".voice-settings-intro-title")!.textContent).toBe(
      "Codex App 设置",
    );
    expect(m.root.querySelector(".voice-settings-intro-sub")!.textContent).toBe(
      "只显示 Host 与官方 Codex runtime 的真实状态",
    );
    expect(m.root.querySelector(".cxa-settings-back")!.textContent).toContain(
      "返回工作",
    );
    m.view.destroy();
    m.root.remove();
  });

  test("运行状态来自传入快照，不再出现未落地的设置开关", () => {
    const { root, view } = mount();
    view.update({ view: "settings" });
    const labels = Array.from(root.querySelectorAll(".slbl")).map((node) => node.textContent);
    expect(labels).toEqual(["运行状态", "账户"]);
    const rowTitles = Array.from(root.querySelectorAll(".rt")).map((node) => node.textContent);
    expect(rowTitles).toEqual([
      "官方 Codex runtime",
      "文本编辑器",
      "当前工作 Skills",
      "当前默认模型",
      "Codex 用量",
      "使用 ChatGPT 登录",
    ]);
    expect(root.textContent).toContain("版本 codex-0.99.0");
    expect(root.textContent).toContain("1 个已启用");
    expect(root.querySelector(".seg")).toBeFalsy();
    expect(root.querySelector('[role="switch"]')).toBeFalsy();
    view.destroy();
    root.remove();
  });

  test("已登录账户卡带已连接 pill；未登录给登录/设备代码入口", () => {
    const loggedIn = mount();
    loggedIn.view.update({ view: "settings", account: { plan: "ChatGPT Plus", email: "k@example.com" } });
    expect(loggedIn.root.querySelector(".cxa-settings-account-t")!.textContent).toBe(
      "ChatGPT Plus",
    );
    expect(loggedIn.root.textContent).toContain("已连接");
    expect(loggedIn.root.querySelector<HTMLButtonElement>(".account-signout")!.textContent).toContain(
      "退出登录",
    );
    loggedIn.view.destroy();
    loggedIn.root.remove();

    const loggedOut = mount();
    loggedOut.view.update({ view: "settings", account: undefined });
    expect(loggedOut.root.querySelector(".cxa-settings-account-t")!.textContent).toBe(
      "尚未登录",
    );
    const buttons = Array.from(loggedOut.root.querySelectorAll(".cxa-settings-login button")).map(
      (btn) => btn.textContent,
    );
    expect(buttons).toEqual(["登录", "设备代码"]);
    loggedOut.view.destroy();
    loggedOut.root.remove();
  });

  test("账户探测未完成时显示读取中，不能误报尚未登录或提供登录按钮", () => {
    const { root, view } = mount();
    view.update({ view: "settings", account: undefined, accountProbed: false });
    expect(root.querySelector(".cxa-settings-account-t")!.textContent).toBe(
      "正在读取账户状态…",
    );
    expect(root.querySelector(".cxa-settings-login")).toBeFalsy();
    expect(root.textContent).not.toContain("尚未登录");
    view.destroy();
    root.remove();
  });
});

describe("toast", () => {
  test("show 类挂上后出现设计稿文案并可复用", () => {
    const { root, view } = mount();
    view.toast("新工作从一句目标开始，其他上下文按需添加");
    const toast = root.querySelector("#cxaToast")!;
    expect(toast.classList.contains("show")).toBe(true);
    expect(toast.textContent).toBe("新工作从一句目标开始，其他上下文按需添加");
    expect(toast.getAttribute("role")).toBe("status");
    expect(toast.getAttribute("aria-live")).toBe("polite");
    view.destroy();
    root.remove();
  });

  test("不存在只有提示、没有后端的假动作", () => {
    const { root, view } = mount();
    expect(root.querySelector("[data-cxa-add]")).toBeFalsy();
    expect(root.querySelector("[data-cxa-menu]")).toBeFalsy();
    expect(root.querySelector("#cxaPluginPanel")).toBeFalsy();
    view.destroy();
    root.remove();
  });
});

describe("内核缺失终态：一键修复安装", () => {
  const mountMissing = () => {
    const mounted = mount();
    mounted.view.update({
      selectedId: "",
      tasks: [],
      loading: false,
      runtimeMissing: true,
      error: "Codex 内核没有安装或已损坏。你的工作与登录数据都还在，修复后即可继续。",
    });
    return mounted;
  };

  test("runtimeMissing 时主区显示修复面板与按钮，不再无限转圈", () => {
    const { root, view } = mountMissing();
    expect(root.querySelector(".cxa-runtime-missing")).toBeTruthy();
    expect(root.textContent).toContain("Codex 内核未安装");
    expect(root.textContent).not.toContain("正在获取工作…");
    const repair = root.querySelector<HTMLButtonElement>("[data-cxa-repair-runtime]")!;
    expect(repair.textContent).toBe("一键修复安装");
    view.destroy();
    root.remove();
  });

  test("点击修复按钮触发 onRepairRuntime 且可复用", () => {
    const { root, view, handlers } = mountMissing();
    const repair = root.querySelector<HTMLButtonElement>("[data-cxa-repair-runtime]")!;
    repair.click();
    repair.click();
    expect(handlers.repairs).toBe(2);
    view.destroy();
    root.remove();
  });

  test("内核缺失时不弹登录浮层，账号未知不画成未登录", () => {
    const { root, view } = mount();
    view.update({ logged: false, loading: false, runtimeMissing: true });
    const overlay = root.querySelector<HTMLElement>(".cxa-auth");
    const shown = overlay?.classList.contains("show") ?? false;
    expect(shown).toBe(false);
    // 对照组：同样未登录、同样加载结束，但没有内核缺失时，登录浮层照常出现。
    view.update({ runtimeMissing: false });
    expect(
      root.querySelector<HTMLElement>(".cxa-auth")?.classList.contains("show") ?? false,
    ).toBe(true);
    view.destroy();
    root.remove();
  });

  test("设置页在内核缺失时显示修复入口", () => {
    const { root, view } = mount();
    view.update({ view: "settings", runtimeMissing: true });
    expect(root.textContent).toContain("内核安装状态");
    expect(root.querySelector<HTMLButtonElement>("[data-cxa-repair-runtime]")!).toBeTruthy();
    view.destroy();
    root.remove();
  });

  test("设置页内核已安装（managed）时不显示修复入口", () => {
    const { root, view } = mount();
    view.update({
      view: "settings",
      runtimeMissing: false,
      runtime: { running: true, version: "0.149.1", installState: "managed" },
    });
    expect(root.textContent).not.toContain("内核安装状态");
    view.destroy();
    root.remove();
  });
});

describe("Host locale changes", () => {
  test("updates visible controls while preserving live input nodes and decision drafts", () => {
    const root = document.createElement("div"); document.body.append(root);
    const state = baseState();
    state.userInputs = [{ requestId: 77, questions: [{ id: "answer", question: "用户问题", options: [], isOther: false, isSecret: false }] }];
    const handlers = noopHandlers();
    const view = mountCodexView(root, state, handlers);
    const compose = root.querySelector<HTMLTextAreaElement>("#cxaInput")!;
    const answer = root.querySelector<HTMLInputElement>(".cxa-answer")!;
    const model = root.querySelector<HTMLSelectElement>("#cxaModel")!;
    compose.value = "未发送草稿";
    answer.value = "保留我的回答"; answer.dispatchEvent(new Event("input"));
    answer.focus(); answer.setSelectionRange(1, 3);
    const scroll = root.querySelector<HTMLElement>("#cxaThread")!; scroll.scrollTop = 53;
    const change = view as typeof view & { refreshLocale?: (locale: string) => void };
    change.refreshLocale?.("en");
    expect(root.querySelector("#cxaInput")).toBe(compose);
    expect(root.querySelector(".cxa-answer")).toBe(answer);
    expect(root.querySelector("#cxaModel")).toBe(model);
    expect(document.activeElement).toBe(answer);
    expect([answer.selectionStart, answer.selectionEnd]).toEqual([1, 3]);
    expect(compose.value).toBe("未发送草稿");
    expect(answer.value).toBe("保留我的回答");
    expect(scroll.scrollTop).toBe(53);
    expect(compose.placeholder).toBe("Continue the work, or describe what to change…");
    expect(root.querySelector(".cxa-user-input button")?.textContent).toBe("Submit answers");
    expect(root.textContent).toContain("用户问题");
    expect(root.textContent).toContain("整理客户反馈");
    expect(handlers.sends).toEqual([]); expect(handlers.submits).toEqual([]);
    expect(handlers.modelSelections).toEqual([]); expect(handlers.effortSelections).toEqual([]);
    change.refreshLocale?.("zh");
    expect(compose.placeholder).toBe("继续交代工作，或指出要修改的地方…");
    view.destroy(); root.remove();
  });
});

test("locale refresh retains pending approval, validation, and authored errors without translating raw text", () => {
  const root = document.createElement("div"); document.body.append(root);
  const state = baseState();
  state.error = message("ui.m107");
  state.approvals = [{ requestId: 3, title: "等待你确认一项操作" }, { requestId: 4, title: message("ui.m127") }];
  state.userInputs = [{ requestId: 8, questions: [{ id: "q", question: "用户问题", options: [], isOther: false, isSecret: false }] }];
  const handlers = noopHandlers(); const view = mountCodexView(root, state, handlers);
  const form = root.querySelector<HTMLFormElement>(".cxa-user-input")!;
  form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  const allow = root.querySelectorAll<HTMLButtonElement>(".cxa-approval .primary")[0]!;
  allow.click();
  expect(allow.disabled).toBe(true);
  view.refreshLocale("en");
  expect(root.querySelector(".cxa-user-input")).toBe(form);
  expect(root.querySelector(".cxa-approval .primary")).toBe(allow);
  expect(allow.disabled).toBe(true);
  expect(root.querySelector(".cxa-validation")?.textContent).toBe("Answer every question to continue.");
  expect(root.querySelector("#cxaToast")?.textContent).toBe("Operation allowed");
  expect(root.textContent).toContain("等待你确认一项操作");
  expect(root.textContent).toContain("Waiting for you to approve an operation");
  expect(root.textContent).toContain("Codex is temporarily unavailable. Recovery is in progress. Please wait.");
  expect(handlers.decisions).toEqual([[3, "approved"]]);
  expect(handlers.submits).toEqual([]);
  view.destroy(); root.remove();
});

test("locale updates reasoning labels but preserves an uncommitted option and failed state", () => {
  const root = document.createElement("div"); document.body.append(root);
  const handlers = noopHandlers(); const view = mountCodexView(root, baseState(), handlers);
  const effort = root.querySelector<HTMLSelectElement>("#cxaEffort")!;
  effort.value = "medium"; effort.focus();
  view.refreshLocale("en");
  expect(root.querySelector("#cxaEffort")).toBe(effort);
  expect(effort.value).toBe("medium");
  expect(effort.selectedOptions[0]!.textContent).toBe("Medium");
  expect(document.activeElement).toBe(effort);
  expect(handlers.effortSelections).toEqual([]);
  view.refreshLocale("zh");
  expect(effort.value).toBe("medium");
  expect(effort.selectedOptions[0]!.textContent).toBe("中");
  view.destroy(); root.remove();
});

test("locale projection does not rewrite unchanged original output or replace its title text node", () => {
  const root = document.createElement("div"); document.body.append(root);
  const view = mountCodexView(root, baseState(), noopHandlers());
  const output = root.querySelector(".cxa-msg-b > span")!;
  const title = root.querySelector("#cxaTitle")!;
  const outputText = output.firstChild; const titleText = title.firstChild;
  const observer = new MutationObserver(() => {});
  observer.observe(output, { characterData: true, childList: true, subtree: true });
  observer.observe(title, { characterData: true, childList: true, subtree: true });
  view.refreshLocale("en");
  expect(output.firstChild).toBe(outputText);
  expect(title.firstChild).toBe(titleText);
  expect(observer.takeRecords()).toEqual([]);
  observer.disconnect(); view.destroy(); root.remove();
});

test("输入模式选择器：缺省 plan、change 触发 handler、活动 turn 期间禁用、locale 刷新不丢选择", async () => {
  const state = baseState();
  const { root, view, handlers } = mount(state);
  const mode = root.querySelector<HTMLSelectElement>("#cxaMode")!;
  expect(mode.value).toBe("plan");
  expect([...mode.options].map((option) => option.value)).toEqual(["chat", "plan", "yolo"]);
  mode.value = "yolo";
  mode.dispatchEvent(new Event("change"));
  expect(handlers.modeSelections).toEqual(["yolo"]);
  view.refreshLocale("en");
  expect(root.querySelector<HTMLSelectElement>("#cxaMode")).toBe(mode);
  expect(mode.value).toBe("yolo");
  expect(mode.selectedOptions[0]!.textContent).toBe("Auto");
  view.refreshLocale("zh");
  expect(mode.value).toBe("yolo");
  expect(mode.selectedOptions[0]!.textContent).toBe("自动");

  const busy = baseState();
  busy.selectedMode = "chat";
  busy.detail = { ...busy.detail!, running: true };
  const second = mount(busy);
  const busyMode = second.root.querySelector<HTMLSelectElement>("#cxaMode")!;
  expect(busyMode.value).toBe("chat");
  expect(busyMode.disabled).toBe(true);
  second.view.destroy();
  view.destroy();
  root.remove();
  second.root.remove();
});
