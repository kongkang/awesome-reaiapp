import { expect, test } from "bun:test";
import { withVoiceRefreshDeadline } from "../src/voice-refresh-deadline";

test("a stalled status member fails in finite time; late completion cannot publish success", async () => {
  let complete!: (value: string) => void;
  const stalled = new Promise<string>(resolve => { complete = resolve; });
  const published: string[] = [];
  const run = withVoiceRefreshDeadline(() => Promise.all([Promise.resolve("ready"), stalled]), 10)
    .then(value => published.push(value.join()), () => published.push("failed"));
  await run;
  expect(published).toEqual(["failed"]);
  complete("late");
  await Promise.resolve();
  await Promise.resolve();
  expect(published).toEqual(["failed"]);
  expect(await withVoiceRefreshDeadline(async () => "fresh", 10)).toBe("fresh");
});

test("refresh preserves the real rejection and does not manufacture ready data", async () => {
  const error = new Error("permission unavailable");
  await expect(withVoiceRefreshDeadline(() => Promise.reject(error), 10)).rejects.toBe(error);
});
