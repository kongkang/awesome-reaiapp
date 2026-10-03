import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  createEmptyTodoState,
  createTodoNode,
  type TodoState,
} from "../src/todo-model";
import { TodoStateCoordinator } from "../src/state-coordinator";
import {
  createMockTodoWorkflow,
  type TodoScheduler,
} from "../src/mock-workflow";
import { mountTodoView } from "../src/todo-view";

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

const NOW = new Date("2026-08-09T09:00:00+08:00");

class ManualScheduler implements TodoScheduler {
  private jobs: Array<() => void | Promise<void>> = [];

  schedule(job: () => void | Promise<void>): () => void {
    this.jobs.push(job);
    return () => {
      this.jobs = this.jobs.filter((candidate) => candidate !== job);
    };
  }

  async flushNext(): Promise<void> {
    await this.jobs.shift()?.();
  }

  get size(): number { return this.jobs.length; }
}

function submit(form: HTMLFormElement): void {
  form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
}

function click(selector: string, root: ParentNode = document): void {
  const target = root.querySelector(selector);
  if (!(target instanceof HTMLButtonElement) && !(target instanceof HTMLInputElement)) {
    throw new Error(`找不到可点击元素：${selector}`);
  }
  target.click();
}

function mountHarness(initialState: TodoState = createEmptyTodoState()) {
  const root = document.createElement("div");
  document.body.appendChild(root);
  const scheduler = new ManualScheduler();
  const coordinator = new TodoStateCoordinator(initialState, async () => Promise.resolve());
  let view: ReturnType<typeof mountTodoView>;
  const workflow = createMockTodoWorkflow({
    now: () => new Date(NOW),
    scheduler,
    onPush: async (envelope) => {
      await coordinator.applyPush(envelope, NOW);
    },
  });
  view = mountTodoView(root, {
    state: coordinator.current,
    now: () => new Date(NOW),
    updateState: (reducer) => coordinator.update(reducer),
    enqueueAnalysis: (node, supplement) => workflow.enqueue(node, supplement),
    answerAgent: (node, text) => workflow.answer(node, text),
  });
  const off = coordinator.subscribe((state) => view.setState(state));
  return {
    root,
    scheduler,
    coordinator,
    view,
    dispose() { off(); workflow.dispose(); view.dispose(); },
  };
}

/** 打开「新增一件事」专注层并把话写进去——创建的唯一入口（V1.3；B6-27 起页头
    按钮撤除，走 titlebar intent 同款 view 入口）。 */
function compose(harness: ReturnType<typeof mountHarness>, text: string): HTMLInputElement {
  harness.view.openComposer();
  const input = harness.root.querySelector("#todo-new-task") as HTMLInputElement;
  input.value = text;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  return input;
}

describe("To-Do Agent V1 主界面", () => {
  test("默认优先显示今日，并同时提供紧凑日历和未定日期", () => {
    const today = createTodoNode({ id: "today", title: "今天最重要", scheduledDate: "2026-08-09", now: NOW });
    const undated = createTodoNode({ id: "undated", title: "以后再安排", now: NOW });
    const harness = mountHarness({ ...createEmptyTodoState(), nodes: [today, undated] });

    expect(harness.root.querySelector("[data-section='today']")?.textContent).toContain("今天最重要");
    expect(harness.root.querySelector("[data-section='calendar']")).not.toBeNull();
    expect(harness.root.querySelector("[data-section='undated']")?.textContent).toContain("以后再安排");
    harness.dispose();
  });

  test("页头只留「日程/列表」seg，新增与助理入口收进 titlebar 栈（B6-27）", () => {
    // 三件根任务（一件已完成）+ 一件子任务：列表档页头 N 只数未完成的根任务，应为 2。
    const openToday = createTodoNode({ id: "open-today", title: "还没做的", scheduledDate: "2026-08-09", now: NOW });
    const doneToday = createTodoNode({ id: "done-today", title: "已经做完", scheduledDate: "2026-08-09", done: true, now: NOW });
    const openUndated = createTodoNode({ id: "open-undated", title: "以后再说", now: NOW });
    const child = createTodoNode({ id: "child", title: "子任务不计", parentId: "open-today", now: NOW });
    const harness = mountHarness({ ...createEmptyTodoState(), nodes: [openToday, doneToday, openUndated, child] });
    const actions = harness.root.querySelector(".todo-topbar-actions");

    // 页内新增/助理按钮已撤（用户裁定 2026-08-20）：入口只留 titlebar 栈
    // （manifest titlebarActions：new-task + assistant），页头只剩 seg 两档。
    expect(actions?.querySelectorAll("button")).toHaveLength(2);
    expect(harness.root.querySelector(".todo-new-entry")).toBeNull();
    expect(harness.root.querySelector(".todo-assistant-mini")).toBeNull();
    // 「日程 / 列表」两档视角切换（对稿 tdViewSeg）：默认落在「日程」。
    const segButtons = harness.root.querySelectorAll(".todo-view-seg-btn");
    expect(segButtons).toHaveLength(2);
    expect(segButtons[0]?.textContent).toBe("日程");
    expect(segButtons[1]?.textContent).toBe("列表");
    expect(segButtons[0]?.classList.contains("is-active")).toBeTrue();
    expect(segButtons[1]?.classList.contains("is-active")).toBeFalse();
    // 常驻输入框收成了入口：没点开之前，这一页上没有创建输入框。
    expect(harness.root.querySelector("#todo-new-task")).toBeNull();
    expect(harness.root.querySelector(".todo-compose-layer")).toBeNull();
    // 页头标题/副标不再自画与 App 名重复的大标题，逐字对稿 tdRenderHead：
    // 日程档 h1「今天」+ 副标以「· 今日优先」收尾。
    expect(harness.root.querySelector(".todo-topbar-heading h1")?.textContent).toBe("今天");
    expect(harness.root.querySelector(".todo-topbar-heading p")?.textContent).toMatch(/· 今日优先$/);
    // 切到「列表」档：h1「列表」+ 副标「N 件事进行中 · 点一件进去看或管」，
    // N = 未完成的根任务数（已完成的、子任务都不算），锁死口径。
    click(".todo-view-seg-btn[data-view='list']", harness.root);
    expect(harness.root.querySelector(".todo-topbar-heading h1")?.textContent).toBe("列表");
    expect(harness.root.querySelector(".todo-topbar-heading p")?.textContent).toBe("2 件事进行中 · 点一件进去看或管");
    harness.dispose();
  });

  test("撤掉页内通知铃铛：user_notification 不在 App 里再留一份账本", async () => {
    const harness = mountHarness();
    await harness.coordinator.applyPush({
      kind: "user_notification",
      eventId: "notify-1",
      title: "日程助理已整理好建议",
      body: "5 条建议，按把握程度排好了",
    }, NOW);

    expect(harness.root.querySelector(".todo-notification-button")).toBeNull();
    expect(harness.root.querySelector(".todo-notifications")).toBeNull();
    expect(harness.root.textContent).not.toContain("日程助理已整理好建议");
    // 幂等仍然记账，呈现权归 Host。
    expect(harness.coordinator.current.processedEventIds).toEqual(["notify-1"]);
    expect("notifications" in harness.coordinator.current).toBeFalse();
    harness.dispose();
  });

  test("创建先落本地 queued，再由可控异步工作流解析", async () => {
    const harness = mountHarness();
    compose(harness, "下周三和小王一起去看病");
    submit(harness.root.querySelector(".todo-compose-form") as HTMLFormElement);
    await harness.coordinator.whenIdle();

    // 收下就关层，日程流立刻回到眼前。
    expect(harness.root.querySelector(".todo-compose-layer")).toBeNull();

    expect(harness.coordinator.current.nodes).toHaveLength(1);
    expect(harness.coordinator.current.nodes[0]?.analysis.status).toBe("queued");
    expect(harness.root.textContent).toContain("下周三和小王一起去看病");
    expect(harness.scheduler.size).toBe(2);

    await harness.scheduler.flushNext();
    await harness.coordinator.whenIdle();
    expect(harness.coordinator.current.nodes[0]?.analysis.status).toBe("processing");

    await harness.scheduler.flushNext();
    await harness.coordinator.whenIdle();
    expect(harness.coordinator.current.nodes[0]?.analysis.status).toBe("needs-input");
    expect(harness.coordinator.current.nodes[0]?.people).toContain("小王");
    harness.dispose();
  });

  test("淡橙色逾期条默认折叠并可展开", () => {
    const overdue = createTodoNode({ id: "late", title: "补交材料", deadlineAt: "2026-08-08T18:00:00+08:00", now: NOW });
    const harness = mountHarness({ ...createEmptyTodoState(), nodes: [overdue] });
    const bar = harness.root.querySelector(".todo-overdue-toggle") as HTMLButtonElement;

    expect(bar.getAttribute("aria-expanded")).toBe("false");
    expect(harness.root.querySelector(".todo-overdue-panel")?.getAttribute("hidden")).not.toBeNull();
    bar.click();
    expect(harness.root.querySelector(".todo-overdue-toggle")?.getAttribute("aria-expanded")).toBe("true");
    expect(harness.root.querySelector(".todo-overdue-panel")?.textContent).toContain("补交材料");
    harness.dispose();
  });

  test("月历只有一个尺寸：点某天滚到左边那一组并高亮，不在下面再列一遍", () => {
    const tomorrow = createTodoNode({ id: "tomorrow", title: "明天的事", scheduledDate: "2026-08-10", now: NOW });
    const harness = mountHarness({ ...createEmptyTodoState(), nodes: [tomorrow] });

    // 展开开关连同它的按钮一起撤了。
    expect(harness.root.querySelector(".todo-calendar-expand")).toBeNull();
    expect(harness.root.querySelector(".todo-calendar-selection")).toBeNull();

    click("[aria-label='2026-08-10']", harness.root);
    const hit = harness.root.querySelector(".todo-day-section.is-day-hit");
    expect(hit?.getAttribute("data-day")).toBe("2026-08-10");
    // 变的只是左边：月历自己没有多出一份当天清单。
    expect(harness.root.querySelector(".todo-calendar-selection")).toBeNull();
    expect(harness.root.querySelectorAll("[data-day='2026-08-10']")).toHaveLength(1);
    harness.dispose();
  });

  test("那一天没有安排时落到其后最近的一天", () => {
    const later = createTodoNode({ id: "later", title: "周末再说", scheduledDate: "2026-08-15", now: NOW });
    const harness = mountHarness({ ...createEmptyTodoState(), nodes: [later] });

    click("[aria-label='2026-08-13']", harness.root);
    expect(harness.root.querySelector(".todo-day-section.is-day-hit")?.getAttribute("data-day")).toBe("2026-08-15");
    harness.dispose();
  });

  test("选中某天不改变「今日优先」：今天仍然是日程流的第一组", () => {
    const today = createTodoNode({ id: "today", title: "今天最重要", scheduledDate: "2026-08-09", now: NOW });
    const later = createTodoNode({ id: "later", title: "下周的事", scheduledDate: "2026-08-15", now: NOW });
    const harness = mountHarness({ ...createEmptyTodoState(), nodes: [today, later] });

    click("[aria-label='2026-08-15']", harness.root);
    const sections = Array.from(harness.root.querySelectorAll<HTMLElement>(".todo-agenda [data-day]"));
    expect(sections[0]?.dataset.day).toBe("2026-08-09");
    expect(sections[0]?.dataset.section).toBe("today");
    harness.dispose();
  });

  test("异步更新重绘时保留正在输入的草稿和焦点", async () => {
    const harness = mountHarness();
    const input = compose(harness, "还在输入中的安排");
    input.focus();

    await harness.coordinator.update((state) => ({
      ...state,
      nodes: [...state.nodes, createTodoNode({ id: "push", title: "后台推送", now: NOW })],
    }));

    const replacement = harness.root.querySelector("#todo-new-task") as HTMLInputElement;
    expect(replacement.value).toBe("还在输入中的安排");
    expect(document.activeElement).toBe(replacement);
    harness.dispose();
  });
});

describe("新增 = 整页专注层", () => {
  test("打开就在语音待命，一敲键盘转打字", () => {
    const harness = mountHarness();
    harness.view.openComposer();

    expect(harness.root.querySelector(".todo-compose-card")?.getAttribute("role")).toBe("dialog");
    expect(harness.root.querySelector(".todo-compose-hint")?.classList.contains("is-listening")).toBeTrue();
    expect(harness.root.querySelector(".todo-compose-mic")?.getAttribute("aria-pressed")).toBe("true");

    const input = harness.root.querySelector("#todo-new-task") as HTMLInputElement;
    input.value = "下楼拿快递";
    input.dispatchEvent(new Event("input", { bubbles: true }));

    expect(harness.root.querySelector(".todo-compose-hint")?.classList.contains("is-listening")).toBeFalse();
    expect(harness.root.querySelector(".todo-compose-mic")?.getAttribute("aria-pressed")).toBe("false");
    harness.dispose();
  });

  test("属性默认只是一排图标，点哪个才展开哪一条", () => {
    const harness = mountHarness();
    harness.view.openComposer();

    expect(harness.root.querySelectorAll(".todo-compose-attr")).toHaveLength(4);
    expect(harness.root.querySelectorAll(".todo-compose-field")).toHaveLength(0);

    click("[data-attr='where']", harness.root);
    const fields = harness.root.querySelectorAll<HTMLElement>(".todo-compose-field");
    expect(fields).toHaveLength(1);
    expect(fields[0]?.dataset.field).toBe("where");
    harness.dispose();
  });

  test("填过的属性一起收下，展开却留空的当作没说过", async () => {
    const harness = mountHarness();
    compose(harness, "去复诊");
    click("[data-attr='where']", harness.root);
    click("[data-attr='who']", harness.root);
    const where = harness.root.querySelector("#todo-compose-where") as HTMLInputElement;
    where.value = "仁和医院";
    where.dispatchEvent(new Event("input", { bubbles: true }));
    submit(harness.root.querySelector(".todo-compose-form") as HTMLFormElement);
    await harness.coordinator.whenIdle();

    const created = harness.coordinator.current.nodes[0];
    expect(created?.title).toBe("去复诊");
    expect(created?.location).toBe("仁和医院");
    expect(created?.people).toEqual([]);
    harness.dispose();
  });

  test("步骤属性直接长出子任务", async () => {
    const harness = mountHarness();
    compose(harness, "筹备发布会");
    click("[data-attr='steps']", harness.root);
    const steps = harness.root.querySelector("#todo-compose-steps") as HTMLInputElement;
    steps.value = "定场地，邀请媒体";
    steps.dispatchEvent(new Event("input", { bubbles: true }));
    submit(harness.root.querySelector(".todo-compose-form") as HTMLFormElement);
    await harness.coordinator.whenIdle();

    const parent = harness.coordinator.current.nodes.find((node) => node.title === "筹备发布会");
    const children = harness.coordinator.current.nodes.filter((node) => node.parentId === parent?.id);
    expect(children.map((node) => node.title)).toEqual(["定场地", "邀请媒体"]);
    harness.dispose();
  });

  test("「时间」属性只补给分析看，不改标题", async () => {
    const harness = mountHarness();
    compose(harness, "去看牙");
    click("[data-attr='when']", harness.root);
    const when = harness.root.querySelector("#todo-compose-when") as HTMLInputElement;
    when.value = "明天";
    when.dispatchEvent(new Event("input", { bubbles: true }));
    submit(harness.root.querySelector(".todo-compose-form") as HTMLFormElement);
    await harness.coordinator.whenIdle();
    await harness.scheduler.flushNext();
    await harness.coordinator.whenIdle();
    await harness.scheduler.flushNext();
    await harness.coordinator.whenIdle();

    const created = harness.coordinator.current.nodes[0];
    expect(created?.title).toBe("去看牙");
    expect(created?.scheduledDate).toBe("2026-08-10");
    harness.dispose();
  });

  test("Esc 层级：先关专注层，再关助理，最后关详情", () => {
    const trip = createTodoNode({ id: "trip", title: "下周去云南玩", scheduledDate: "2026-08-12", now: NOW });
    const harness = mountHarness({ ...createEmptyTodoState(), nodes: [trip] });
    click("[data-task-id='trip'] .todo-task-open", harness.root);
    harness.view.openComposer();
    expect(harness.root.querySelector(".todo-compose-layer")).not.toBeNull();

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(harness.root.querySelector(".todo-compose-layer")).toBeNull();
    expect(harness.root.querySelector(".todo-detail-drawer")).not.toBeNull();

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(harness.root.querySelector(".todo-detail-drawer")).toBeNull();
    harness.dispose();
  });

  test("new-task Intent 与硬件 New 键都落到专注层", () => {
    const harness = mountHarness();
    harness.view.applyIntent({ type: "new-task" });
    expect(harness.root.querySelector(".todo-compose-layer")).not.toBeNull();
    harness.dispose();

    const second = mountHarness();
    second.view.openComposer();
    expect(second.root.querySelector(".todo-compose-layer")).not.toBeNull();
    second.dispose();
  });
});

describe("详情、建议与日程助理", () => {
  const tripState = (): TodoState => {
    const trip = createTodoNode({ id: "trip", title: "下周去云南玩", scheduledDate: "2026-08-12", now: NOW });
    return {
      ...createEmptyTodoState(),
      nodes: [trip],
      suggestions: ["确认机票", "确认酒店", "整理行程", "列景点清单", "准备行李"].map((title, index) => ({
        id: `suggest-${index}`,
        taskId: "trip",
        kind: "subtask" as const,
        title,
        detail: `建议 ${index + 1}`,
        confidence: 0.98 - index * 0.08,
        status: "pending" as const,
        proposedNode: { title, importance: 80 - index },
        createdAt: NOW.toISOString(),
      })),
    };
  };

  test("普通点击打开详情 Drawer，建议前三条展开、其余折叠", () => {
    const harness = mountHarness(tripState());
    click("[data-task-id='trip'] .todo-task-open", harness.root);

    const drawer = harness.root.querySelector(".todo-detail-drawer");
    expect(drawer?.getAttribute("role")).toBe("dialog");
    expect(drawer?.textContent).toContain("下周去云南玩");
    expect(drawer?.querySelectorAll(".todo-suggestion-card")).toHaveLength(3);
    expect(drawer?.querySelector(".todo-suggestions-more")?.textContent).toContain("另外 2 条");
    harness.dispose();
  });

  test("接受建议创建子任务，父节点不会被自动完成", async () => {
    const harness = mountHarness(tripState());
    click("[data-task-id='trip'] .todo-task-open", harness.root);
    click(".todo-suggestion-accept", harness.root);
    await harness.coordinator.whenIdle();

    expect(harness.coordinator.current.nodes.some((node) => node.parentId === "trip" && node.title === "确认机票")).toBeTrue();
    expect(harness.coordinator.current.nodes.find((node) => node.id === "trip")?.done).toBeFalse();
    harness.dispose();
  });

  test("用户可以手动添加同构子任务", async () => {
    const harness = mountHarness(tripState());
    click("[data-task-id='trip'] .todo-task-open", harness.root);
    const input = harness.root.querySelector(".todo-subtask-form input") as HTMLInputElement;
    input.value = "确认租车";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    submit(harness.root.querySelector(".todo-subtask-form") as HTMLFormElement);
    await harness.coordinator.whenIdle();

    expect(harness.coordinator.current.nodes.find((node) => node.title === "确认租车")).toMatchObject({ parentId: "trip" });
    expect(harness.coordinator.current.nodes.find((node) => node.id === "trip")?.done).toBeFalse();
    harness.dispose();
  });

  test("详情唤醒助理后提升为双栏工作区，关闭后恢复详情", async () => {
    const harness = mountHarness(tripState());
    click("[data-task-id='trip'] .todo-task-open", harness.root);
    click(".todo-detail-assistant", harness.root);

    expect(harness.root.querySelector(".todo-assistant-workspace")).not.toBeNull();
    expect(harness.root.querySelector(".todo-assistant-context")?.textContent).toContain("下周去云南玩");
    expect(harness.root.querySelector(".todo-agent-drawer")?.textContent).toContain("日程助理");
    click(".todo-agent-close", harness.root);
    expect(harness.root.querySelector(".todo-assistant-workspace")).toBeNull();
    expect(harness.root.querySelector(".todo-detail-drawer")).not.toBeNull();
    harness.dispose();
  });

  test("talk intent 打开 App 级会话并进入聆听状态，Escape 分层关闭", () => {
    const harness = mountHarness(tripState());
    harness.view.applyIntent({ type: "talk-to-assistant" });
    expect(harness.root.querySelector(".todo-agent-drawer")?.textContent).toContain("正在聆听");

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(harness.root.querySelector(".todo-agent-drawer")).toBeNull();
    harness.dispose();
  });

  test("详情 Drawer 用 Tab 把焦点留在模态区域", () => {
    const harness = mountHarness(tripState());
    click("[data-task-id='trip'] .todo-task-open", harness.root);
    const drawer = harness.root.querySelector(".todo-detail-drawer") as HTMLElement;
    const focusable = Array.from(drawer.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'));
    focusable[0]?.focus();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true }));

    expect(document.activeElement).toBe(focusable.at(-1) ?? null);
    harness.dispose();
  });

  test("助理主动追问走 aside：只开助理，不提升详情、不抢焦点", async () => {
    const harness = mountHarness();
    compose(harness, "下周三和小王一起去看病");
    submit(harness.root.querySelector(".todo-compose-form") as HTMLFormElement);
    await harness.coordinator.whenIdle();
    await harness.scheduler.flushNext();
    await harness.coordinator.whenIdle();
    await harness.scheduler.flushNext();
    await harness.coordinator.whenIdle();

    expect(harness.coordinator.current.nodes[0]?.analysis.status).toBe("needs-input");
    const aside = harness.root.querySelector(".todo-agent-drawer.is-aside");
    expect(aside).not.toBeNull();
    // 方向相反：助理来找人，不把详情顶上来当主内容。
    expect(harness.root.querySelector(".todo-assistant-workspace")).toBeNull();
    expect(harness.root.querySelector(".todo-detail-drawer")).toBeNull();
    // 不是模态，也没有蒙版——日程流照样看得见、点得动。
    expect(aside?.getAttribute("aria-modal")).toBe("false");
    expect(harness.root.querySelector(".todo-agent-scrim")).toBeNull();
    expect(harness.root.querySelector("[data-section='today']")).not.toBeNull();
    // 不抢焦点：焦点没有被搬进助理里。
    expect(aside?.contains(document.activeElement)).toBeFalse();
    harness.dispose();
  });

  test("aside 追问同一件事只弹一次，关掉之后不再自己冒出来", async () => {
    const medical = createTodoNode({
      id: "medical",
      title: "下周三去看病",
      analysis: { status: "processing", summary: "正在整理" },
      now: NOW,
    });
    const harness = mountHarness({ ...createEmptyTodoState(), nodes: [medical] });
    await harness.coordinator.update((state) => ({
      ...state,
      nodes: state.nodes.map((node) => ({ ...node, analysis: { status: "needs-input" as const } })),
    }));
    expect(harness.root.querySelector(".todo-agent-drawer.is-aside")).not.toBeNull();

    click(".todo-agent-close", harness.root);
    expect(harness.root.querySelector(".todo-agent-drawer")).toBeNull();

    // 后续无关更新不该把它重新拉开——「不理它」得是一次性的决定。
    await harness.coordinator.update((state) => ({
      ...state,
      nodes: [...state.nodes, createTodoNode({ id: "other", title: "别的事", now: NOW })],
    }));
    expect(harness.root.querySelector(".todo-agent-drawer")).toBeNull();
    harness.dispose();
  });

  test("从磁盘读出来就已经是 needs-input 的旧事项不会一开页面就弹助理", () => {
    const stale = createTodoNode({
      id: "stale",
      title: "上周就缺地点的事",
      analysis: { status: "needs-input", summary: "还不知道具体地点" },
      now: NOW,
    });
    const harness = mountHarness({ ...createEmptyTodoState(), nodes: [stale] });
    expect(harness.root.querySelector(".todo-agent-drawer")).toBeNull();
    harness.dispose();
  });

  test("Agent 回答缺失地点后更新回事项详情", async () => {
    const medical = createTodoNode({
      id: "medical",
      title: "下周三和小王一起去看病",
      scheduledDate: "2026-08-12",
      people: ["小王"],
      analysis: { status: "needs-input", summary: "还不知道具体地点" },
      now: NOW,
    });
    const harness = mountHarness({ ...createEmptyTodoState(), nodes: [medical] });
    click("[data-task-id='medical'] .todo-task-open", harness.root);
    click(".todo-detail-assistant", harness.root);
    const input = harness.root.querySelector(".agent-composer-input") as HTMLInputElement;
    input.value = "协和医院";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    for (let index = 0; index < 4; index += 1) {
      await Promise.resolve();
      await harness.coordinator.whenIdle();
    }

    expect(harness.coordinator.current.nodes.find((node) => node.id === "medical")).toMatchObject({
      location: "协和医院",
      analysis: { status: "resolved" },
    });
    expect(harness.root.querySelector(".todo-assistant-context")?.textContent).toContain("协和医院");
    harness.dispose();
  });
});

describe("「日程 / 列表」视角切换", () => {
  test("列表档是 root 事情的集合：子任务不另列，日期 chip 说人话", () => {
    const parent = createTodoNode({ id: "parent", title: "下周去云南玩", scheduledDate: "2026-08-12", importance: 85, now: NOW });
    const child = createTodoNode({ id: "child", title: "确认机票", parentId: "parent", now: NOW });
    const free = createTodoNode({ id: "free", title: "学吉他", now: NOW });
    const harness = mountHarness({ ...createEmptyTodoState(), nodes: [parent, child, free] });

    click(".todo-view-seg-btn[data-view='list']", harness.root);
    const view = harness.root.querySelector(".todo-list-view");
    expect(view).not.toBeNull();
    // root 集合：父事项在、子任务不在——子任务属于详情里的步骤树。
    expect(view?.querySelectorAll(".todo-list-row")).toHaveLength(2);
    expect(view?.textContent).toContain("下周去云南玩");
    expect(view?.textContent).toContain("学吉他");
    expect(view?.textContent).not.toContain("确认机票");
    // 日期 chip：近三天之外的给「N月D日」，没日期的说「未定日期」。
    expect(view?.querySelector(".todo-list-row[data-task-id='parent'] .todo-list-chip")?.textContent).toContain("8月12日");
    expect(view?.querySelector(".todo-list-row[data-task-id='free'] .todo-list-chip")?.textContent).toContain("未定日期");
    // 重要的事亮旗标（对稿 importance>=80）。
    expect(view?.querySelector(".todo-list-row[data-task-id='parent'] .todo-list-flag")?.getAttribute("title")).toBe("重要");
    harness.dispose();
  });

  test("没完成的排在前面；等补充的、有建议的都在行内亮出来", () => {
    const done = createTodoNode({ id: "done", title: "已经做完的事", done: true, scheduledDate: "2026-08-09", now: NOW });
    const waiting = createTodoNode({
      id: "waiting",
      title: "和小李去看病",
      scheduledDate: "2026-08-10",
      analysis: { status: "needs-input", summary: "缺地点" },
      now: NOW,
    });
    const state: TodoState = {
      ...createEmptyTodoState(),
      nodes: [done, waiting],
      suggestions: [{
        id: "suggest-1",
        taskId: "waiting",
        kind: "subtask",
        title: "先挂号",
        detail: "提前一周挂专家号更稳",
        confidence: 0.9,
        status: "pending",
        createdAt: NOW.toISOString(),
      }],
    };
    const harness = mountHarness(state);
    click(".todo-view-seg-btn[data-view='list']", harness.root);

    const rows = harness.root.querySelectorAll<HTMLElement>(".todo-list-row");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.dataset.taskId).toBe("waiting");
    expect(rows[1]?.dataset.taskId).toBe("done");
    expect(rows[0]?.querySelector(".todo-list-chip.is-alert")?.textContent).toContain("等你补充");
    expect(rows[0]?.querySelector(".todo-list-chip.is-accent")?.textContent).toContain("1 条建议");
    harness.dispose();
  });

  test("带子任务的行给进度条：几步完成一目了然", () => {
    const parent = createTodoNode({ id: "parent", title: "筹备发布会", scheduledDate: "2026-09-15", now: NOW });
    const first = createTodoNode({ id: "first", title: "定下场地", parentId: "parent", done: true, now: NOW });
    const second = createTodoNode({ id: "second", title: "邀请媒体", parentId: "parent", now: NOW });
    const harness = mountHarness({ ...createEmptyTodoState(), nodes: [parent, first, second] });
    click(".todo-view-seg-btn[data-view='list']", harness.root);

    const row = harness.root.querySelector(".todo-list-row[data-task-id='parent']");
    expect(row?.querySelector(".todo-list-progress-count")?.textContent).toBe("1/2");
    expect((row?.querySelector(".todo-list-progress-bar i") as HTMLElement).style.width).toBe("50%");
    harness.dispose();
  });

  test("列表档空态与行内打开详情", () => {
    const empty = mountHarness();
    click(".todo-view-seg-btn[data-view='list']", empty.root);
    expect(empty.root.querySelector(".todo-list-view")?.textContent).toContain("还没有任何事。");
    empty.dispose();

    const trip = createTodoNode({ id: "trip", title: "下周去云南玩", scheduledDate: "2026-08-12", now: NOW });
    const harness = mountHarness({ ...createEmptyTodoState(), nodes: [trip] });
    click(".todo-view-seg-btn[data-view='list']", harness.root);
    click(".todo-list-row[data-task-id='trip'] .todo-list-open", harness.root);
    expect(harness.root.querySelector(".todo-detail-drawer")?.textContent).toContain("下周去云南玩");
    // 关掉详情人还在列表档——看详情不该替用户换视角。
    click(".todo-detail-close", harness.root);
    expect(harness.root.querySelector(".todo-list-view")).not.toBeNull();
    harness.dispose();
  });

  test("列表档里点日历某天：先切回日程档再滚动，否则滚了也看不见", () => {
    const tomorrow = createTodoNode({ id: "tomorrow", title: "明天的事", scheduledDate: "2026-08-10", now: NOW });
    const harness = mountHarness({ ...createEmptyTodoState(), nodes: [tomorrow] });
    click(".todo-view-seg-btn[data-view='list']", harness.root);
    expect(harness.root.querySelector(".todo-list-view")).not.toBeNull();

    click("[aria-label='2026-08-10']", harness.root);
    expect(harness.root.querySelector(".todo-list-view")).toBeNull();
    expect(harness.root.querySelector(".todo-view-seg-btn[data-view='schedule']")?.classList.contains("is-active")).toBeTrue();
    expect(harness.root.querySelector(".todo-day-section.is-day-hit")?.getAttribute("data-day")).toBe("2026-08-10");
    harness.dispose();
  });

  test("切走再切回不丢日程流滚动位置（对稿 tdViewSeg 不重渲日程流）", () => {
    const first = createTodoNode({ id: "t1", title: "今天的事", scheduledDate: "2026-08-09", now: NOW });
    const later = createTodoNode({ id: "t2", title: "下周的事", scheduledDate: "2026-08-20", now: NOW });
    const harness = mountHarness({ ...createEmptyTodoState(), nodes: [first, later] });
    const agenda = harness.root.querySelector<HTMLElement>(".todo-agenda");
    expect(agenda).not.toBeNull();
    agenda!.scrollTop = 240; // 用户在日程档滚到了下面（happy-dom 不做布局，纯值语义）

    click(".todo-view-seg-btn[data-view='list']", harness.root);
    expect(harness.root.querySelector(".todo-list-view")).not.toBeNull();
    // 整页重建后列表档的同名容器从 0 起步——记忆要跨档存续。
    expect(harness.root.querySelector<HTMLElement>(".todo-agenda")!.scrollTop).toBe(0);

    click(".todo-view-seg-btn[data-view='schedule']", harness.root);
    const restored = harness.root.querySelector<HTMLElement>(".todo-agenda");
    expect(restored).not.toBeNull();
    expect(restored!.scrollTop).toBe(240); // 不弹回「今天」顶部（dsh 补审对 #343）
    harness.dispose();
  });

  test("视角选择在会话内保持：状态重绘不弹回日程档", async () => {
    const harness = mountHarness();
    click(".todo-view-seg-btn[data-view='list']", harness.root);
    await harness.coordinator.update((state) => ({
      ...state,
      nodes: [...state.nodes, createTodoNode({ id: "push", title: "后台推送的事", now: NOW })],
    }));

    expect(harness.root.querySelector(".todo-list-view")).not.toBeNull();
    expect(harness.root.querySelector(".todo-list-view")?.textContent).toContain("后台推送的事");
    harness.dispose();
  });
});

describe("详情 Drawer 是挤压式", () => {
  test("不盖蒙版：右栏让位、日程流还在、非模态", () => {
    const trip = createTodoNode({ id: "trip", title: "下周去云南玩", scheduledDate: "2026-08-12", now: NOW });
    const harness = mountHarness({ ...createEmptyTodoState(), nodes: [trip] });
    click("[data-task-id='trip'] .todo-task-open", harness.root);

    // 覆盖层与蒙版都不存在：详情是布局里的一列，不是浮上来的层。
    expect(harness.root.querySelector(".todo-detail-layer")).toBeNull();
    expect(harness.root.querySelector(".todo-detail-scrim")).toBeNull();
    // 主列表让位：右栏（日历/未定日期）收起，日程流被挤窄但一直看得见、点得动。
    expect(harness.root.querySelector(".todo-body")?.classList.contains("is-detail-open")).toBeTrue();
    expect(harness.root.querySelector("[data-section='calendar']")).toBeNull();
    expect(harness.root.querySelector(".todo-agenda")?.textContent).toContain("下周去云南玩");
    // 非模态：背景可见可点，点别的事情就换详情。
    expect(harness.root.querySelector(".todo-detail-drawer")?.getAttribute("aria-modal")).toBe("false");
    harness.dispose();
  });

  test("关闭详情右栏回来；Esc 仍是逐级后退的出口", () => {
    const trip = createTodoNode({ id: "trip", title: "下周去云南玩", scheduledDate: "2026-08-12", now: NOW });
    const harness = mountHarness({ ...createEmptyTodoState(), nodes: [trip] });
    click("[data-task-id='trip'] .todo-task-open", harness.root);

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(harness.root.querySelector(".todo-detail-drawer")).toBeNull();
    expect(harness.root.querySelector(".todo-body")?.classList.contains("is-detail-open")).toBeFalse();
    expect(harness.root.querySelector("[data-section='calendar']")).not.toBeNull();
    harness.dispose();
  });
});
