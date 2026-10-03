/** 官方 Pi Agent 管理插件专用合同（`agent.pi-management@1`）。 */

export type PiTurnState = "idle" | "queued" | "preparing" | "active";

export interface PiManagementSkill {
  id: string;
  title: string;
  digest: string;
}

export interface PiManagementSession {
  sessionId: string;
  appId: string;
  appName: string;
  title: string;
  status: PiTurnState;
  temporary: boolean;
  createdMs: number;
  updatedMs: number;
  model: string;
  workspace: string;
  directory: string;
  systemPrompt?: string;
  skills?: PiManagementSkill[];
  tools?: string[];
  mcp?: string[];
  memory: "session" | "one-shot";
}

export interface PiManagementSessionDetail {
  sessionId: string;
  systemPrompt: string;
  skills: PiManagementSkill[];
  tools: string[];
  mcp: string[];
}

export interface PiManagementTurn {
  key: string;
  appId: string;
  logicalSessionId?: string;
  turnId?: string;
  state: PiTurnState;
  summary: string;
  startedMs: number;
  temporary: boolean;
}

export interface PiManagementSettings {
  defaultModel: string;
  appOverrides: Record<string, string>;
}

export interface PiManagementModel {
  id: string;
  label: string;
  verified: boolean;
  selectable: boolean;
}

export interface PiManagementSnapshot {
  runtime: { state: string; detail?: string; scope: "app-bundled" };
  turns: PiManagementTurn[];
  sessions: PiManagementSession[];
  settings: PiManagementSettings;
}

export interface PiManagementClient {
  snapshot(): Promise<PiManagementSnapshot>;
  session(sessionId: string): Promise<PiManagementSessionDetail>;
  models(): Promise<{
    models: PiManagementModel[];
    settings: PiManagementSettings;
    loggedIn: boolean;
  }>;
  updateSettings(settings: PiManagementSettings): Promise<PiManagementSettings>;
}
