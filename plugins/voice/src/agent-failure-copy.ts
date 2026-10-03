import { agentExitCode, agentStageCode, isAgentFailureStage, type AgentStageCode } from "./agent-failure-stage";
import { t } from "./voice-i18n";

/**
 * Agent 阶段 / 上游码的本地化文案（2.14.2）。与解析器分开：解析器被错误字段采集层引用，
 * 不能反过来依赖 i18n（否则 voice-i18n → voice-error-fields → 解析器 → voice-i18n 成环）。
 */

/**
 * 上游码 → 一句人话：只列 Host 在方括号里补带、且与「怎么恢复」直接相关的几个；其余上游码交回既有分类
 * （登录 / 额度 / 权限等已有带恢复动作的文案），分类不出再按阶段说。只认解析器产出的对象（按出身）。
 */
export function agentUpstreamReason(stage: unknown): { reason: string; later: boolean } | undefined {
  if (!isAgentFailureStage(stage)) return undefined;
  switch (stage.upstreamCode) {
    case "AI_RATE_LIMITED": return { reason: t("errors.agentStage.rateLimited"), later: true };
    case "AI_STREAM_LOST": return { reason: t("errors.agentStage.streamLost"), later: false };
    default: return undefined;
  }
}

/** 阶段码 → 主句文案键（登记表每一项都要有，漏了类型检查不过）。 */
const STAGE_REASON_KEYS: Readonly<Record<AgentStageCode, string>> = {
  DSH_ENGINE_SPAWN_FAILED: "errors.agentStage.spawnFailed",
  DSH_ENGINE_SETUP_FAILED: "errors.agentStage.setupFailed",
  DSH_ENGINE_EXITED: "errors.agentStage.exitedNoCode",
  DSH_ENGINE_EMPTY_REPLY: "errors.agentStage.emptyReply",
  DSH_ENGINE_WAIT_FAILED: "errors.agentStage.waitFailed",
};

/** 阶段 → 一句人话（插件固定文案；唯一插值是 i32 范围内的整数退出码）。只认解析器产出的对象（按出身）。 */
export function agentStageReason(stage: unknown): string | undefined {
  if (!isAgentFailureStage(stage)) return undefined;
  const exitCode = agentExitCode(stage.exitCode);
  if (stage.agentStage === "DSH_ENGINE_EXITED" && exitCode !== undefined) return t("errors.agentStage.exited", { exitCode });
  return t(STAGE_REASON_KEYS[stage.agentStage]);
}

/** 诊断里阶段码旁边的本地化名称（按值查登记表，外部值不认）。 */
export function agentStageLabel(value: unknown): string | undefined {
  const stage = agentStageCode(value);
  return stage ? t(`diagnostics.agentStageName.${stage}`) : undefined;
}
