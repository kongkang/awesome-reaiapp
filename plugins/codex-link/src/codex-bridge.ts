import { CodexMessageError } from "./codex-i18n";
/**
 * Codex bridge 客户端 —— 走宿主窄口 `agent.codex@1`。
 *
 * `codex.*` 方法不在 SDK 的 RequestMethod 字面量集合里（那是平台基础能力清单），
 * Codex 是第一个 agent 协议消费者。这里直接取 Host bootstrap 注入的 Bridge
 * 句柄（与 SDK runtime 同一个），把 method 串按需 cast 调用。Host 侧的
 * `bridge.rs` 在 `codex.*` 分发前已校验过 `agent.codex@1` 授予。
 */
import { BRIDGE_GLOBAL_KEY, type HostBridge, type RequestMethod } from "@reai/app-sdk/v1";

type AnyBridge = {
  request<T = unknown>(method: string, params: unknown): Promise<T>;
};

export type CodexReadMethod =
  | "codex.status"
  | "codex.account_read"
  | "codex.list_threads"
  | "codex.list_active_threads"
  | "codex.list_models"
  | "codex.list_skills"
  | "codex.attach"
  | "codex.detach"
  | "codex.drain_events"
  /** 告诉 Host「那条会话被打开了」（C-2 三处一体的回报口，不改 Codex 侧状态）。 */
  | "codex.conversation_opened";

/** 会改变 Codex 侧状态的方法；Host 对每条都做严格白名单校验。 */
export type CodexWriteMethod =
  | "codex.account_sync"
  | "codex.login_start"
  | "codex.login_cancel"
  | "codex.login_open"
  | "codex.start_thread"
  | "codex.start_turn"
  | "codex.steer_turn"
  | "codex.respond_approval"
  | "codex.interrupt_turn"
  | "codex.open_thread";

export type CodexMethod = CodexReadMethod | CodexWriteMethod;

function bridge(): HostBridge | undefined {
  const g = globalThis as unknown as Record<symbol, unknown>;
  const key = BRIDGE_GLOBAL_KEY as unknown as symbol;
  return g[key] as HostBridge | undefined;
}

/** 调一个 codex.* 窄口方法，等结果。 */
export async function codexCall<T = unknown>(
  method: CodexMethod,
  params: unknown = {},
): Promise<T> {
  const b = bridge();
  if (!b) {
    throw new CodexMessageError("errors.bridge");
  }
  // method 串 cast 成 RequestMethod 走类型系统——Host 侧按 method 名分发，类型集合是 SDK 内部的。
  return (b as unknown as AnyBridge).request<T>(method as RequestMethod, params);
}

/** 暴露给视图层用的回执记录。 */
export interface CallReceipt {
  method: CodexMethod;
  ok: boolean;
  detail?: unknown;
  at: number;
}
