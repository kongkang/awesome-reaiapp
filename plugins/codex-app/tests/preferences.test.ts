import { describe, expect, test } from "bun:test";

import { loadPreferences, savePreferences } from "../src/preferences";

describe("Codex App 私有偏好存储", () => {
  test("只接受版本化的 model/effort，不恢复损坏或越界数据", async () => {
    const store = {
      value: { schemaVersion: 1, model: "gpt-real", effort: "high" } as unknown,
      async get() { return this.value; },
      async set(_key: string, value: unknown) { this.value = value; },
    };
    expect(await loadPreferences(store)).toEqual({ model: "gpt-real", effort: "high", mode: "plan" });
    store.value = { schemaVersion: 99, model: "bad", effort: "future" } as never;
    expect(await loadPreferences(store)).toBeUndefined();
  });

  test("写入固定 schemaVersion，重启后可恢复", async () => {
    let saved: unknown;
    const store = {
      async get() { return saved; },
      async set(_key: string, value: unknown) { saved = value; },
    };
    await savePreferences(store, { model: "gpt-real", effort: "medium", mode: "yolo" });
    expect(saved).toEqual({ schemaVersion: 2, model: "gpt-real", effort: "medium", mode: "yolo" });
    expect(await loadPreferences(store)).toEqual({ model: "gpt-real", effort: "medium", mode: "yolo" });
  });

  test("mode 越界值回落 plan，合法三值原样保留", async () => {
    let saved: unknown = { schemaVersion: 2, model: "gpt-real", effort: "high", mode: "turbo" };
    const store = {
      async get() { return saved; },
      async set(_key: string, value: unknown) { saved = value; },
    };
    expect(await loadPreferences(store)).toEqual({ model: "gpt-real", effort: "high", mode: "plan" });
    for (const mode of ["chat", "plan", "yolo"] as const) {
      saved = { schemaVersion: 2, model: "gpt-real", effort: "high", mode };
      expect((await loadPreferences(store))?.mode).toBe(mode);
    }
  });
});
