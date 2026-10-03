/**
 * CLI 侧跑共用的 Manifest 正反样例。
 *
 * Host 侧的同一批断言在 `driver-v2/src-tauri/tests/manifest_fixtures.rs`。
 * 两边结论必须一致——不一致意味着开发者本地 validate 过了、装的时候却被拒。
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { validateManifest } from "../src/validate";

const fixturesDir = fileURLToPath(new URL("../../contract/manifest-fixtures", import.meta.url));

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));
const codesOf = (manifest: unknown): string[] =>
  [...new Set(validateManifest(manifest).map((f) => f.code))].sort();

describe("合法样例", () => {
  const dir = join(fixturesDir, "valid");
  const names = readdirSync(dir).filter((n) => n.endsWith(".json"));

  test("目录非空", () => {
    expect(names.length).toBeGreaterThan(0);
  });

  for (const name of names) {
    test(`${name} 零告警`, () => {
      expect(validateManifest(readJson(join(dir, name)))).toEqual([]);
    });
  }
});

describe("反例", () => {
  const dir = join(fixturesDir, "invalid");
  const names = readdirSync(dir).filter(
    (n) => n.endsWith(".json") && !n.endsWith(".expected.json"),
  );

  test("覆盖足够多的拒绝路径", () => {
    expect(names.length).toBeGreaterThanOrEqual(20);
  });

  for (const name of names) {
    const expectedFile = name.replace(/\.json$/, ".expected.json");
    const expected = readJson(join(dir, expectedFile)) as { codes: string[]; note: string };

    test(`${name} —— ${expected.note}`, () => {
      expect(codesOf(readJson(join(dir, name)))).toEqual([...new Set(expected.codes)].sort());
    });
  }

  test("user_configured owner 在 CLI 语义层 fail closed", () => {
    const manifest = readJson(join(dir, "network-endpoints.json")) as any;
    manifest.permissions = [{ id: "http.fetch@1", purpose: "同步任务", required: false }];
    manifest.network.endpoints[0].owner = "user_configured";
    const findings = validateManifest(manifest);
    expect(findings).toContainEqual(
      expect.objectContaining({
        code: "HOST_CAPABILITY_NOT_AVAILABLE",
        pointer: "network.endpoints[0].owner",
      }),
    );
  });

  test("fixed retention 的合法 maxDays 可通过 CLI", () => {
    const manifest = readJson(join(dir, "network-endpoints.json")) as any;
    manifest.permissions = [{ id: "http.fetch@1", purpose: "同步任务", required: false }];
    manifest.network.endpoints[0].retention = { mode: "fixed", maxDays: 30 };
    expect(validateManifest(manifest)).toEqual([]);
  });

  test("oauth_app endpoint 只有同时声明 oauthAppId 才通过", () => {
    const manifest = readJson(join(dir, "network-endpoints.json")) as any;
    manifest.permissions = [{ id: "http.fetch@1", purpose: "调用已审核服务", required: true }];
    manifest.network.endpoints[0].auth.mode = "oauth_app";
    expect(validateManifest(manifest)).toContainEqual(
      expect.objectContaining({
        code: "MANIFEST_REFERENCE_INVALID",
        pointer: "oauthAppId",
      }),
    );
    manifest.oauthAppId = "plugin-client-1";
    expect(validateManifest(manifest)).toEqual([]);
  });

  test("非规范 origin 在 CLI 阶段给出准确位置", () => {
    for (const origin of ["https://example.com/", "https://example.com:443", "https://Example.com"]) {
      const manifest = readJson(join(dir, "network-endpoints.json")) as any;
      manifest.permissions = [{ id: "http.fetch@1", purpose: "同步任务", required: false }];
      manifest.network.endpoints[0].origins = [origin];
      expect(validateManifest(manifest)).toContainEqual(
        expect.objectContaining({
          code: "MANIFEST_SCHEMA_INVALID",
          pointer: "network.endpoints[0].origins[0]",
        }),
      );
    }
  });
});
