import { describe, expect, test } from "bun:test";

import { normalizeAccountSnapshot } from "../src/account-state";

describe("Codex App 账号状态恢复", () => {
  test("官方 account/read 的 ChatGPT 快照恢复为已登录", () => {
    expect(
      normalizeAccountSnapshot({
        account: {
          type: "chatgpt",
          email: "person@example.com",
          planType: "plus",
        },
        requiresOpenaiAuth: true,
      }),
    ).toEqual({
      logged: true,
      summary: { plan: "plus", email: "person@example.com" },
    });
  });

  test("账号存在但 email 缺失时仍是已登录，不得再次弹登录", () => {
    expect(
      normalizeAccountSnapshot({ account: { type: "apiKey" } }),
    ).toEqual({
      logged: true,
      summary: { plan: "API Key" },
    });
  });

  test("只有 account 明确为空才判定未登录", () => {
    expect(
      normalizeAccountSnapshot({ account: null, requiresOpenaiAuth: true }),
    ).toEqual({ logged: false });
  });
});

test("only generated subscription fallback changes with locale", async () => {
  const { setLocale, resolveText } = await import("../src/i18n");
  const generated = normalizeAccountSnapshot({ account: { type: "chatgpt" } });
  const supplied = normalizeAccountSnapshot({ account: { type: "chatgpt", planType: "ChatGPT 订阅" } });
  try {
    setLocale("en");
    expect(resolveText(generated.summary!.plan)).toBe("ChatGPT subscription");
    expect(resolveText(supplied.summary!.plan)).toBe("ChatGPT 订阅");
  } finally { setLocale("zh"); }
});
