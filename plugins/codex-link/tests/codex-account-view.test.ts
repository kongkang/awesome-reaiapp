import { afterAll, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { renderAccount } from "../src/codex-account-view";
import { mountCodexView } from "../src/codex-view";

let ownsDom = false;
beforeAll(() => { if (typeof document === "undefined") { GlobalRegistrator.register(); ownsDom = true; } });
afterAll(() => { if (ownsDom) GlobalRegistrator.unregister(); });

test("authorization keeps one operable card; successful login removes it and only shows the plan", () => {
  const session = document.createElement("div");
  const label = document.createElement("span");
  const card = document.createElement("section");
  session.append(label);
  renderAccount(session, label, card, { state: "signed-out", requiresOpenaiAuth: true });
  expect(card.hidden).toBe(false);
  expect(session.hidden).toBe(true);
  expect(card.querySelector('[data-action="login-browser"]')?.textContent).toBe("使用 ChatGPT 登录");
  renderAccount(session, label, card, { state: "device-code", requiresOpenaiAuth: true, login: { state: "pending", mode: "deviceCode", loginId: "one", userCode: "ABCD-1234" } });
  expect(card.querySelector(".cx-auth-code")?.textContent).toBe("ABCD-1234");
  expect(card.querySelector('[data-action="login-cancel"]')).not.toBeNull();
  renderAccount(session, label, card, { state: "signed-in", account: { type: "chatgpt", planType: "pro" } });
  expect(card.hidden).toBe(true);
  expect(card.childElementCount).toBe(0);
  expect(session.hidden).toBe(false);
  expect(label.textContent).toBe("Pro");
});

test("read failure is retryable and never falsely offers a fresh sign-in", () => {
  const session = document.createElement("div");
  const label = document.createElement("span");
  const card = document.createElement("section");
  renderAccount(session, label, card, { state: "error" });
  expect(session.hidden).toBe(false);
  expect(card.hidden).toBe(true);
  expect(label.textContent).toContain("读取失败");
});

test("real view routes login/cancel commands once and refreshes the resulting account state", async () => {
  const root = document.createElement("div");
  let login: any = null;
  let starts = 0;
  const values = new Map<string, unknown>();
  const view = mountCodexView(root, {
    pollIntervalMs: 0,
    store: { async get<T>(key: string) { return values.get(key) as T | undefined; }, async set(key: string, value: unknown) { values.set(key, value); }, async delete(key: string) { values.delete(key); }, async keys() { return [...values.keys()]; } },
    call: async <T>(method: string, params?: any): Promise<T> => {
      if (method === "codex.status") return { connected: true, features: { thread_state_v1: true, account_v1: true } } as T;
      if (method === "codex.account_read") return { account: null, requiresOpenaiAuth: true, login } as T;
      if (method === "codex.login_start") {
        starts++;
        await Promise.resolve();
        login = { state: "pending", loginId: "current", mode: params.mode, userCode: "ABCD-1234" };
      }
      if (method === "codex.login_cancel") {
        expect(params.loginId).toBe("current");
        login = null;
      }
      return { data: [] } as T;
    },
  });
  try {
    await view.refresh();
    const start = root.querySelector<HTMLButtonElement>('[data-action="login-device"]')!;
    start.click();
    start.click();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(starts).toBe(1);
    expect(root.querySelector(".cx-auth-code")?.textContent).toBe("ABCD-1234");
    root.querySelector<HTMLButtonElement>('[data-action="login-cancel"]')!.click();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(root.querySelector('[data-action="login-browser"]')).not.toBeNull();
    expect(root.querySelector(".cx-auth-code")).toBeNull();
  } finally { view.dispose(); }
});
