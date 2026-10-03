import { describe, expect, test } from "bun:test";

import {
  ExclusiveAction,
  normalizeDeviceLogin,
} from "../src/interaction-state";

describe("真实交互状态保护", () => {
  test("目录选择与 thread/start 在前一次结束前只能运行一次", async () => {
    const gate = new ExclusiveAction();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const first = gate.run(async () => {
      calls += 1;
      await pending;
      return "created";
    });
    const duplicate = gate.run(async () => {
      calls += 1;
      return "duplicate";
    });
    expect(await duplicate).toBeUndefined();
    expect(calls).toBe(1);
    release();
    expect(await first).toBe("created");
    expect(gate.busy).toBe(false);
  });

  test("设备代码响应缺字段时必须判失败，不能永远停在正在获取", () => {
    expect(normalizeDeviceLogin({ verificationUrl: "https://example.test", userCode: "ABCD" })).toEqual({
      verificationUrl: "https://example.test",
      userCode: "ABCD",
    });
    expect(normalizeDeviceLogin({ verificationUrl: "https://example.test" })).toBeUndefined();
    expect(normalizeDeviceLogin({ userCode: "ABCD" })).toBeUndefined();
  });
});
