import { t } from "./i18n";
import type { ReasoningEffort } from "./capability-state";
import type { CodexTurnMode } from "./turn-mode";
import { buildThreadDetail } from "./thread-state";

interface TurnClient {
  resumeThread(threadId: string): Promise<unknown>;
  readThread(threadId: string): Promise<unknown>;
  startTurn(options: {
    threadId: string;
    input: Array<{ type: "text"; text: string }>;
    model?: string;
    effort?: ReasoningEffort;
    mode?: CodexTurnMode;
  }): Promise<unknown>;
  steerTurn(options: {
    threadId: string;
    expectedTurnId: string;
    input: Array<{ type: "text"; text: string }>;
  }): Promise<unknown>;
  interruptTurn(threadId: string, turnId: string): Promise<void>;
}

export interface SendThreadOptions {
  threadId: string;
  text: string;
  loaded: boolean;
  detail?: unknown;
  model?: string;
  effort?: ReasoningEffort;
  mode?: CodexTurnMode;
}

/**
 * 历史线程必须先恢复到当前 app-server 进程；活动 turn 只能 steer，不能并发 start。
 * 这个函数不重试任何写请求，调用方可以在失败后保留草稿并让用户明确重试。
 */
export async function sendThreadMessage(
  client: TurnClient,
  options: SendThreadOptions,
): Promise<{ kind: "start" | "steer"; detail: unknown }> {
  let detail = options.detail;
  if (!options.loaded) {
    await client.resumeThread(options.threadId);
    detail = await client.readThread(options.threadId);
  } else if (!detail) {
    detail = await client.readThread(options.threadId);
  }
  const state = buildThreadDetail(detail, undefined);
  const input = [{ type: "text" as const, text: options.text }];
  if (state.running) {
    if (!state.activeTurnId) throw new Error(t("ui.m153"));
    await client.steerTurn({
      threadId: options.threadId,
      expectedTurnId: state.activeTurnId,
      input,
    });
    return { kind: "steer", detail };
  }
  await client.startTurn({
    threadId: options.threadId,
    input,
    ...(options.model ? { model: options.model } : {}),
    ...(options.effort ? { effort: options.effort } : {}),
    ...(options.mode ? { mode: options.mode } : {}),
  });
  return { kind: "start", detail };
}

export async function interruptActiveTurn(
  client: Pick<TurnClient, "resumeThread" | "readThread" | "interruptTurn">,
  threadId: string,
  detail: unknown,
  loaded = true,
): Promise<void> {
  let currentDetail = detail;
  if (!loaded) {
    await client.resumeThread(threadId);
    currentDetail = await client.readThread(threadId);
  }
  const activeTurnId = buildThreadDetail(currentDetail, undefined).activeTurnId;
  if (!activeTurnId) throw new Error(t("ui.m154"));
  await client.interruptTurn(threadId, activeTurnId);
}
