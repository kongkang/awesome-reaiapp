import { describe, expect, test } from "bun:test";
import {
  acceptSuggestion,
  addChildNode,
  applyPushEnvelope,
  childrenOf,
  createEmptyTodoState,
  createTodoNode,
  dismissSuggestion,
  localDateKey,
  migrateTodoState,
  occurrenceForDate,
  timelineForDate,
  type TodoState,
} from "../src/todo-model";
import { TodoStateCoordinator } from "../src/state-coordinator";

const NOW = new Date("2026-08-09T09:00:00+08:00");

describe("To-Do Agent V1 模型", () => {
  test("旧三字段数组运行时迁移为 V2 root 节点", () => {
    const state = migrateTodoState([
      { id: "legacy-1", title: "旧待办", done: true },
    ], NOW);

    expect(state.version).toBe(2);
    expect(state.nodes).toHaveLength(1);
    expect(state.nodes[0]).toMatchObject({
      id: "legacy-1",
      title: "旧待办",
      done: true,
      analysis: { status: "resolved" },
    });
    expect(state.nodes[0]?.parentId).toBeUndefined();
    expect(state.processedEventIds).toEqual([]);
  });

  test("任意深度子任务复用同一节点结构，完成子节点不改变父节点", () => {
    const root = createTodoNode({ id: "root", title: "云南旅行", now: NOW });
    let state = { ...createEmptyTodoState(), nodes: [root] };
    state = addChildNode(state, "root", { id: "child", title: "确认机票", now: NOW });
    state = addChildNode(state, "child", { id: "grandchild", title: "选择航班", now: NOW });
    state = {
      ...state,
      nodes: state.nodes.map((node) => node.id === "grandchild" ? { ...node, done: true } : node),
    };

    expect(childrenOf(state, "root").map((node) => node.id)).toEqual(["child"]);
    expect(childrenOf(state, "child").map((node) => node.id)).toEqual(["grandchild"]);
    expect(state.nodes.find((node) => node.id === "root")?.done).toBeFalse();
    expect(state.nodes.find((node) => node.id === "child")?.done).toBeFalse();
  });

  test("今日固定时间按时间排序，弹性事项随后按重要性排序", () => {
    const state: TodoState = {
      ...createEmptyTodoState(),
      nodes: [
        createTodoNode({ id: "flex-low", title: "整理照片", scheduledDate: "2026-08-09", importance: 20, now: NOW }),
        createTodoNode({ id: "fixed-late", title: "晚间复盘", startAt: "2026-08-09T20:00:00+08:00", now: NOW }),
        createTodoNode({ id: "flex-high", title: "提交材料", scheduledDate: "2026-08-09", importance: 90, now: NOW }),
        createTodoNode({ id: "fixed-early", title: "看医生", startAt: "2026-08-09T10:00:00+08:00", now: NOW }),
      ],
    };

    expect(timelineForDate(state, "2026-08-09", NOW).map((item) => item.node.id)).toEqual([
      "fixed-early",
      "fixed-late",
      "flex-high",
      "flex-low",
    ]);
  });

  test("循环 series 派生当日 occurrence，结束后停止生成", () => {
    const active = createTodoNode({
      id: "study",
      title: "考研复习",
      scheduledDate: "2026-08-01",
      recurrence: { frequency: "daily", interval: 1, startDate: "2026-08-01", completedDates: [] },
      now: NOW,
    });
    expect(occurrenceForDate(active, "2026-08-09")?.occurrenceId).toBe("study@2026-08-09");
    expect(occurrenceForDate({ ...active, recurrence: { ...active.recurrence!, endDate: "2026-08-08" } }, "2026-08-09")).toBeUndefined();
  });

  test("weekly series 只在指定星期派生 occurrence", () => {
    const weekly = createTodoNode({
      id: "training",
      title: "每周训练",
      recurrence: {
        frequency: "weekly",
        interval: 1,
        startDate: "2026-08-03",
        weekdays: [1, 3],
        completedDates: [],
      },
      now: NOW,
    });

    expect(occurrenceForDate(weekly, "2026-08-10")?.occurrenceId).toBe("training@2026-08-10");
    expect(occurrenceForDate(weekly, "2026-08-12")?.occurrenceId).toBe("training@2026-08-12");
    expect(occurrenceForDate(weekly, "2026-08-11")).toBeUndefined();
  });

  test("接受子任务建议会创建子节点，拒绝状态保持可追溯", () => {
    const root = createTodoNode({ id: "trip", title: "去云南玩", now: NOW });
    const state: TodoState = {
      ...createEmptyTodoState(),
      nodes: [root],
      suggestions: [
        {
          id: "suggest-flight",
          taskId: "trip",
          kind: "subtask",
          title: "确认机票",
          detail: "先确定往返日期",
          confidence: 0.96,
          status: "pending",
          proposedNode: { title: "确认机票", importance: 80 },
          createdAt: NOW.toISOString(),
        },
      ],
    };
    const accepted = acceptSuggestion(state, "suggest-flight", NOW, () => "new-child");

    expect(accepted.suggestions[0]?.status).toBe("accepted");
    expect(accepted.nodes.find((node) => node.id === "new-child")).toMatchObject({ parentId: "trip", title: "确认机票" });

    const dismissed = dismissSuggestion(state, "suggest-flight", NOW);
    expect(dismissed.suggestions[0]?.status).toBe("dismissed");
    expect(dismissed.suggestions[0]?.decidedAt).toBe(NOW.toISOString());
    expect(dismissed.nodes).toEqual(state.nodes);
  });

  test("重复推送 eventId 只处理一次且幂等记录有界", () => {
    const root = createTodoNode({ id: "doctor", title: "下周三看病", now: NOW });
    const state = { ...createEmptyTodoState(), nodes: [root] };
    const envelope = {
      kind: "data_update" as const,
      eventId: "event-1",
      taskId: "doctor",
      patch: { location: "协和医院", analysis: { status: "resolved" as const } },
    };
    const once = applyPushEnvelope(state, envelope, NOW);
    const twice = applyPushEnvelope(once, envelope, NOW);

    expect(twice.nodes.find((node) => node.id === "doctor")?.location).toBe("协和医院");
    expect(twice.processedEventIds).toEqual(["event-1"]);

    let bounded = twice;
    for (let index = 2; index <= 205; index += 1) {
      bounded = applyPushEnvelope(bounded, {
        kind: "user_notification",
        eventId: `event-${index}`,
        title: "更新",
        body: String(index),
      }, NOW);
    }
    expect(bounded.processedEventIds).toHaveLength(200);
    expect(bounded.processedEventIds[0]).toBe("event-6");
  });

  test("本地日期键不被 UTC 跨日截断", () => {
    expect(localDateKey(new Date(2026, 7, 9, 0, 30))).toBe("2026-08-09");
  });
});

describe("TodoStateCoordinator 单写者", () => {
  test("用户写入和异步推送交错时都基于上一次确认态", async () => {
    const persisted: string[][] = [];
    const coordinator = new TodoStateCoordinator(createEmptyTodoState(), async (state) => {
      await Promise.resolve();
      persisted.push(state.nodes.map((node) => node.id));
    });
    const userNode = createTodoNode({ id: "user", title: "用户新增", now: NOW });
    const pushNode = createTodoNode({ id: "push", title: "推送新增", now: NOW });

    const userWrite = coordinator.update((state) => ({ ...state, nodes: [...state.nodes, userNode] }));
    const pushWrite = coordinator.update((state) => ({ ...state, nodes: [...state.nodes, pushNode] }));
    await Promise.all([userWrite, pushWrite]);

    expect(coordinator.current.nodes.map((node) => node.id)).toEqual(["user", "push"]);
    expect(persisted).toEqual([["user"], ["user", "push"]]);
  });

  test("持久化失败不污染确认态，后续更新仍可继续", async () => {
    let attempts = 0;
    const coordinator = new TodoStateCoordinator(createEmptyTodoState(), async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("disk full");
    });
    const failedNode = createTodoNode({ id: "failed", title: "失败", now: NOW });
    const nextNode = createTodoNode({ id: "next", title: "继续", now: NOW });

    await expect(coordinator.update((state) => ({ ...state, nodes: [...state.nodes, failedNode] }))).rejects.toThrow("disk full");
    expect(coordinator.current.nodes).toHaveLength(0);
    await coordinator.update((state) => ({ ...state, nodes: [...state.nodes, nextNode] }));
    expect(coordinator.current.nodes.map((node) => node.id)).toEqual(["next"]);
  });
});
