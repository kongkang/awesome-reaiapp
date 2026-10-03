/**
 * DSH 基础底座服务窄口（`agent.dsh@1`）的 App 侧类型。
 *
 * 与 `agent.local@1`（pi 常驻内核）的根本差异：**无常驻进程**——每条
 * `send` 都孵化一次引擎进程，跨请求记忆由引擎的会话档案承担（`--session`
 * 续跑 + 全量重放 + provider 前缀缓存）。会话归属由 Host 边车强制：只有
 * `create` 它的插件能 `send` / `history` 它。
 *
 * Node、DSH 与 reai-voice profile 随 App 分发；`status().available === false`
 * 表示安装包缺件或当前平台尚未交付该运行时。
 */

/** 引擎可用性。不可用时 `detail` 给行动建议。 */
export interface DshStatus {
  available: boolean;
  detail: string;
  /** 当前 Host OAuth 会话是否已登录。 */
  loggedIn: boolean;
  /** 该插件是否已同时通过 cloud.model.invoke@1 平台与用户同意两层门禁。 */
  modelAccess: boolean;
}

/** 一条回放条目（引擎档案的只读投影；工具卡投影后续版本扩展）。 */
export interface DshHistoryItem {
  role: "user" | "assistant";
  text: string;
}

/** 会话列表条目。 */
export interface DshSessionSummary {
  sessionId: string;
  title: string | null;
  /** 档案最后修改时间（unix ms）。 */
  updatedMs: number;
  /** 档案内最后一个回合的结论（`completed` / `error` / …；无回合时 null）。 */
  lastOutcome: string | null;
  /** profile 升级后旧会话只可列出/删除，必须新建会话才能继续发送。 */
  stale: boolean;
}

/** 回合失败形态。失败不自动重试——要不要重发是用户（插件 UI）的决定。 */
export type DshTurnFailure =
  | { kind: "engine"; stderr_tail: string }
  | { kind: "killed" }
  | { kind: "timeout" };

/** 一次回合的终局。 */
export interface DshSendResult {
  /** Host 实际采用的回合 id；调用方未传时由 Host 生成。 */
  turnId: string;
  /** 末条 assistant 文本（失败时 null）。 */
  text: string | null;
  failure: DshTurnFailure | null;
}

export interface DshAgentClient {
  status(): Promise<DshStatus>;
  /** 分配新会话 id（登记归属；不 spawn，首次 send 才建档）。 */
  createSession(): Promise<{ sessionId: string }>;
  /**
   * 发送一回合。长操作（模型多轮 + 工具执行），整回合终局由本调用的返回值
   * 给出。同一会话的并发请求在 Host 侧排队（串行），不同会话并行。
   */
  send(options: { sessionId: string; turnId?: string; text: string }): Promise<DshSendResult>;
  /** 取消指定回合；turnId 防止迟到的取消误伤下一轮。 */
  cancel(options: { sessionId: string; turnId: string }): Promise<{ cancelled: boolean }>;
  /** 会话历史（只读投影）。 */
  history(options: { sessionId: string }): Promise<{ items: DshHistoryItem[] }>;
  /** 名下会话列表（按更新时间倒序）。 */
  listSessions(): Promise<{ sessions: DshSessionSummary[] }>;
  /** 删除该插件拥有的会话档案与归属边车。 */
  deleteSession(options: { sessionId: string }): Promise<{ deleted: boolean }>;
}

/** 稳定错误码 → 上层小写码的纯查表。 */
export interface DshAgentErrorInfo {
  code:
    | "disabled"
    | "not_granted"
    | "invalid_request"
    | "session_stale"
    | "unavailable"
    | "unknown";
  retryable: boolean;
}

const DSH_ERROR_TABLE: Readonly<Record<string, DshAgentErrorInfo>> = {
  DSH_DISABLED: { code: "disabled", retryable: false },
  DSH_NOT_GRANTED: { code: "not_granted", retryable: false },
  DSH_INVALID_REQUEST: { code: "invalid_request", retryable: false },
  DSH_SESSION_STALE: { code: "session_stale", retryable: false },
  DSH_ENGINE_UNAVAILABLE: { code: "unavailable", retryable: true },
};

/** 认不出的码一律 `unknown` + 不可重试。 */
export function describeDshAgentError(code: string): DshAgentErrorInfo {
  return DSH_ERROR_TABLE[code] ?? { code: "unknown", retryable: false };
}
