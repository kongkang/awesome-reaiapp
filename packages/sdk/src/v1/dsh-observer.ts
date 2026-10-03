/** 官方 DSH 透明度插件专用窄合同（`agent.dsh-observe@1`）。 */

export type DshObserverRuntimeState =
  | "available"
  | "disabled"
  | "pending"
  | "incompatible"
  | "missing"
  | "unavailable";

export interface DshObserverRuntimeComponent {
  id: string;
  version: string;
  digest: string;
}

export interface DshObserverRuntime {
  state: DshObserverRuntimeState;
  code: string;
  detail: string;
  target: string;
  dshVersion: string | null;
  profileVersion: string | null;
  workspace: string | null;
  components: DshObserverRuntimeComponent[];
}

export interface DshObserverSourceApp {
  appId: string;
  name: string;
  iconDataUrl: string | null;
  installed: boolean;
  openable: boolean;
  unavailableReason: string | null;
}

export interface DshObserverOutcome {
  kind: string;
  status: string;
  summary: string | null;
  error: string | null;
}

export interface DshObserverNextAction {
  kind: string;
  label: string;
  enabled: boolean;
  reason: string | null;
}

export interface DshObserverSession {
  sessionId: string;
  agentSessionId: string | null;
  source: DshObserverSourceApp;
  title: string | null;
  status: string;
  currentTask: string | null;
  outcome: DshObserverOutcome | null;
  nextAction: DshObserverNextAction;
  updatedMs: number;
  createdMs: number | null;
  startedMs: number | null;
  durationMs: number | null;
  stale: boolean;
  orphan: boolean;
  turnCount: number;
  workspace: string;
  modelAlias: string | null;
  currentTurnId: string | null;
  configurationKnown: boolean;
}

export interface DshObserverSnapshot {
  schemaVersion: number;
  revision: number;
  runtime: DshObserverRuntime;
  sessions: DshObserverSession[];
}

export interface DshObserverSkill {
  id: string;
  title: string;
  digest: string | null;
}

export interface DshObserverTool {
  id: string;
  source: string;
  permission: string;
  available: boolean;
  reason: string | null;
}

export interface DshObserverSessionDetail {
  schemaVersion: number;
  revision: number;
  sessionRevision: number;
  sessionId: string;
  agentSessionId: string | null;
  source: DshObserverSourceApp;
  modelAlias: string | null;
  configurationKnown: boolean;
  systemPromptConfigured: boolean;
  systemPromptDigest: string | null;
  systemPromptChars: number | null;
  skills: DshObserverSkill[];
  tools: DshObserverTool[];
  currentTask: string | null;
  historyTruncated: boolean;
  diagnostics: {
    sessionId: string;
    agentSessionId: string | null;
    currentTurnId: string | null;
    workspace: string;
    profileVersion: string;
    dshVersion: string;
  };
}

export type DshObserverHistoryItem =
  | { kind: "user_message"; text: string; source: string; seq: number; time_ms: number }
  | { kind: "assistant_message"; text: string; seq: number; time_ms: number }
  | {
      kind: "tool_call";
      call_id: string;
      name: string;
      arguments: string;
      status: string;
      turn: number | null;
      step: number | null;
      seq: number;
      time_ms: number;
    }
  | {
      kind: "tool_result";
      call_id: string;
      content: string;
      status: string;
      error: string | null;
      turn: number | null;
      step: number | null;
      seq: number;
      time_ms: number;
    }
  | {
      kind: "lifecycle";
      event: string;
      status: string;
      summary: string | null;
      turn: number | null;
      step: number | null;
      seq: number;
      time_ms: number;
    };

export interface DshObserverHistoryPage {
  schemaVersion: number;
  revision: number;
  sessionRevision: number;
  sessionId: string;
  items: DshObserverHistoryItem[];
  cursor: string | null;
  nextCursor: string | null;
  historyTruncated: boolean;
}

export interface DshObserverModelOption {
  id: string;
  label: string;
  availability: "available" | "unavailable" | "unknown";
  reason: string | null;
}

export interface DshObserverSettings {
  selectedModel: string;
  options: DshObserverModelOption[];
}

export interface DshObserverClient {
  snapshot(): Promise<DshObserverSnapshot>;
  sessionDetail(sessionId: string): Promise<DshObserverSessionDetail>;
  historyPage(sessionId: string, cursor?: string, limit?: number): Promise<DshObserverHistoryPage>;
  settings(): Promise<DshObserverSettings>;
  updateSettings(modelAlias: string): Promise<DshObserverSettings>;
}
