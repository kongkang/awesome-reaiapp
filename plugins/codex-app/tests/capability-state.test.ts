import { describe, expect, test } from "bun:test";

import {
  chooseModelSelection,
  normalizeModels,
  normalizeUsageSnapshot,
} from "../src/capability-state";

describe("Codex App 官方模型与用量", () => {
  const payload = {
    data: [
      {
        id: "hidden",
        model: "hidden",
        displayName: "Hidden",
        hidden: true,
        supportedReasoningEfforts: [],
      },
      {
        id: "gpt-real",
        model: "gpt-real",
        displayName: "GPT Real",
        isDefault: true,
        defaultReasoningEffort: "high",
        supportedReasoningEfforts: [
          { reasoningEffort: "medium", description: "均衡" },
          { reasoningEffort: "high", description: "深入" },
          { reasoningEffort: "future", description: "Host 尚不支持" },
        ],
      },
    ],
  };

  test("只展示 model/list 明确可用且 Host 支持的值", () => {
    expect(normalizeModels(payload)).toEqual([
      {
        id: "gpt-real",
        displayName: "GPT Real",
        isDefault: true,
        defaultEffort: "high",
        efforts: [
          { value: "medium", label: "medium", description: "均衡" },
          { value: "high", label: "high", description: "深入" },
        ],
      },
    ]);
  });

  test("持久选择失效时回落官方默认模型和默认 effort", () => {
    expect(
      chooseModelSelection(normalizeModels(payload), {
        model: "removed-model",
        effort: "low",
      }),
    ).toEqual({ model: "gpt-real", effort: "high" });
  });

  test("费率与累计用量只投影 app-server 返回的真实数字", () => {
    expect(
      normalizeUsageSnapshot(
        {
          rateLimits: {
            primary: { usedPercent: 42, resetsAt: 1_800_000_000 },
            secondary: { usedPercent: 7, resetsAt: 1_800_100_000 },
          },
        },
        { summary: { lifetimeTokens: 123456 } },
      ),
    ).toEqual({
      primaryUsedPercent: 42,
      primaryResetsAt: 1_800_000_000_000,
      secondaryUsedPercent: 7,
      secondaryResetsAt: 1_800_100_000_000,
      lifetimeTokens: 123456,
    });
  });
});
