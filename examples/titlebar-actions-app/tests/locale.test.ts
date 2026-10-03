import { expect, test } from "bun:test";
import { createMessages } from "../src/i18n";
import zh from "../src/locales/zh.json";
import en from "../src/locales/en.json";
import { createCoreContext, translate } from "@intlify/core-base";

test("old plugin context without locale keeps the historical Chinese default", () => {
  const messages = createMessages();
  let rendered = "";
  const stop = messages.subscribe(() => { rendered = messages.t("idle"); });
  expect(rendered).toBe(zh.idle);
  stop();
});

test("example resources are complete and nonempty in both languages", () => {
  expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort());
  for (const key of Object.keys(en) as Array<keyof typeof en>) {
    expect(en[key].trim().length).toBeGreaterThan(0);
    expect(zh[key].trim().length).toBeGreaterThan(0);
  }
});

test("example Intlify setup supports nested interpolation and fallback under CSP", () => {
  const originalFunction = globalThis.Function;
  const originalEval = globalThis.eval;
  try {
    globalThis.Function = (() => { throw new Error("CSP forbids Function"); }) as unknown as FunctionConstructor;
    globalThis.eval = (() => { throw new Error("CSP forbids eval"); }) as typeof eval;
    expect(createMessages().t("idle")).toBe(zh.idle);
    const context = createCoreContext({ locale: "zh", fallbackLocale: "en", messages: { zh: {}, en: { status: { message: "Hello {name}" } } }, missingWarn: false, fallbackWarn: false });
    expect(translate<typeof context>(context, "status.message", { name: "reader" })).toBe("Hello reader");
  } finally { globalThis.Function = originalFunction; globalThis.eval = originalEval; }
});
