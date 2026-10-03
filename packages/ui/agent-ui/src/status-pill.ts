import { element } from "./dom";
import { createAgentUiI18n, type AgentUiI18n } from "./i18n";
import type { AgentStatus } from "./model";

export interface StatusPillOptions {
  /**
   * 注入后状态文案读 `agentUi.status.<status>` 并随实例语言更新；
   * 缺省时沿用内置中文（与 model.ts 的 AGENT_STATUS_LABEL 逐字一致）。
   */
  i18n?: AgentUiI18n;
}

export function createStatusPill(status: AgentStatus, options: StatusPillOptions = {}): HTMLSpanElement {
  const pill = element("span", `agent-status-pill is-${status}`);
  const i18n = options.i18n ?? createAgentUiI18n();
  i18n.bindText(pill, () => i18n.t(`agentUi.status.${status}`));
  return pill;
}
