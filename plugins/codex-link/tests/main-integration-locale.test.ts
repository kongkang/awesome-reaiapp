import { afterEach, afterAll, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { mountCodexView } from "../src/codex-view";
import { renderAccount } from "../src/codex-account-view";
import { releaseLocaleBindings, setCodexLocale } from "../src/codex-i18n";

let ownsDom = false;
beforeAll(() => { if (typeof document === "undefined") { GlobalRegistrator.register(); ownsDom = true; } });
afterEach(() => setCodexLocale("zh"));
afterAll(() => { if (ownsDom) GlobalRegistrator.unregister(); });

test("merged account, history and Skills controls change locale without doing account or pagination work", async () => {
  const root = document.createElement("div"); document.body.append(root);
  let language = "zh"; const listeners = new Set<(value: { locale: string }) => void>();
  const calls: string[] = [];
  const view = mountCodexView(root, {
    locale: { getSnapshot: () => ({ locale: language }), onChange: listener => { listeners.add(listener); return () => listeners.delete(listener); } },
    pollIntervalMs: 0,
    call: async <T>(method: string): Promise<T> => {
      calls.push(method);
      if (method === "codex.status") return { connected: true, features: { thread_state_v1: true, account_v1: true }, threads: [] } as T;
      if (method === "codex.account_read") return { account: null, requiresOpenaiAuth: true, login: { state: "pending", mode: "deviceCode", loginId: "raw-id", userCode: "原文-ABCD", browserOpened: false } } as T;
      if (method === "codex.list_threads") return { data: [{ id: "raw-thread", name: "原始任务标题", cwd: "/原始目录", updatedAt: 1_800_000_000 }], nextCursor: "raw-next-page" } as T;
      if (method === "codex.list_skills") throw new Error("raw server detail");
      return { data: [] } as T;
    },
  });
  try {
    await view.refresh();
    const card = root.querySelector<HTMLElement>(".cx-auth-card")!;
    const button = card.querySelector<HTMLButtonElement>('[data-action="login-cancel"]')!;
    const title = card.querySelector("h2")!;
    const code = card.querySelector(".cx-auth-code")!;
    button.focus(); card.scrollTop = 31;
    const baseline = calls.length;
    language = "en"; listeners.forEach(listener => listener({ locale: language }));
    expect(title.textContent).toBe("Authorize with a device code");
    expect(card.textContent).toContain("The browser could not be opened. Try the button below.");
    expect(button.textContent).toBe("Cancel sign-in");
    expect(code.getAttribute("aria-label")).toBe("Device authorization code");
    expect(code.textContent).toBe("原文-ABCD");
    expect(root.querySelector('[data-action="load-more"]')?.textContent).toBe("Load more conversations");
    expect(root.querySelector('[data-action="pick-skills-folder"]')?.textContent).toBe("Add a Skill folder…");
    expect(root.textContent).toContain("Skills could not be read. Retry or select another directory.");
    expect(root.querySelector('.cx-side-head [data-action="refresh-skills"]')?.getAttribute("aria-label")).toBe("Refresh Skills");
    expect(card.querySelector("h2")).toBe(title); expect(card.querySelector('[data-action="login-cancel"]')).toBe(button);
    expect(document.activeElement).toBe(button); expect(card.scrollTop).toBe(31); expect(calls.length).toBe(baseline);
    language = "zh"; listeners.forEach(listener => listener({ locale: language }));
    expect(title.textContent).toBe("使用设备码授权"); expect(calls.length).toBe(baseline);
  } finally { view.dispose(); root.remove(); }
  expect(listeners.size).toBe(0);
});

test("account feedback retains explicit source and raw server text while labels translate", () => {
  const session = document.createElement("div"), label = document.createElement("span"), card = document.createElement("section");
  session.append(label); document.body.append(session, card);
  try {
    renderAccount(session, label, card, { state: "login-error", requiresOpenaiAuth: true }, false, "登录未完成");
    const raw = card.querySelector('[role="alert"]')!;
    setCodexLocale("en");
    expect(card.querySelector("h2")?.textContent).toBe("Sign-in incomplete");
    expect(raw.textContent).toBe("登录未完成");
    expect(card.querySelector('[data-action="login-browser"]')?.textContent).toBe("Sign in with ChatGPT");
    renderAccount(session, label, card, { state: "error" });
    expect(label.textContent).toBe("Account could not be read · Retry");
  } finally { releaseLocaleBindings(session); releaseLocaleBindings(card); session.remove(); card.remove(); }
});
