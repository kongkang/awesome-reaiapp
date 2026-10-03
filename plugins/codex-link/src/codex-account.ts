import { CodexMessageError } from "./codex-i18n";
/** Public account metadata only. Tokens and browser OAuth URLs stay in the Host/app-server. */
export interface CodexLogin {
  loginId: string;
  mode: "browser" | "deviceCode";
  state: "pending" | "failed" | "unknown";
  userCode?: string;
  browserOpened?: boolean;
}

export interface CodexAccountResponse {
  account: { type: string; planType?: string } | null;
  requiresOpenaiAuth: boolean;
  login?: CodexLogin | null;
}

export interface CodexAccount extends Partial<CodexAccountResponse> {
  state: "signed-in" | "signed-out" | "signing-in" | "device-code" | "login-error" | "error";
}

export function accountSnapshot(value: CodexAccountResponse): CodexAccount {
  if (!value || typeof value.requiresOpenaiAuth !== "boolean") throw new CodexMessageError("account.cannotRead");
  const state = value.account ? "signed-in"
    : value.login?.state === "pending" ? value.login.mode === "deviceCode" ? "device-code" : "signing-in"
    : value.login ? "login-error" : "signed-out";
  return { ...value, state };
}
