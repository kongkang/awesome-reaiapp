/**
 * Computer Use 演示循环：截图 → 云端视觉模型决策 → 引擎执行 → 循环。
 *
 * 这是第一版本的「大脑」：任务用自然语言描述，模型看屏幕输出结构化动作，
 * 引擎窄口执行。动作空间按 Anthropic computer use 的惯例设计——坐标一律
 * 0–1000 归一化（相对截图），由这里换算成屏幕像素（`origin + norm × size`），
 * 模型与平台分辨率解耦。
 *
 * 视觉决策走 Host 云通道 `ai.text.generate`（cloud.model.invoke@1）：凭据归
 * 登录账号，插件不接触任何 API key；模型按档位解析，请求带图时 Host 自动
 * 限定到支持视觉输入的候选。
 *
 * 安全边界都在引擎侧（紧急停止、速率上限、护栏），这里只做：步数上限、
 * 每步前检查中断、失败即停。
 */
import { computerCall, aiCall, type Screenshot } from "./computer-bridge";

/** 模型档位（ai.models.list 的 id），不是真实模型名。 */
export interface VlmConfig {
  modelAlias: string;
}

/** 视觉定位任务默认走高质量档。 */
export const DEFAULT_VLM_CONFIG: VlmConfig = {
  modelAlias: "text-quality",
};

/** 单步动作上限。微信发消息级别的小任务 20 步足够；失控循环靠它兜底。 */
export const MAX_STEPS = 20;

/** 每步执行后等 UI 响应的间隔。 */
const STEP_COOLDOWN_MS = 800;

export type AgentAction =
  | { action: "click"; x: number; y: number; button?: "left" | "right"; double?: boolean }
  | { action: "type"; text: string }
  | { action: "press"; key: string }
  | { action: "scroll"; dx?: number; dy?: number }
  | { action: "done"; detail?: string }
  | { action: "fail"; detail?: string };

export interface StepReport {
  step: number;
  thought?: string;
  action: AgentAction;
  ok: boolean;
  error?: string;
}

export interface TaskCallbacks {
  onStep?: (report: StepReport) => void;
  /** shouldAbort 每步（含截图前）轮询；true 则停止循环并尝试恢复（resume）。 */
  shouldAbort?: () => boolean;
}

const SYSTEM_PROMPT = `你是一个操作 macOS/Windows 电脑的 GUI Agent。你会收到一张屏幕截图（全屏或某个窗口）与一个任务目标，每轮回复**只输出一个 JSON 对象**，不要输出任何其他文字或代码块标记。

可用动作（坐标一律是 0–1000 的归一化值，相对截图左上角；x 向右、y 向下）：
- {"action":"click","x":123,"y":456} —— 单击坐标处（可加 "button":"right" 右键、"double":true 双击）
- {"action":"type","text":"要输入的文字"} —— 向当前焦点输入文字（先点击输入框再输入）
- {"action":"press","key":"enter"} —— 按键或组合键（enter / tab / escape / cmd+c / ctrl+a 等）
- {"action":"scroll","dy":300} —— 滚动（dy 正=向下，dx 正=向右，单位像素）
- {"action":"done","detail":"完成说明"} —— 任务已完成
- {"action":"fail","detail":"原因"} —— 无法完成（说明卡在哪一步）

规则：
1. 一次只做一个动作；下一轮会给你新的截图。
2. 点击要落在目标元素的可点击中心，不要贴边缘。
3. 输入框需要先点击获得焦点，再 type。
4. 判断任务确实完成才输出 done。
5. 除 JSON 外不要输出任何内容。`;

/** 从模型回复里提取第一个 JSON 对象（容错 ```json 包裹与前后闲话）。 */
export function parseActionReply(reply: string): { thought?: string; action: AgentAction } | null {
  const text = reply.replace(/```json/gi, "```").trim();
  const fenced = /```([\s\S]*?)```/.exec(text);
  const candidates: string[] = [];
  if (fenced) candidates.push(fenced[1]);
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first !== -1 && last > first) candidates.push(text.slice(first, last + 1));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as Record<string, unknown>;
      if (typeof parsed.action === "string") {
        const action = parsed as unknown as AgentAction;
        // 基本合法性：click 需要有限坐标。
        if (action.action === "click") {
          const x = Number((parsed as { x?: unknown }).x);
          const y = Number((parsed as { y?: unknown }).y);
          if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        }
        const thought =
          typeof parsed.thought === "string" ? (parsed.thought as string) : undefined;
        return { thought, action };
      }
    } catch {
      // 试下一个候选。
    }
  }
  return null;
}

/**
 * 归一化坐标（0–1000）→ 屏幕坐标。
 *
 * ⚠️ 必须用 `sourceWidth`/`sourceHeight`（截图覆盖的屏幕区域），不能用
 * `width`/`height`（被 maxEdge 缩过的图像尺寸）。用后者等于把整块屏幕压成
 * maxEdge 见方：3840 宽的屏幕缩到 1024 后，模型说「正中」会落在左上角约
 * 1/4 处，右侧七成永远点不到。
 */
export function denormalize(
  shot: Pick<Screenshot, "originX" | "originY" | "sourceWidth" | "sourceHeight">,
  nx: number,
  ny: number,
): { x: number; y: number } {
  const clamp = (value: number) => Math.max(0, Math.min(1000, value)) / 1000;
  return {
    x: shot.originX + Math.round(clamp(nx) * shot.sourceWidth),
    y: shot.originY + Math.round(clamp(ny) * shot.sourceHeight),
  };
}

/**
 * 把任何抛出物归一成人能读的错误文案。
 *
 * 关键场景：宿主 bridge 的失败经 SDK `normalizeBridgeError` 归一为**普通对象**
 * `{code, userMessage, retryable}`（不是 Error），`String()` 会得到
 * "[object Object]"——不提取字段的话，权限拒绝这类真实原因会被完全吞掉。
 */
export function describeError(thrown: unknown): string {
  if (typeof thrown === "string") return thrown;
  if (thrown instanceof Error) return thrown.message || thrown.name;
  if (typeof thrown === "object" && thrown !== null) {
    const candidate = thrown as Record<string, unknown>;
    for (const key of ["userMessage", "message", "detail"]) {
      if (typeof candidate[key] === "string" && candidate[key]) {
        const code = typeof candidate.code === "string" ? candidate.code : "";
        return code ? `${candidate[key]}（${code}）` : String(candidate[key]);
      }
    }
    try {
      return JSON.stringify(thrown);
    } catch {
      return String(thrown);
    }
  }
  return String(thrown);
}

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: unknown;
}

let invocationSeq = 0;

/** Host 云通道一次视觉决策调用（`ai.text.generate`，返回 `{invocationId, text}`）。 */
async function askVlm(
  config: VlmConfig,
  messages: ChatMessage[],
): Promise<string> {
  invocationSeq += 1;
  const invocationId = `cu-${Date.now().toString(36)}-${invocationSeq}`;
  const payload = await aiCall<{ text?: unknown }>("ai.text.generate", {
    invocationId,
    model: config.modelAlias,
    messages,
    stream: false,
    temperature: 0,
    maxOutputTokens: 1024,
  });
  if (typeof payload.text === "string" && payload.text) return payload.text;
  throw new Error("云端视觉模型回复里没有文本内容");
}

export interface TaskResult {
  status: "done" | "fail" | "aborted" | "error";
  detail?: string;
  steps: number;
}

/** 执行一个自然语言任务，返回终态。 */
export async function runComputerTask(
  config: VlmConfig,
  task: string,
  callbacks: TaskCallbacks = {},
): Promise<TaskResult> {
  const history: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: [
        { type: "text", text: `任务：${task}\n\n请观察这张屏幕截图，输出你的第一个动作 JSON。` },
      ],
    },
  ];

  for (let step = 1; step <= MAX_STEPS; step += 1) {
    if (callbacks.shouldAbort?.()) {
      await computerCall("computer.resume", {}).catch(() => undefined);
      return { status: "aborted", steps: step - 1 };
    }

    let shot: Screenshot;
    try {
      shot = await computerCall<Screenshot>("computer.screenshot", { maxEdge: 1024 });
    } catch (error) {
      return { status: "error", detail: describeError(error), steps: step - 1 };
    }

    // Host 云通道的图片 part 合同：{type:"image", mime, dataBase64}
    //（Host 侧负责校验体积/魔数并转换成上游格式）。
    const userContent = [
      { type: "text", text: `任务：${task}` },
      { type: "image", mime: shot.mime, dataBase64: shot.dataBase64 },
    ];
    const askMessages: ChatMessage[] = [
      history[0],
      ...history.slice(1),
      { role: "user", content: userContent },
    ];

    let reply: string;
    try {
      reply = await askVlm(config, askMessages);
    } catch (error) {
      return { status: "error", detail: describeError(error), steps: step - 1 };
    }

    const parsed = parseActionReply(reply);
    if (!parsed) {
      callbacks.onStep?.({
        step,
        action: { action: "fail", detail: "模型回复不是合法的动作 JSON" },
        ok: false,
        error: reply.slice(0, 200),
      });
      return { status: "error", detail: "模型回复不是合法的动作 JSON", steps: step };
    }
    const { action } = parsed;

    if (action.action === "done" || action.action === "fail") {
      callbacks.onStep?.({ step, thought: parsed.thought, action, ok: true });
      return {
        status: action.action === "done" ? "done" : "fail",
        detail: action.detail ?? parsed.thought,
        steps: step,
      };
    }

    let ok = true;
    let error: string | undefined;
    try {
      await executeAction(shot, action);
    } catch (cause) {
      ok = false;
      error = describeError(cause);
    }
    callbacks.onStep?.({ step, thought: parsed.thought, action, ok, error });
    if (!ok) {
      return { status: "error", detail: error, steps: step };
    }

    // 把动作回填进历史（不带图片，控制上下文体积），下一轮附新截图。
    history.push({ role: "assistant", content: JSON.stringify(action) });
    history.push({
      role: "user",
      content: [{ type: "text", text: "已执行。这是新的截图，请输出下一个动作 JSON。" }],
    });
    if (history.length > 32) {
      // 保留 system + 最近动作对，防长任务上下文膨胀。
      history.splice(1, history.length - 32);
    }

    await new Promise((resolve) => setTimeout(resolve, STEP_COOLDOWN_MS));
  }
  return { status: "fail", detail: `达到 ${MAX_STEPS} 步上限仍未完成任务`, steps: MAX_STEPS };
}

async function executeAction(shot: Screenshot, action: AgentAction): Promise<void> {
  switch (action.action) {
    case "click": {
      const { x, y } = denormalize(shot, action.x, action.y);
      await computerCall("computer.mouse.click", {
        x,
        y,
        button: action.button ?? "left",
        double: action.double ?? false,
      });
      return;
    }
    case "type":
      await computerCall("computer.text.type", { text: action.text });
      return;
    case "press":
      await computerCall("computer.key.press", { key: action.key });
      return;
    case "scroll":
      await computerCall("computer.mouse.scroll", {
        dx: action.dx ?? 0,
        dy: action.dy ?? 0,
      });
      return;
    default:
      throw new Error(`未知的执行动作: ${(action as { action: string }).action}`);
  }
}
