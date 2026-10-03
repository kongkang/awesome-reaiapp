import { expect, test } from "bun:test";
import { defineApp, type LocaleSnapshot } from "@reai/app-sdk/v1";
import { MockHost } from "../src/v1/index";

test("MockHost supplies explicit initial UI language and live changes without permissions", async () => {
  const seen: LocaleSnapshot[] = [];
  const host = new MockHost({
    manifest: { appId: "com.example.locale" }, locale: "en",
    loadApp: async () => ({ default: defineApp({ activate(ctx) {
      ctx.locale.onChange((snapshot) => seen.push(snapshot));
    } }) }),
  });
  try {
    await host.installAndEnable();
    expect(seen).toEqual([{ locale: "en", revision: 0 }]);
    host.setLocale("zh");
    host.setLocale("zh");
    expect(seen).toEqual([{ locale: "en", revision: 0 }, { locale: "zh", revision: 1 }]);
  } finally { await host.disable(); }
});

test("MockHost default is deterministic Chinese and cleanup removes locale listeners", async () => {
  const seen: LocaleSnapshot[] = [];
  const host = new MockHost({
    manifest: { appId: "com.example.locale" },
    loadApp: async () => ({ default: defineApp({ activate(ctx) {
      ctx.locale.onChange((snapshot) => seen.push(snapshot));
    } }) }),
  });
  await host.installAndEnable();
  await host.disable();
  host.setLocale("en");
  expect(seen).toEqual([{ locale: "zh", revision: 0 }]);
});
