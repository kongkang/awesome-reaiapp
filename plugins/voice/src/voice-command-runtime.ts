import { t } from "./voice-i18n";
/**
 * Voice Command 运行时：把后端的原始流事件翻译成合同事件，再投影成界面要的任务快照。
 *
 * 这一层是**纯函数**，刻意不碰网络也不碰 DOM —— 它是整条链路里唯一能脱离真实
 * 工作流单测的部分，而"阶段到底显示成什么"恰恰最容易出错。
 *
 * ## 为什么翻译放在插件侧
 *
 * Host 只做管道：鉴权、转发、取消、超时、有界。它**不认识**「润色」「翻译」这些词，
 * 也就组不出一张任务卡。而写回目标、会话 id、命令定义都在插件手里 —— 所以原始事件
 * 必须绕回这里翻译完，再调 Host 的呈现口。多一跳是刻意的。
 */

import {
  VOICE_COMMAND_STAGE_LABELS,
  type VoiceCommandDefinition,
  type VoiceCommandEvent,
  type VoiceCommandStage,
} from "./voice-ai-contract";

/**
 * blockId → 阶段。
 *
 * ⚠️ 键是 **`block_start` 载荷里的 `blockId`**，而后端发的是 `mapBlockName()` 之后的
 * 名字 —— 也就是**端点 outputs 里配的名字**，不是工作流里的 block 名。改端点配置
 * 会打断这张映射表。
 *
 * 这里**不写 tool 类阶段**（`tool.web_search` / `tool.knowledge_search`）：
 * `tool_start` / `tool_result` 在 Release 流式通道里被后端硬屏蔽，写了也是死代码。
 *
 * ⚠️ 本映射与 `RawStreamEvent` 绑定的是 Release 后端**直连**时的事件形状
 * （`block_chunk` 的 `chunk` 字段等）。flowApi 的 `flow.event` 透传带自己的信封
 * （invocationId/sequence），接入时「只换 opener」的承诺只对 processor 成立——
 * 这一层的映射需要按 flowApi 的实际信封重新对齐。
 */
export const STAGE_BY_BLOCK: Readonly<Record<string, VoiceCommandStage>> = {
  polish: "text.polishing",
  translate: "text.translating",
  promptify: "prompt.refining",
  agent: "agent.waiting",
  reasoning: "agent.reasoning",
  answer: "answer.generating",
};

/** Host 原样转发的后端事件。Host 不解析它，只保证有界与有序。 */
export interface RawStreamEvent {
  /** SSE 事件名：run_start / block_start / block_chunk / block_complete / run_complete / run_error … */
  event: string;
  /** SSE data 字段的原文。可能不是合法 JSON（后端异常时），所以解析要容错。 */
  data: string;
}

export interface MapContext {
  runId: string;
  /** 由调用方维护的单调递增序号；客户端用它丢弃迟到、重复或乱序事件。 */
  nextSequence: () => number;
  /** 本次运行已经过去多久。不知道终点时只显示已运行时间，不猜百分比。 */
  elapsedMs: () => number;
  commandId: string;
}

function parseData(raw: string): Record<string, unknown> {
  try {
    const value = JSON.parse(raw) as unknown;
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  } catch {
    // 解析不了就当空载荷：一条畸形事件不该让整条运行崩掉。
    return {};
  }
}

function blockIdOf(payload: Record<string, unknown>): string | null {
  const blockId = payload.blockId;
  return typeof blockId === "string" && blockId.length > 0 ? blockId : null;
}

/**
 * 把一条原始事件翻译成合同事件。返回 `null` = 这条事件没有对应的语义，安静跳过。
 *
 * **未知 blockId 一律跳过，不产生阶段事件** —— 不崩、也不伪造一个看起来合理的阶段。
 * 骨架是 `run_start` / `run_complete` / `run_error`：即使所有 block 事件都因为端点
 * outputs 配置而发不出来，运行仍然能正确开始与终结，只是阶段变粗。
 */
export function mapRawEvent(raw: RawStreamEvent, ctx: MapContext): VoiceCommandEvent | null {
  const payload = parseData(raw.data);
  const base = {
    runId: ctx.runId,
    sequence: ctx.nextSequence(),
    elapsedMs: ctx.elapsedMs(),
  };

  switch (raw.event) {
    case "run_start":
      return { ...base, type: "run.started", commandId: ctx.commandId };

    case "block_start": {
      const blockId = blockIdOf(payload);
      const stage = blockId ? STAGE_BY_BLOCK[blockId] : undefined;
      if (!stage || !blockId) return null;
      return { ...base, type: "stage.started", stage, instanceId: blockId };
    }

    case "block_complete":
    case "block_end": {
      const blockId = blockIdOf(payload);
      const stage = blockId ? STAGE_BY_BLOCK[blockId] : undefined;
      if (!stage || !blockId) return null;
      return { ...base, type: "stage.completed", stage, instanceId: blockId };
    }

    case "block_chunk": {
      // 后端这个字段叫 chunk，不是 delta —— 照着 delta 取会永远拿到空串。
      const chunk = payload.chunk;
      if (typeof chunk !== "string" || chunk.length === 0) return null;
      return { ...base, type: "output.delta", channel: "answer", delta: chunk };
    }

    case "run_complete":
      return { ...base, type: "run.completed" };

    case "run_error":
      return {
        ...base,
        type: "run.failed",
        error: {
          code: "unavailable",
          get message() { return typeof payload.message === "string" ? payload.message : t("commandRuntime.message1"); },
          retryable: true,
        },
      };

    default:
      // block_error / block_skipped / 未来新增的事件：安静跳过，别让未知事件崩掉运行。
      return null;
  }
}

/** Host 呈现口要的任务快照。字段与 Rust 侧 `TaskSnapshot` 一一对应。 */
export interface TaskSnapshot {
  taskId: string;
  title: string;
  state: "running" | "succeeded" | "failed";
  stageLabel: string;
  planSteps: string[];
  stepIndex: number;
  startedAt: number;
  unread: boolean;
  /** 运行中的任务正在等你拍板：Host 胶囊据此亮「等你确认」。终态帧一律带 false。 */
  waiting?: boolean;
}

export function initialSnapshot(input: {
  taskId: string;
  title: string;
  startedAt: number;
  planSteps?: string[];
}): TaskSnapshot {
  return {
    taskId: input.taskId,
    title: input.title,
    state: "running",
    stageLabel: VOICE_COMMAND_STAGE_LABELS["stt.transcribing"],
    planSteps: input.planSteps ?? [],
    stepIndex: 0,
    startedAt: input.startedAt,
    unread: false,
  };
}

/**
 * 「Agent 根本没跑起来」的门禁错误码。
 *
 * 登录、权限或所选 Agent 后端不可用发生在**预检**阶段，3 秒 gate 尚未起跑；
 * 它们仍要进入统一短结果面板。其余预检失败（没听清、上一条还在跑）已有现场反馈，
 * 再弹一份结果只会重复。
 */
const COMMAND_GATE_FAILURE_CODES: ReadonlySet<string> = new Set([
  "VOICE_COMMAND_NOT_CONFIGURED",
  "VOICE_COMMAND_LOGIN_REQUIRED",
  "DSH_ENGINE_UNAVAILABLE",
  "DSH_LOGIN_REQUIRED",
  "AI_MODEL_PERMISSION_REQUIRED",
  "AGENT_BACKEND_UNAVAILABLE",
]);

export function isCommandGateFailureCode(code: string): boolean {
  return COMMAND_GATE_FAILURE_CODES.has(code);
}

/**
 * 把一条合同事件投影到任务快照上。
 *
 * ⚠️ **进度只从声明的阶段映射来**，绝不拿已耗时间除以总时长去猜 —— 那是编的。
 * 计划里没有对应阶段时，步数保持不动，而不是往前挪一格充数。
 */
export function projectTask(
  previous: TaskSnapshot,
  event: VoiceCommandEvent,
  command?: Pick<VoiceCommandDefinition, "steps">,
): TaskSnapshot {
  switch (event.type) {
    case "stage.started":
      return {
        ...previous,
        stageLabel: VOICE_COMMAND_STAGE_LABELS[event.stage],
        stepIndex: stepIndexOf(previous, event.stage, command),
      };

    case "run.completed":
      return {
        ...previous,
        state: "succeeded",
        // 跑完了就该被看见：留着未读标记，直到用户真的打开它。
        unread: true,
        stepIndex: previous.planSteps.length
          ? previous.planSteps.length - 1
          : previous.stepIndex,
      };

    case "run.failed":
      return {
        ...previous,
        state: "failed",
        stageLabel: event.error.message,
        // 失败要被看见，而且角落里的失败态不参与自动收起。
        unread: true,
      };

    case "run.cancelled":
      return { ...previous, state: "failed", stageLabel: t("commandRuntime.message2"), unread: false };

    default:
      return previous;
  }
}

/**
 * 阶段在执行计划里的位置。
 *
 * 找不到对应就保持原位 —— 宁可进度看起来"卡住"，也不要凭空往前挪一格：
 * 那会让用户以为某一步做完了，而它根本没跑。
 */
function stepIndexOf(
  previous: TaskSnapshot,
  stage: VoiceCommandStage,
  command?: Pick<VoiceCommandDefinition, "steps">,
): number {
  if (!command || previous.planSteps.length === 0) return previous.stepIndex;
  const stageToStep: Partial<Record<VoiceCommandStage, string>> = {
    "text.polishing": "polish",
    "text.translating": "translate",
    "prompt.refining": "promptify",
    "agent.waiting": "agent",
    "agent.reasoning": "agent",
    "answer.generating": "agent",
  };
  const kind = stageToStep[stage];
  if (!kind) return previous.stepIndex;
  const index = command.steps.findIndex((step) => step.kind === kind);
  return index >= 0 ? Math.min(index, previous.planSteps.length - 1) : previous.stepIndex;
}
