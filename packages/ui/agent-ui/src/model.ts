export type AgentStatus = "wait" | "busy" | "idle" | "off";

export interface Card {
  type: "file" | "image" | "audio";
  icon?: string;
  name?: string;
  meta?: string;
  alt?: string;
  dur?: string;
}

export interface StreamDay { k: "day"; t: string }
export interface StreamMsg {
  k: "msg";
  me?: 1;
  text: string;
  ts: string;
  card?: Card;
  cards?: Card[];
  who?: string;
  ava?: string;
}
export interface StreamAnchor {
  k: "anchor";
  icon: string;
  title: string;
  meta: string;
  st: "done" | "run";
  since?: number;
  dir?: string;
  start?: 1;
}
export interface StreamWorkStep { t: string; d?: 1 }
export interface StreamWork { k: "work"; label: string; since: number; steps: StreamWorkStep[]; open?: string }
export interface StreamAsk {
  k: "ask";
  text: string;
  brief: string;
  opts: string[];
  no?: string;
  open?: string;
  answered?: string;
}
export type StreamItem = StreamDay | StreamMsg | StreamAnchor | StreamWork | StreamAsk;

export interface Member {
  ava: string;
  name: string;
  role: string;
  st: AgentStatus;
  id: string;
  self?: 1;
}
export interface Agent {
  id: string;
  kind: "agent";
  ava: string;
  name: string;
  tag?: string;
  tagLocal?: boolean;
  pinned?: 1;
  role?: string;
  status: AgentStatus;
  unread?: number;
  time: string;
  last: string;
  stream: StreamItem[];
}
export interface Group {
  id: string;
  kind: "group";
  ava?: string;
  name: string;
  tag: string;
  status: AgentStatus;
  time: string;
  muted?: boolean;
  last: string;
  members: Member[];
  stream: StreamItem[];
}
export type AgentOrGroup = Agent | Group;

export interface AgentTask {
  id: string;
  title: string;
  agentId: string;
  agentName: string;
  agentAva: string;
  anchor: StreamAnchor;
  anchorIndex: number;
  conversation: StreamItem[];
}

export const AGENT_STATUS_LABEL: Record<AgentStatus, [string, string]> = {
  wait: ["等你确认", "wait"],
  busy: ["工作中", "busy"],
  idle: ["空闲", "idle"],
  off: ["离线", "off"],
};
