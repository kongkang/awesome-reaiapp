import { expect, test } from "bun:test";
import { preferenceWriter, readPreferences } from "../src/preferences";
test("missing preferences use defaults, corrupt or future records never silently reset", () => {
  expect(readPreferences(undefined).limits.worker).toBe(10);
  for (const value of [[], {}, { version: 2, limits: { worker: 1 } }, { version: 1, limits: { worker: -1, tester: 1, orchestrator: 1 } }]) expect(() => readPreferences(value)).toThrow();
});
test("pending saves retain their own snapshot and a failed write does not block later ones", async () => {
  let release!: () => void, attempt = 0;
  const seen: number[] = [];
  const save = preferenceWriter(async record => { seen.push(record.limits.worker); if (++attempt === 1) { await new Promise<void>(resolve => { release = resolve; }); throw new Error("disk"); } });
  const limits = { worker: 7, tester: 6, orchestrator: 3 };
  const first = save(limits).catch(() => undefined); limits.worker = 9;
  const second = save(limits); await Promise.resolve(); expect(seen).toEqual([7]);
  release(); await first; await second; expect(seen).toEqual([7, 9]);
});
