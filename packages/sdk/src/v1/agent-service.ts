/** Agent v2: caller-independent config; native runtimes are selected by the service. */
import type { AgentBackend, AgentBackendChannel, AgentMemoryMode, AgentSendResult, AgentTokenUsage, AgentTurnMode, AgentWorkspace, ResolvedAgentBackend } from "./agent-session";

export interface AgentConfig {
  schemaVersion: 2;
  /** Omit (or auto) to use the Host default when creating the session. */
  runtime?: AgentBackend;
  systemPrompt: string;
  tools?: Array<{ ref: string; config?: Record<string, unknown> }>;
  skills?: Array<{ id: string; title: string; content: string; digest?: string; loading: "inline" | "on-demand" }>;
  model?: { channel?: AgentBackendChannel; tier?: string; parameters?: { maxOutputTokens?: number; temperature?: number } };
  output?: { format: "text" } | { format: "json"; schema: Record<string, unknown> };
  workspace: AgentWorkspace;
  memory: AgentMemoryMode;
  mode?: AgentTurnMode;
  /**
   * 1.23：指认本插件 `contributes.agentFeatures` 里声明的一项，作为配置页
   * 默认值与用户覆盖的合并基准。可省略。旧 Host（deny_unknown_fields）会整包
   * 拒绝该字段——不支持时按 `backends().capabilities.configuration.featureRef`
   * 缺席降级为不带 featureRef，或把 hostApi.range 下界声明到 1.23.0。
   */
  featureRef?: string;
  /**
   * 1.23：featureRef 模板的参数值（方案 B）。带参数时 Host 会核验 systemPrompt
   * 与「声明模板 + 参数」渲染结果逐字节一致；用户覆盖模板时用同一份参数渲染。
   * 只随 featureRef 出现，随 featureRef 一起降级。
   */
  featureParams?: Record<string, string>;
}

export interface AgentTurnStart {
  sessionId: string;
  /** Stable for retries of this request; different contents require a new key. */
  idempotencyKey: string;
  text: string;
  taskPresentation?: "host" | "caller";
}
export interface AgentTurnRef { sessionId: string; turnId: string }
export interface AgentToolAttempt {
  callId: string;
  toolName: string | null;
  status: "unknown" | "completed" | "failed";
  startedAt?: number;
  finishedAt?: number;
  durationMs?: number;
  errorCode?: string | null;
}
export interface AgentTurnResult extends Omit<AgentSendResult, "schemaVersion" | "runtime" | "channel" | "usage">, AgentTurnRef {
  schemaVersion: 2;
  runtime: ResolvedAgentBackend;
  channel: "external-brain";
  status: "completed" | "failed" | "cancelled";
  content: Array<{ type: "text"; text: string }>;
  /** Null means the provider did not report usage; it never means zero. */
  usage: AgentTokenUsage | null;
  toolAttempts: AgentToolAttempt[];
  toolAttemptsTruncated?: boolean;
  /** True if storage failure prevented recovery of the complete attempt summary. */
  toolAttemptsIncomplete?: boolean;
}
export interface AgentTurnSnapshot extends AgentTurnRef {
  schemaVersion: 2;
  runtime: ResolvedAgentBackend;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  expired: boolean;
  result: AgentTurnResult | null;
  /** Null only when a storage failure also prevents recovering admission metadata. */
  createdAt: number | null;
  /** Last persisted update, or observation time for a memory-only terminal fallback. */
  updatedAt: number;
  /** Finished in this process but storage unavailable; querying retries persistence. */
  persistence?: "memory-only";
  /** 进行中且正在等用户拍板时出现；期间 Host 不计任务上限，`waitForTurn` 也不计等待截止。 */
  waiting?: import("./local-agent").AgentUserWait;
  /**
   * 进行中时出现：本任务到目前为止累计等用户拍板的毫秒数（含仍在进行的等待）。Host 的
   * 任务上限不计这段，`waitForTurn` 的截止同步顺延。旧 Host 不给，缺席按 0。
   */
  waitedMs?: number;
}
export interface AgentServiceEvent extends AgentTurnRef {
  schemaVersion: 2;
  sequence: number;
  timestamp: number;
  runtime: ResolvedAgentBackend;
  type: string;
  callId?: string;
  toolName?: string;
  text?: string;
  append?: boolean;
  isError?: boolean;
}
export interface AgentServiceClient {
  /** Wait for an already accepted turn; this never starts or repeats work. */
  waitForTurn(options: AgentTurnRef): Promise<NonNullable<AgentTurnSnapshot["result"]>>;
  startTurn(options: AgentTurnStart): Promise<AgentTurnSnapshot>;
  getTurn(options: AgentTurnRef): Promise<AgentTurnSnapshot>;
  events(options: AgentTurnRef & { afterSequence?: number }): Promise<AgentTurnSnapshot & { events: AgentServiceEvent[]; gap: boolean; nextSequence: number }>;
}
