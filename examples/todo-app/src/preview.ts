import "@reai/agent-ui/styles.css";
import { createMockTodoWorkflow } from "./mock-workflow";
import { TodoStateCoordinator } from "./state-coordinator";
import {
  addLocalDays,
  createEmptyTodoState,
  createTodoNode,
  localDateKey,
  type TodoState,
} from "./todo-model";
import { mountTodoView } from "./todo-view";
import "./todo.css";

const root = document.querySelector<HTMLElement>("#app");
if (!root) throw new Error("Preview root missing");

const now = new Date();
const today = localDateKey(now);
const yesterday = addLocalDays(today, -1);
const tomorrow = addLocalDays(today, 1);
const nextWeek = addLocalDays(today, 5);
const at = (dateKey: string, hour: number, minute = 0) => {
  const value = new Date(`${dateKey}T00:00:00`);
  value.setHours(hour, minute, 0, 0);
  return value.toISOString();
};

const initialState: TodoState = {
  ...createEmptyTodoState(),
  nodes: [
    createTodoNode({ id: "doctor", title: "下午和小王去协和医院复诊", scheduledDate: today, startAt: at(today, 15), people: ["小王"], location: "协和医院", importance: 96, now }),
    createTodoNode({ id: "proposal", title: "提交新版产品方案", scheduledDate: today, deadlineAt: at(today, 18), importance: 92, now }),
    createTodoNode({ id: "parcel", title: "下楼拿快递", scheduledDate: today, importance: 58, now }),
    createTodoNode({ id: "late", title: "确认上周会议纪要", scheduledDate: yesterday, importance: 66, now }),
    createTodoNode({ id: "trip", title: "下周去云南玩", scheduledDate: nextWeek, importance: 76, now }),
    createTodoNode({ id: "study", title: "每天考研复习", scheduledDate: today, importance: 84, recurrence: { frequency: "daily", interval: 1, startDate: today, completedDates: [] }, now }),
    createTodoNode({ id: "reading", title: "整理今年想读的书", importance: 42, now }),
    createTodoNode({ id: "health", title: "建立长期体检记录", importance: 64, now }),
    createTodoNode({ id: "flight", title: "确认往返交通", parentId: "trip", scheduledDate: tomorrow, importance: 88, now }),
  ],
  suggestions: [
    ["确认住宿", "按行程区域检查酒店或民宿", 0.94],
    ["整理每日行程", "把想去的地方按天组合", 0.89],
    ["列出不能错过的地点", "先收集景点，再决定取舍", 0.82],
    ["准备行李清单", "根据天气和活动补齐装备", 0.76],
    ["检查当地天气", "出发前三天再确认更准确", 0.68],
  ].map(([title, detail, confidence], index) => ({
    id: `preview-suggestion-${index}`,
    taskId: "trip",
    kind: "subtask" as const,
    title: title as string,
    detail: detail as string,
    confidence: confidence as number,
    status: "pending" as const,
    proposedNode: { title: title as string, importance: Math.round((confidence as number) * 100) },
    createdAt: now.toISOString(),
  })),
};

const coordinator = new TodoStateCoordinator(initialState, async () => Promise.resolve());
let view: ReturnType<typeof mountTodoView> | undefined;
const workflow = createMockTodoWorkflow({
  onPush: async (envelope) => {
    const duplicate = coordinator.current.processedEventIds.includes(envelope.eventId);
    await coordinator.applyPush(envelope);
    if (!duplicate && envelope.kind === "client_action") {
      view?.applyIntent({
        type: "talk-to-assistant",
        ...(envelope.payload?.conversationKey ? { conversationKey: envelope.payload.conversationKey } : {}),
      });
    }
  },
});
view = mountTodoView(root, {
  state: coordinator.current,
  updateState: (reducer) => coordinator.update(reducer),
  enqueueAnalysis: (node, supplement) => workflow.enqueue(node, supplement),
  answerAgent: (node, text) => workflow.answer(node, text),
});
coordinator.subscribe((state) => view?.setState(state));
