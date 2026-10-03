import { bindText, bindAttribute, replaceChildren, t, type TextSource } from "./codex-i18n";
import type { CodexAccount } from "./codex-account";

/** Authorization is an operable card; the healthy account is a single heading label. */
export function renderAccount(
  session: HTMLElement,
  label: HTMLElement,
  card: HTMLElement,
  account: CodexAccount | undefined,
  busy = false,
  error?: TextSource,
): void {
  const hadFocus = card.contains(document.activeElement);
  const focusedAction = hadFocus
    ? (document.activeElement as HTMLElement).dataset.action : undefined;
  replaceChildren(card);
  card.hidden = true;
  session.hidden = false;
  if (!account) return; // Older Hosts keep their transport indicator.
  if (account.state === "signed-in") {
    const plan = account.account?.planType;
    if (hadFocus) session.querySelector<HTMLButtonElement>("button")?.focus();
    bindText(label, plan ? plan[0]!.toUpperCase() + plan.slice(1) : account.account?.type === "apiKey" ? "API" : "Codex");
    return;
  }
  if (account.state === "error") {
    bindText(label, () => t("account.readFailedRetry"));
    return;
  }
  if (account.requiresOpenaiAuth === false && account.state === "signed-out") {
    bindText(label, "Codex");
    return;
  }
  const pending = account.state === "signing-in" || account.state === "device-code";
  session.hidden = true;
  card.hidden = false;
  card.setAttribute("aria-busy", String(busy));
  const title = document.createElement("h2");
  title.id = "cx-auth-title";
  bindText(title, () => t(account.state === "device-code" ? "account.deviceTitle"
    : pending ? "account.browserTitle"
    : account.state === "login-error" ? "account.loginIncomplete" : "account.loginTitle"));
  const description = document.createElement("p");
  bindText(description, () => t(pending
    ? account.login?.browserOpened === false ? "account.browserOpenFailed" : "account.browserPending"
    : account.state === "login-error" ? "account.loginRetry"
    : "account.signInHint"));
  card.append(title, description);
  if (account.state === "device-code" && account.login?.userCode) {
    const code = document.createElement("div");
    code.className = "cx-auth-code";
    bindAttribute(code, "aria-label", () => t("account.deviceCode"));
    code.tabIndex = 0;
    code.textContent = account.login.userCode;
    card.append(code);
  }
  if (error) {
    const message = document.createElement("p");
    message.setAttribute("role", "alert");
    bindText(message, error);
    card.append(message);
  }
  const actions = document.createElement("div");
  actions.className = "cx-auth-actions";
  const add = (text: TextSource, action: string, primary = false) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = primary ? "cx-auth-primary" : "cx-auth-secondary";
    button.dataset.action = action;
    button.disabled = busy;
    bindText(button, text);
    actions.append(button);
  };
  if (pending) {
    add(() => t("account.openPage"), "login-open", true);
    add(() => t("account.cancel"), "login-cancel");
  } else {
    add(() => t("account.signInChatGPT"), "login-browser", true);
    add(() => t("account.useDeviceCode"), "login-device");
  }
  add(() => t("account.refreshState"), "refresh");
  card.append(actions);
  if (hadFocus) {
    const buttons = Array.from(actions.querySelectorAll("button"));
    const next = buttons.find(button => button.dataset.action === focusedAction && !button.disabled)
      ?? buttons.find(button => !button.disabled);
    card.tabIndex = -1;
    (next ?? card).focus();
  }
}
