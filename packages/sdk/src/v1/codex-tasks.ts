export type CodexRuntimeInstallState =
  | "managed"
  | "bundled"
  | "development-override"
  | "missing";

/** 输入框三模式：chat 只读对话；plan 工作区可写+逐项审批；yolo 全自动。 */
export type CodexTurnMode = "chat" | "plan" | "yolo";

export interface CodexRuntimeStatus {
  running: boolean;
  profile: "owned-isolated";
  runtimeVersion: string;
  /** 便宜的安装完整性快照；权威判定在请求真正执行时（含 SHA-256 校验）。 */
  installState?: CodexRuntimeInstallState;
}

export interface CodexLoginStartResult {
  loginId: string;
  mode: "browser" | "deviceCode";
  browserOpened?: boolean;
  verificationUrl?: string;
  userCode?: string;
}

export interface CodexTaskEventPage {
  events: unknown[];
  malformedCount: number;
}

export interface CodexFileHandoff {
  token: string;
  expiresAt: number;
}

export interface CodexTasksClient {
  status(): Promise<CodexRuntimeStatus>;
  account(): Promise<unknown>;
  rateLimits(): Promise<unknown>;
  usage(): Promise<unknown>;
  startLogin(mode?: "browser" | "deviceCode"): Promise<CodexLoginStartResult>;
  cancelLogin(loginId: string): Promise<void>;
  logout(): Promise<void>;
  listModels(): Promise<unknown>;
  listSkills(cwds?: string[]): Promise<unknown>;
  listThreads(options?: { limit?: number; cursor?: string }): Promise<unknown>;
  readThread(threadId: string): Promise<unknown>;
  startThread(cwd: string): Promise<unknown>;
  resumeThread(threadId: string): Promise<unknown>;
  archiveThread(threadId: string): Promise<unknown>;
  nameThread(threadId: string, name: string): Promise<void>;
  startTurn(options: {
    threadId: string;
    input: Array<{ type: "text"; text: string }>;
    model?: string;
    effort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
    mode?: CodexTurnMode;
  }): Promise<unknown>;
  steerTurn(options: {
    threadId: string;
    expectedTurnId: string;
    input: Array<{ type: "text"; text: string }>;
  }): Promise<unknown>;
  interruptTurn(threadId: string, turnId: string): Promise<void>;
  respondApproval(options: {
    requestId: number;
    decision: "approved" | "denied";
    reason?: string;
  }): Promise<void>;
  respondUserInput(requestId: number, answers: Record<string, string[]>): Promise<void>;
  drainEvents(): Promise<CodexTaskEventPage>;
  conversationOpened(threadId: string): Promise<void>;
  createFileHandoff(threadId: string, path: string): Promise<CodexFileHandoff>;
}
