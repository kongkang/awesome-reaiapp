import { message, type LocalizedText } from "./i18n";
export interface AccountSummary {
  plan: LocalizedText;
  email?: string;
}

export interface NormalizedAccountSnapshot {
  logged: boolean;
  summary?: AccountSummary;
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;

/**
 * 把官方 app-server 的 account/read 快照收口成 UI 状态。
 *
 * `account` 对象是否存在才是登录真值；email 只是 ChatGPT 账号的可选展示字段，
 * 不能拿它当登录哨兵（API Key 账号和未来收窄字段的响应都可能没有 email）。
 */
export function normalizeAccountSnapshot(payload: unknown): NormalizedAccountSnapshot {
  const root = record(payload);
  if (!root) return { logged: false };

  const nested = record(root.account);
  const account = nested ?? (typeof root.type === "string" ? root : undefined);
  if (!account) return { logged: false };

  const type = typeof account.type === "string" ? account.type : "";
  const email = typeof account.email === "string" ? account.email : undefined;
  const planType =
    typeof account.planType === "string" ? account.planType : undefined;
  const plan = planType ?? (type === "apiKey" ? "API Key" : message("ui.chatgptSubscription"));

  return {
    logged: true,
    summary: email ? { plan, email } : { plan },
  };
}
