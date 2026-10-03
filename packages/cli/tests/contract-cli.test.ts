/**
 * `reai-app contract-test` 的 `--host-api` 相容判定。
 *
 * 这条判定原来用的是字符串前缀（`declared.startsWith(wanted)`），而
 * `"1.10.0".startsWith("1.1")` 是 true——要求 1.1 的时候，一个声明 1.10 的套件
 * 会被判成相容。版本号里 10 不是 1 的延伸。这类误判在 CI 上的表现是
 * 「明明不兼容却全绿」，是最难被发现的一种。
 *
 * 这里**导入真实实现**而不是在测试里复制一份规则：复制一份的话，改了实现忘了改
 * 测试，测试照样绿——它守的就不再是代码了。
 */
import { describe, expect, test } from "bun:test";
import { hostApiMatches } from "../src/contract-test";

describe("hostApi 相容判定", () => {
  test("同一条版本线相容", () => {
    expect(hostApiMatches("1.1.0", "1.1")).toBe(true);
    expect(hostApiMatches("1.1", "1.1")).toBe(true);
    expect(hostApiMatches("1.1.0", "1")).toBe(true);
  });

  test("10 不会被当成 1 的延伸", () => {
    expect(hostApiMatches("1.10.0", "1.1")).toBe(false);
    expect(hostApiMatches("11.0.0", "1")).toBe(false);
  });

  test("要求得比声明更细时不相容", () => {
    expect(hostApiMatches("1.1", "1.1.0")).toBe(false);
  });

  test("不同主版本不相容", () => {
    expect(hostApiMatches("2.0.0", "1.1")).toBe(false);
  });
});
