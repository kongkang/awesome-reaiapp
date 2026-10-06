import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { loadSupportMatrix } from "../src/assets";
import { satisfiesHostApiRange, validateManifest } from "../src/validate";

function findingsFor(range: string, hostApi = "1.24.0") {
  const manifest = JSON.parse(readFileSync(
    new URL("../../contract/manifest-fixtures/valid/minimal-todo.json", import.meta.url),
    "utf8",
  ));
  manifest.hostApi.range = range;
  manifest.requires.hostCapabilities.push("agent.session@2");
  manifest.permissions = [{
    id: "agent.session@2",
    purpose: "按声明的功能默认值创建 Agent 会话",
    required: true,
  }];
  manifest.contributes.agentFeatures = [{
    id: "translation",
    name: "翻译",
    promptTemplate: "目标语言：{targetLanguage}。只输出译文。",
    promptParams: [{ name: "targetLanguage", description: "目标语言" }],
    toolBase: [],
  }];
  const matrix = structuredClone(loadSupportMatrix());
  matrix.hostApi = hostApi;
  // 注入已授予能力，只测试范围校验；不修改生产 policy 或缓存矩阵。
  matrix.hostCapabilities.granted.push("agent.session@2");
  return validateManifest(manifest, matrix);
}

describe("agentFeatures Host API 范围", () => {
  for (const [kind, range] of [
    ["精确", "=1.24.0"],
    ["裸版本", "1.24.0"],
    ["caret", "^1.24.0"],
    ["tilde", "~1.24.0"],
  ] as const) {
    test(`${kind} 范围的有效下界允许声明 Agent 功能`, () => {
      expect(findingsFor(range)).toEqual([]);
    });
  }

  test("最低版本边界接受四种形式和比较器", () => {
    for (const range of ["=1.23.0", "1.23.0", "^1.23.0", "~1.23.0", ">=1.23.0 <2.0.0"]) {
      expect(findingsFor(range, "1.23.0")).toEqual([]);
    }
  });

  test("复合条件使用最高下界", () => {
    for (const range of ["^1.22.0 >=1.23.0", "^1.22.0 =1.24.0", ">=1.22.0 ~1.24.0", ">1.23.0 <2.0.0"]) {
      expect(findingsFor(range)).toEqual([]);
    }
  });

  test("旧版本可能匹配、当前 Host 排除与非法范围仍拒绝", () => {
    for (const range of ["^1.22.0", ">1.22.0", ">=1.22.0 <2.0.0", "<2.0.0", "<=1.24.0"]) {
      expect(satisfiesHostApiRange("1.22.1", range)).toBe(true);
      expect(satisfiesHostApiRange("1.24.0", range)).toBe(true);
    }
    for (const range of [
      "^1.22.0", ">1.22.0", ">=1.22.0 <2.0.0", "<2.0.0", "<=1.24.0",
      "=1.23.0", "~1.23.0", ">=1.23.0 <1.24.0", "=1.25.0", "=1.24.0 <1.24.0",
      "1", "1.24", ">=1.23", "^1.024.0", "^1.23.0-alpha", "^1.24.0-beta.1",
      "1.24.*", "^1.23.0 || ^2.0.0",
    ]) {
      expect(findingsFor(range).map((finding) => finding.code)).toContain("HOST_API_INCOMPATIBLE");
    }
  });
});
