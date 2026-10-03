import { expect, test } from "bun:test";
import { sanitizeAgentUsage } from "../src/agent-metadata";

test("usage is copied and only complete safe provider counts retain the total", () => {
  const raw = { complete: true, inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  const snapshot = sanitizeAgentUsage(raw);
  expect(snapshot).toEqual(raw);
  raw.totalTokens = 9;
  expect(snapshot!.totalTokens).toBe(0);
  for (const value of [NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    expect(sanitizeAgentUsage({ complete: true, inputTokens: value, outputTokens: 1, totalTokens: 1 })?.totalTokens).toBeUndefined();
  }
  expect(sanitizeAgentUsage({ complete: true, inputTokens: 1, outputTokens: 1, totalTokens: 3 }))
    .toEqual({ complete: false, inputTokens: 1, outputTokens: 1 });
  expect(sanitizeAgentUsage({ totalTokens: 10 })).toBeUndefined();
  expect(sanitizeAgentUsage(null)).toBeUndefined();
});
