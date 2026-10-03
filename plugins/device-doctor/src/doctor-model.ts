/**
 * 诊断对话的纯状态层：把 Host 的进度事件折算成 agent-ui 的对话流。
 *
 * 纯函数、零 DOM——这里是全部业务判断，`doctor-view.ts` 只负责渲染，
 * 测试锁在这个文件上。
 */

import type { Agent, StreamItem } from "@reai/agent-ui";
import type { LocalAgentErrorInfo, LocalAgentEvent, LocalAgentState } from "@reai/app-sdk/v1";

/** 工具名 → 给用户看的动作名。与 Host 扩展里的 label 同源，但这里是展示层文案。 */
export const TOOL_LABELS: Readonly<Record<string, string>> = {
  device_status: "查看设备状态",
  permission_status: "查看权限状态",
  recent_logs: "翻最近日志",
  app_environment: "看运行环境",
};

export function toolLabel(toolName: string): string {
  return TOOL_LABELS[toolName] ?? toolName;
}

/** Host 稳定错误码 → 用户可读文案。 */
export const ERROR_TEXT: Readonly<Record<LocalAgentErrorInfo["code"], string>> = {
  disabled: "本地助手在当前版本不可用",
  not_granted: "本插件未被授予本地助手能力",
  busy: "助手正忙，请稍候再试",
  runtime_missing: "本地助手组件缺失，请更新 App 后重试",
  start_failed: "本地助手启动失败，请重试",
  crashed: "本地助手意外退出，请重试",
  cancelled: "已停止",
  timeout: "助手响应超时，请重试",
  invalid_request: "只支持文字消息",
  not_logged_in: "需要登录后才能使用云端分析，请先在设置里登录",
  internal: "助手内部出错，请重试",
  unknown: "诊断没有完成，请重试",
};

export function errorText(code: string): string {
  return ERROR_TEXT[code as LocalAgentErrorInfo["code"]] ?? ERROR_TEXT.unknown;
}

export interface DoctorSnapshot {
  /** 喂给 `mountConversationStream` 的 agent 投影。 */
  agent: Agent;
  busy: boolean;
  state: LocalAgentState;
  /** 本轮收到的 message 事件数——用它判断终局答案要不要兜底补一条。 */
  turnMessages: number;
  /** 本轮已收到的答案文本累计（Host 的 answer 正是各 message 文本的顺序拼接）。
   * 终局时与 send() 的全文比对：不一致说明丢块，半截文本不能伪装成完整回答。 */
  turnText: string;
  /** 工作卡的启动时刻（stream 下标 → epoch 毫秒）。agent-ui 的 `since` 字段
   * 合同是**已运行秒数**，真实起始时刻只能记在这里，结束时折算。 */
  workStarts: Map<number, number>;
}

const clock = () =>
  new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });

export function createDoctorSnapshot(): DoctorSnapshot {
  return {
    busy: false,
    state: "idle",
    turnMessages: 0,
    turnText: "",
    workStarts: new Map(),
    agent: {
      id: "com.reai.device-doctor",
      kind: "agent",
      ava: "诊",
      name: "设备诊断助手",
      role: "只读诊断 · 日志摘要会发云端分析",
      status: "idle",
      time: "",
      last: "",
      stream: [],
    },
  };
}

/** 用户提问进流。 */
export function pushUserMessage(snapshot: DoctorSnapshot, text: string): DoctorSnapshot {
  const message: StreamItem = { k: "msg", me: 1, text, ts: clock() };
  return {
    ...snapshot,
    agent: {
      ...snapshot.agent,
      stream: [...snapshot.agent.stream, message],
      last: text,
      time: clock(),
    },
  };
}

/** 把一个 Host 进度事件折算进对话流（纯函数）。 */
export function reduceEvent(snapshot: DoctorSnapshot, event: LocalAgentEvent): DoctorSnapshot {
  const stream = [...snapshot.agent.stream];
  const next: DoctorSnapshot = { ...snapshot, agent: { ...snapshot.agent, stream } };

  switch (event.type) {
    case "turn.started": {
      next.busy = true;
      next.turnMessages = 0;
      next.turnText = "";
      next.agent.status = "busy";
      // 即时反馈:请求一发出就出现「正在启动助手」卡片,第一个真实进展到达时撤掉。
      // 幂等:这张卡有两个来源(onSend 的乐观置忙 + Host 的 turn.started 事件,
      // 各到一次),已有打开的启动卡时只刷新计时,不叠第二张——否则一次提问
      // 会并排出现两张「正在启动本地助手」。
      let existing = -1;
      for (let i = stream.length - 1; i >= 0; i--) {
        const item = stream[i];
        if (item.k === "work" && Boolean(item.open) && item.label.startsWith("正在启动")) {
          existing = i;
          break;
        }
      }
      if (existing < 0) {
        stream.push({
          k: "work",
          label: "正在启动本地助手…",
          since: 0,
          steps: [],
          open: "open",
        });
        existing = stream.length - 1;
      }
      next.workStarts.set(existing, Date.now());
      break;
    }
    case "tool.start": {
      // 第一个真实进展:启动引导卡撤掉。
      for (let i = stream.length - 1; i >= 0; i--) {
        const item = stream[i];
        if (item.k === "work" && Boolean(item.open) && item.label.startsWith("正在启动")) {
          stream.splice(i, 1);
          next.workStarts.delete(i);
          break;
        }
      }
      const index = stream.length;
      stream.push({
        k: "work",
        label: toolLabel(event.toolName),
        since: 0,
        steps: [{ t: event.toolName }],
        open: "open",
      });
      next.workStarts.set(index, Date.now());
      break;
    }
    case "tool.end": {
      // 从后往前找最近一个未完结的工作卡，把步骤标成完成。
      let index = -1;
      for (let i = stream.length - 1; i >= 0; i--) {
        const item = stream[i];
        if (item.k === "work" && Boolean(item.open)) {
          index = i;
          break;
        }
      }
      if (index >= 0) {
        const work = stream[index] as Extract<StreamItem, { k: "work" }>;
        // since 的合同是已运行**秒数**:用记录的起始时刻折算,不再把毫秒时间戳
        // 直接塞进去(那会渲染成「已运行 29780200856 分」)。
        const startedAt = next.workStarts.get(index);
        const elapsed = startedAt
          ? Math.max(1, Math.round((Date.now() - startedAt) / 1000))
          : 0;
        next.workStarts.delete(index);
        stream[index] = {
          ...work,
          since: elapsed,
          steps: [{ t: event.toolName, d: 1 }],
          open: undefined,
        };
      }
      break;
    }
    case "message": {
      next.turnMessages += 1;
      next.turnText = snapshot.turnText + event.text;
      for (let i = stream.length - 1; i >= 0; i--) {
        const item = stream[i];
        if (item.k === "work" && Boolean(item.open) && item.label.startsWith("正在启动")) {
          stream.splice(i, 1);
          next.workStarts.delete(i);
          break;
        }
      }
      // append = 长回答分块投递的续文：拼进同一条助手气泡，不新开一条——
      // 否则一次回答会被拆成好几段，Markdown 记号还会被块边界切断。
      const tail = stream[stream.length - 1];
      if (event.append && tail && tail.k === "msg" && !tail.me) {
        const merged = tail.text + event.text;
        stream[stream.length - 1] = { ...tail, text: merged };
        next.agent.last = merged;
      } else {
        stream.push({ k: "msg", text: event.text, ts: clock() });
        next.agent.last = event.text;
      }
      break;
    }
    case "turn.settled":
      next.busy = false;
      next.agent.status = "idle";
      for (let i = stream.length - 1; i >= 0; i--) {
        const item = stream[i];
        if (item.k === "work" && Boolean(item.open) && item.label.startsWith("正在启动")) {
          stream.splice(i, 1);
          next.workStarts.delete(i);
          break;
        }
      }
      break;
  }
  return next;
}

/**
 * 回合终局的兜底：如果事件通道一路都没收到答案（环溢出 / 推送失败），
 * 用 `send()` 的返回值补最后一条，避免界面停在「进行中」却一个字都没有。
 */
export function settleWithAnswer(snapshot: DoctorSnapshot, answer: string): DoctorSnapshot {
  const settled = reduceEvent(snapshot, { type: "turn.settled", ok: true });
  if (settled.turnMessages > 0) {
    // 事件到齐（或答案本就为空没得比）：终局即事件呈现的样子。
    if (settled.turnText === answer || !answer.trim()) return settled;
    // 收到过但拼不齐（丢块）：用 send() 的全文修正尾部助手气泡——半截文本
    // 看起来像完整回答，用户无从察觉，宁可整段替换不可残缺。
    const stream = [...settled.agent.stream];
    const tail = stream[stream.length - 1];
    if (tail && tail.k === "msg" && !tail.me) {
      stream[stream.length - 1] = { ...tail, text: answer };
      return { ...settled, agent: { ...settled.agent, stream, last: answer } };
    }
  }
  // 事件通道一条答案都没到：用返回值补。答案本身为空（AgentSettled 但没有
  // message_end）时也要给一句人话，而不是渲染一个空白气泡。
  const text = answer.trim() ? answer : "助手没有返回内容，请重试";
  return reduceEvent(settled, { type: "message", text });
}

// ---------------------------------------------------------------------------
// 持久化：插件切走会销毁运行时，对话只存内存必然「跳回来就空」。
// 每次状态变化写进私有 KV，activate 时恢复。
// ---------------------------------------------------------------------------

export interface DoctorPersisted {
  /** 对话流（StreamItem 是可序列化的纯对象）。 */
  stream: StreamItem[];
  last: string;
  time: string;
  /** 运行时被销毁时是否有在途回合——有的话恢复时补一句「已被停止」。 */
  busy: boolean;
}

export function persistable(snapshot: DoctorSnapshot): DoctorPersisted {
  return {
    stream: snapshot.agent.stream,
    last: snapshot.agent.last,
    time: snapshot.agent.time,
    busy: snapshot.busy,
  };
}

/** 从 KV 恢复快照。上次运行被切走时若有在途提问，末尾补一条显式说明。 */
export function restoreSnapshot(saved: DoctorPersisted): DoctorSnapshot {
  const snapshot = createDoctorSnapshot();
  snapshot.agent.stream = [...saved.stream];
  snapshot.agent.last = saved.last;
  snapshot.agent.time = saved.time;
  // 被切走时还开着的工作卡:收口成完成态(具体中断说明由下面的 busy 注脚交代)。
  for (let i = 0; i < snapshot.agent.stream.length; i++) {
    const item = snapshot.agent.stream[i];
    if (item.k === "work" && Boolean(item.open)) {
      if (item.label.startsWith("正在启动")) {
        // 启动引导卡是瞬时状态,不随对话恢复。
        snapshot.agent.stream.splice(i, 1);
        i -= 1;
        continue;
      }
      snapshot.agent.stream[i] = {
        ...item,
        since: 0,
        steps: item.steps.map((step) => ({ ...step, d: 1 as const })),
        open: undefined,
      };
    }
  }
  if (saved.busy) {
    snapshot.agent.stream.push({
      k: "msg",
      text: "（上一条提问在切换界面时被停止，请重新发送）",
      ts: clock(),
    });
    snapshot.busy = false;
  }
  snapshot.agent.status = "idle";
  return snapshot;
}
