/**
 * 本地 agent 内核窄口（`agent.local@1`）的 App 侧类型。
 *
 * 只授予官方内置插件（设备诊断助手 `com.reai.device-doctor`），第三方声明会被
 * validator 拒绝。能力边界（计划 §6）：
 *
 * - **只读**：四个工具（设备状态 / 权限状态 / 最近日志摘要 / 运行环境），
 *   不接受路径参数、不写文件、不执行命令；
 * - 日志摘要会经云端模型网关**分析**——首次使用时插件应明确告知用户；
 * - 只支持文字消息，图片在 Host 侧拒绝（`LOCAL_AGENT_INVALID_REQUEST`）；
 * - 运行时按需拉起、闲置 5 分钟退出。
 */

/** 会话状态。`failed` 时 `detail` 是原因；再次发送会重新拉起。 */
export type LocalAgentState = "idle" | "starting" | "ready" | "busy" | "failed";

export interface LocalAgentStatus {
  state: LocalAgentState;
  detail?: string | null;
  /** OAuth 是否登录。未登录时发送会得到 `not_logged_in`。 */
  loggedIn: boolean;
}

export interface LocalChatSendOptions {
  /** 用户文字。只有这一个字段——图片不在协议里，Host 会拒绝任何夹带。 */
  message: string;
}

export type LocalChatResult = { answer: string };

/**
 * Host 经 `local.event` 推送的回合进度。
 *
 * 事件是**进度**不是终局：丢了不影响答案（终局由 `send()` 的返回值给出），
 * UI 用它把「正在查什么」显示出来。
 */
export type LocalAgentEvent = { schemaVersion?: number; sessionId?: string; sequence?: number; timestamp?: number; runtime?: "pi" | "dsh" | "codex" } & (
  /** 1.21：越界审批等待 / 已解决；插件只呈现状态，批准入口在 Host 主窗口。 */
  | ({ type: "approval.requested" | "approval.resolved" } & import("./agent-session").AgentApprovalSummary)
  /**
   * 回合停下来等用户拍板（启用浏览器插件、越界审批……）。期间 Host 暂停该回合的全部计时，
   * UI 应显示「等待你授权：label」、已等时长和 `action` 对应的入口，而不是「还在跑」或超时。
   * `action.type`：`tool-dependency`（调 `requireToolDependency({ tool: action.toolName })`）/
   * `host-approval`（到 Driver 主窗口确认）。未知 `action.type` 只显示文字。
   */
  | ({ type: "wait.started"; turnId?: string } & AgentUserWait)
  | { type: "wait.ended"; kind: "waiting_user"; waitId: string; reason: string; outcome: "granted" | "declined" | "cancelled"; waitedMs: number; turnId?: string }
  | { type: "turn.started"; turnId?: string }
  | { type: "tool.start"; toolName: string; turnId?: string; callId?: string }
  | { type: "tool.end"; toolName: string; isError: boolean; turnId?: string; callId?: string }
  | { type: "tool.outcome"; toolName: string; errorCode: string; turnId?: string; callId?: string }
  /**
   * 一段回答文本。原生进度可为缓冲输出；是否实时流式以能力声明为准：`append: true` 表示本段是
   * 上一条 message 的续文，UI 应拼进同一条气泡，而不是新开一条。
   */
  | { type: "message"; text: string; append?: boolean; turnId?: string }
  | { type: "turn.settled"; ok: boolean; turnId?: string });

/** 一次「等用户拍板」。`startedAt` 为 Unix 毫秒。 */
export interface AgentUserWait {
  kind: "waiting_user";
  waitId: string;
  reason: "browser_plugin_required" | "scope_approval" | (string & {});
  label: string;
  action: { type: "tool-dependency"; toolName: "web_search" | "web_fetch"; appId: string }
    | { type: "host-approval"; approvalId: string }
    | { type: string; [key: string]: unknown };
  startedAt: number;
  toolName?: string;
}

export interface LocalAgentClient {
  status(): Promise<LocalAgentStatus>;
  /** 发一条提示，等待整回合终局。进行中再发会得到 `busy`。 */
  send(options: LocalChatSendOptions): Promise<LocalChatResult>;
  /** 停止当前回合（进程会被终止；下一条消息重新拉起）。 */
  cancel(): Promise<void>;
}

/** 稳定错误码 → 上层小写码的纯查表。 */
export interface LocalAgentErrorInfo {
  code:
    | "disabled"
    | "not_granted"
    | "busy"
    | "runtime_missing"
    | "start_failed"
    | "crashed"
    | "cancelled"
    | "timeout"
    | "invalid_request"
    | "not_logged_in"
    | "internal"
    | "unknown";
  retryable: boolean;
}

const LOCAL_ERROR_TABLE: Readonly<Record<string, LocalAgentErrorInfo>> = {
  LOCAL_AGENT_DISABLED: { code: "disabled", retryable: false },
  LOCAL_AGENT_NOT_GRANTED: { code: "not_granted", retryable: false },
  LOCAL_AGENT_BUSY: { code: "busy", retryable: true },
  LOCAL_AGENT_RUNTIME_MISSING: { code: "runtime_missing", retryable: false },
  LOCAL_AGENT_START_FAILED: { code: "start_failed", retryable: true },
  LOCAL_AGENT_SESSION_RESTORE_FAILED: { code: "start_failed", retryable: true },
  LOCAL_AGENT_CRASHED: { code: "crashed", retryable: true },
  LOCAL_AGENT_CANCELLED: { code: "cancelled", retryable: false },
  LOCAL_AGENT_TIMEOUT: { code: "timeout", retryable: true },
  LOCAL_AGENT_INVALID_REQUEST: { code: "invalid_request", retryable: false },
  LOCAL_AGENT_NOT_LOGGED_IN: { code: "not_logged_in", retryable: false },
  LOCAL_AGENT_INTERNAL: { code: "internal", retryable: true },
};

/** 认不出的码一律 `unknown` + 不可重试。 */
export function describeLocalAgentError(code: string): LocalAgentErrorInfo {
  return LOCAL_ERROR_TABLE[code] ?? { code: "unknown", retryable: false };
}
