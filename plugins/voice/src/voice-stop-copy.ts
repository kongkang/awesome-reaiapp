import { t } from "./voice-i18n";
import { BUILTIN_VOICE_COMMANDS } from "./voice-ai-contract";

/**
 * 停止 / 已停止的文案按场景说（负责人 2026-09-27：翻译进行中不该写「停止回答」）。
 *
 * 判断翻译条目以 #944 修正后的方式为准：历史与运行记录里存的是**内置命令 ID**
 * （`voice.command.translate`），不是 Host 事件 ID（`com.reai.voice.command.translate`）。
 */
export function isTranslationCommand(commandId: string | undefined): boolean {
  return commandId === BUILTIN_VOICE_COMMANDS.translate;
}

/** 页头停止钮：「停止翻译」/「停止回答」。 */
export function stopActionLabel(commandId: string | undefined): string {
  return t(isTranslationCommand(commandId) ? "chat.stopTranslation" : "chat.stopAnswer");
}

/** 停止请求被拒：「无法停止翻译，请重试」/「无法停止回答，请重试」。 */
export function stopFailedLabel(commandId: string | undefined): string {
  return t(isTranslationCommand(commandId) ? "chat.stopTranslationFailed" : "chat.stopAnswerFailed");
}

/** 命令类型 → 诊断步骤键（`diagnostics.step.*`）。 */
export function commandStepKey(commandId: string | undefined): string {
  switch (commandId) {
    case BUILTIN_VOICE_COMMANDS.translate: return "translate";
    case BUILTIN_VOICE_COMMANDS.agent: return "agent";
    case BUILTIN_VOICE_COMMANDS.transcribe: return "transcribe";
    default: return "command";
  }
}

/**
 * 不是用户点的停止、而是处理过程中 Voice 被关闭 / 重启：说「已中断」，不说成「已停止」
 * （§6.0：失败与中断不能改写成更模糊的「已取消 / 已停止」）。
 */
export function interruptedLabel(commandId: string | undefined): string {
  return t(isTranslationCommand(commandId) ? "chat.translationInterrupted" : "chat.answerInterrupted");
}

/** 用户点了停止之后的结果：「已停止翻译」/「已停止回答」。 */
export function stoppedLabel(commandId: string | undefined): string {
  return t(isTranslationCommand(commandId) ? "chat.translationStopped" : "chat.answerStopped");
}
