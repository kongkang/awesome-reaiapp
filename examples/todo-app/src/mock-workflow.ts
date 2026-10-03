import {
  addLocalDays,
  localDateKey,
  type TodoNode,
  type TodoNodePatch,
  type TodoPushEnvelope,
  type TodoSuggestion,
} from "./todo-model";

export interface TodoScheduler {
  schedule(job: () => void | Promise<void>, delayMs: number): () => void;
}

export interface MockTodoWorkflow {
  /**
   * `supplement` 是新增专注层里那几行可选属性（时间 / 地点…）拼出来的补充说明。
   * 它不改标题——标题永远是用户自己说的那句话——只是让分析看到完整的一句。
   */
  enqueue(node: TodoNode, supplement?: string): void;
  answer(node: TodoNode, text: string): Promise<void>;
  dispose(): void;
}

interface WorkflowOptions {
  now?: () => Date;
  scheduler?: TodoScheduler;
  onPush(envelope: TodoPushEnvelope): void | Promise<void>;
  idFactory?: () => string;
}

const browserScheduler: TodoScheduler = {
  schedule(job, delayMs) {
    const timer = setTimeout(() => { void job(); }, delayMs);
    return () => clearTimeout(timer);
  },
};

function nextWeekday(now: Date, weekday: number): string {
  const today = localDateKey(now);
  const daysToNextMonday = ((8 - now.getDay()) % 7) || 7;
  return addLocalDays(today, daysToNextMonday + ((weekday + 6) % 7));
}

function sameWeekdayAhead(now: Date, weekday: number): string {
  const delta = (weekday - now.getDay() + 7) % 7 || 7;
  return addLocalDays(localDateKey(now), delta);
}

function dateFromText(text: string, now: Date): string | undefined {
  if (text.includes("今天")) return localDateKey(now);
  if (text.includes("明天")) return addLocalDays(localDateKey(now), 1);
  if (text.includes("后天")) return addLocalDays(localDateKey(now), 2);
  const names: Array<[string, number]> = [["一", 1], ["二", 2], ["三", 3], ["四", 4], ["五", 5], ["六", 6], ["日", 0], ["天", 0]];
  for (const [name, weekday] of names) {
    if (text.includes(`下周${name}`)) return nextWeekday(now, weekday);
    if (text.includes(`周${name}`) || text.includes(`星期${name}`)) return sameWeekdayAhead(now, weekday);
  }
  return undefined;
}

function peopleFromText(text: string): string[] {
  const matched = text.match(/(?:和|跟)([^，。！？]+?)(?:一起|去|到|看|做|聊)/);
  if (!matched?.[1]) return [];
  return matched[1].split(/[、和与]/).map((person) => person.trim()).filter(Boolean);
}

function locationFromText(text: string): string | undefined {
  const matched = text.match(/(?:去|到)([^，。！？]{2,20}?(?:医院|诊所|中心|公司|机场|车站|酒店|餐厅))/);
  return matched?.[1]?.trim();
}

function fixedTimeFromText(text: string, dateKey: string | undefined): string | undefined {
  if (!dateKey) return undefined;
  const matched = text.match(/(上午|下午|晚上)?\s*(\d{1,2})(?:[:：点](\d{1,2})?)?/);
  if (!matched?.[2]) return undefined;
  let hour = Number(matched[2]);
  const minute = Number(matched[3] ?? 0);
  if ((matched[1] === "下午" || matched[1] === "晚上") && hour < 12) hour += 12;
  const date = new Date(`${dateKey}T00:00:00`);
  date.setHours(hour, minute, 0, 0);
  return date.toISOString();
}

function suggestionsFor(node: TodoNode, now: Date, idFactory: () => string): TodoSuggestion[] {
  const common = (titles: Array<[string, string, number]>): TodoSuggestion[] => titles.map(([title, detail, confidence], index) => ({
    id: `${node.id}:suggest:${index}:${idFactory()}`,
    taskId: node.id,
    kind: "subtask",
    title,
    detail,
    confidence,
    status: "pending",
    proposedNode: { title, importance: Math.round(confidence * 100) },
    createdAt: now.toISOString(),
  }));

  if (/云南|旅行|旅游/.test(node.title)) {
    return common([
      ["确认往返交通", "先把出发和返程的日期确定下来", 0.97],
      ["确认住宿", "按行程区域检查酒店或民宿", 0.94],
      ["整理每日行程", "把想去的地方按天组合", 0.89],
      ["列出不能错过的地点", "先收集景点，再决定取舍", 0.82],
      ["准备行李清单", "根据天气和活动补齐装备", 0.76],
    ]);
  }
  if (/快递|包裹/.test(node.title)) {
    return common([
      ["补充快递单号", "有单号后可以更快确认进度", 0.78],
      ["确认驿站位置", "避免下楼后再找取件点", 0.61],
    ]);
  }
  return [];
}

function analyze(
  node: TodoNode,
  now: Date,
  idFactory: () => string,
  supplement = "",
): { patch: TodoNodePatch; suggestions: TodoSuggestion[] } {
  const text = supplement ? `${node.title}，${supplement}` : node.title;
  const date = dateFromText(text, now);
  const people = peopleFromText(text);
  const location = locationFromText(text) ?? node.location;
  const startAt = fixedTimeFromText(text, date);
  const isMedical = /看病|医生|复诊|医院/.test(text);
  const needsLocation = isMedical && !location;
  const recurrence = /每天/.test(text) ? {
    frequency: "daily" as const,
    interval: 1,
    startDate: date ?? localDateKey(now),
    completedDates: [],
  } : undefined;
  const suggestions = suggestionsFor(node, now, idFactory);
  const patch: TodoNodePatch = {
    ...(date ? { scheduledDate: date } : {}),
    ...(startAt ? { startAt } : {}),
    ...(people.length ? { people } : {}),
    ...(location ? { location } : {}),
    ...(/提醒/.test(text) ? { reminder: { enabled: true } } : {}),
    ...(recurrence ? { recurrence } : {}),
    analysis: {
      status: needsLocation ? "needs-input" : "resolved",
      summary: needsLocation
        ? "时间和同行人已整理，还不知道具体地点"
        : suggestions.length
          ? `已整理关键信息，并准备了 ${suggestions.length} 条可选建议`
          : "已完成整理",
      updatedAt: now.toISOString(),
    },
  };
  return { patch, suggestions };
}

export function createMockTodoWorkflow(options: WorkflowOptions): MockTodoWorkflow {
  const now = options.now ?? (() => new Date());
  const scheduler = options.scheduler ?? browserScheduler;
  const idFactory = options.idFactory ?? (() => crypto.randomUUID());
  const cancellations = new Set<() => void>();
  let disposed = false;

  const schedule = (job: () => void | Promise<void>, delayMs: number) => {
    let cancel = () => {};
    cancel = scheduler.schedule(async () => {
      cancellations.delete(cancel);
      if (!disposed) await job();
    }, delayMs);
    cancellations.add(cancel);
  };

  return {
    enqueue(node, supplement) {
      if (disposed) return;
      schedule(() => options.onPush({
        kind: "data_update",
        eventId: idFactory(),
        taskId: node.id,
        patch: { analysis: { status: "processing", summary: "日程助理正在整理…", updatedAt: now().toISOString() } },
      }), 240);
      schedule(async () => {
        const analyzedAt = now();
        const result = analyze(node, analyzedAt, idFactory, supplement);
        await options.onPush({
          kind: "data_update",
          eventId: idFactory(),
          taskId: node.id,
          patch: result.patch,
          suggestions: result.suggestions,
        });
        if (!disposed && result.suggestions.length > 3) {
          await options.onPush({
            kind: "user_notification",
            eventId: idFactory(),
            taskId: node.id,
            title: "日程助理已整理好建议",
            body: `${node.title} · ${result.suggestions.length} 条建议，按把握程度排好了`,
          });
        }
      }, 760);
    },

    async answer(node, text) {
      const value = text.trim();
      if (!value || disposed) return;
      const location = locationFromText(`去${value}`) ?? (/医院|诊所|中心/.test(value) ? value : undefined);
      await options.onPush({
        kind: "data_update",
        eventId: idFactory(),
        taskId: node.id,
        patch: location ? {
          location,
          analysis: { status: "resolved", summary: "地点已补充，日程信息更完整了", updatedAt: now().toISOString() },
        } : {
          analysis: { ...node.analysis, updatedAt: now().toISOString() },
        },
      });
    },

    dispose() {
      disposed = true;
      for (const cancel of cancellations) cancel();
      cancellations.clear();
    },
  };
}
