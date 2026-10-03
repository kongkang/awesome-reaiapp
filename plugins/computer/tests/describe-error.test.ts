import { describe, expect, test } from "bun:test";
import { describeError } from "../src/agent-loop";

describe("describeError", () => {
  test("宿主 bridge 归一的普通对象提取 userMessage 与 code", () => {
    const bridgeError = { code: "NETWORK_PERMISSION_REQUIRED", userMessage: "需要用户授权该权限", retryable: false };
    expect(describeError(bridgeError)).toBe("需要用户授权该权限（NETWORK_PERMISSION_REQUIRED）");
  });

  test("Error 实例取 message", () => {
    expect(describeError(new Error("视觉模型请求失败 HTTP 401"))).toBe("视觉模型请求失败 HTTP 401");
  });

  test("message 字段兜底", () => {
    expect(describeError({ message: "网络不通" })).toBe("网络不通");
  });

  test("未知形状 JSON 化而不是 [object Object]", () => {
    expect(describeError({ weird: 1 })).toBe('{"weird":1}');
    expect(describeError("裸字符串")).toBe("裸字符串");
  });
});
