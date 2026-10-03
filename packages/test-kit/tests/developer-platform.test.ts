import { describe, expect, test } from "bun:test";
import {
  DEVELOPER_PLATFORM_CAPABILITY,
  RequestMethod,
  type DeveloperPlatformRequest,
} from "@reai/app-sdk/v1";
import { MockHost, MockHostError } from "../src/v1/index";

const TEAM_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_ID = "22222222-2222-4222-8222-222222222222";

const manifest = {
  appId: "com.reai.developer-center",
  requires: { hostCapabilities: [DEVELOPER_PLATFORM_CAPABILITY] },
};

describe("developer.platform Mock Host", () => {
  test("只有显式注入 handler 才返回云管理 fixture，并记录已校验请求", async () => {
    const handled: DeveloperPlatformRequest[] = [];
    const host = new MockHost({
      manifest,
      loadApp: async () => ({ default: {} }),
      developerPlatformHandler(request) {
        handled.push(request);
        return [{ id: PROJECT_ID, teamId: TEAM_ID, name: "Voice" }];
      },
    });

    await expect(host.bridge.request(RequestMethod.DeveloperPlatformProjectsList, {
      teamId: TEAM_ID,
    })).resolves.toEqual([{ id: PROJECT_ID, teamId: TEAM_ID, name: "Voice" }]);
    expect(handled).toEqual([{
      method: RequestMethod.DeveloperPlatformProjectsList,
      params: { teamId: TEAM_ID },
    }]);
    expect(host.developerPlatformRequests).toEqual(handled);
  });

  test("未注入 handler 时稳定 fail closed", async () => {
    const host = new MockHost({ manifest, loadApp: async () => ({ default: {} }) });
    await expect(host.bridge.request(RequestMethod.DeveloperPlatformContextGet, {}))
      .resolves.toEqual({
        account: { enabled: true, loggedIn: true },
        backend: {
          available: false,
          errorCode: "BACKEND_CAPABILITY_UNAVAILABLE",
        },
      });
    await expect(host.bridge.request(RequestMethod.DeveloperPlatformProductsList, {
      teamId: TEAM_ID,
    })).rejects.toMatchObject({ code: "BACKEND_CAPABILITY_UNAVAILABLE" });
  });

  test("非精确系统插件或未声明 capability 均被拒绝", async () => {
    for (const badManifest of [
      { appId: "com.example.developer-center", requires: { hostCapabilities: [DEVELOPER_PLATFORM_CAPABILITY] } },
      { appId: "com.reai.developer-center", requires: { hostCapabilities: [] } },
    ]) {
      const host = new MockHost({
        manifest: badManifest,
        loadApp: async () => ({ default: {} }),
        developerPlatformHandler: () => [],
      });
      await expect(host.bridge.request(RequestMethod.DeveloperPlatformProductsList, {
        teamId: TEAM_ID,
      })).rejects.toMatchObject({ code: "DEVELOPER_PLATFORM_NOT_GRANTED" });
    }
  });

  test("严格拒绝额外字段、无效 UUID 和创建时的保留身份字段", async () => {
    const host = new MockHost({
      manifest,
      loadApp: async () => ({ default: {} }),
      developerPlatformHandler: () => ({ ok: true }),
    });

    for (const params of [
      { teamId: TEAM_ID, url: "https://evil.test" },
      { teamId: "not-a-uuid" },
    ]) {
      await expect(host.bridge.request(
        RequestMethod.DeveloperPlatformProductsList,
        params,
      )).rejects.toMatchObject({ code: "DEVELOPER_PLATFORM_INVALID_REQUEST" });
    }

    await expect(host.bridge.request(RequestMethod.DeveloperPlatformProductsCreate, {
      teamId: TEAM_ID,
      projectId: PROJECT_ID,
      name: "Voice",
      purpose: "验证插件开发流程",
      scopeCodes: ["profile:read"],
      idempotencyKey: "create-voice-1",
      packageAppId: "com.example.voice",
    })).rejects.toMatchObject({ code: "DEVELOPER_PLATFORM_INVALID_REQUEST" });

    for (const invalidCreate of [
      {
        teamId: TEAM_ID,
        projectId: PROJECT_ID,
        name: "x".repeat(121),
        purpose: "验证插件开发流程",
        scopeCodes: [],
        idempotencyKey: "create-voice-1",
      },
      {
        teamId: TEAM_ID,
        projectId: PROJECT_ID,
        name: "Voice",
        purpose: "验证插件开发流程",
        scopeCodes: ["profile:read", "profile:read"],
        idempotencyKey: "create-voice-1",
      },
      {
        teamId: TEAM_ID,
        projectId: PROJECT_ID,
        name: "Voice",
        purpose: "验证插件开发流程",
        scopeCodes: Array.from({ length: 33 }, (_, index) => `scope:${index}`),
        idempotencyKey: "create-voice-1",
      },
      ...["create voice 1", "创建-1", "create+voice"].map((idempotencyKey) => ({
        teamId: TEAM_ID,
        projectId: PROJECT_ID,
        name: "Voice",
        purpose: "验证插件开发流程",
        scopeCodes: [],
        idempotencyKey,
      })),
    ]) {
      await expect(host.bridge.request(
        RequestMethod.DeveloperPlatformProductsCreate,
        invalidCreate,
      )).rejects.toMatchObject({ code: "DEVELOPER_PLATFORM_INVALID_REQUEST" });
    }
  });

  test("handler 抛出的稳定错误保持原形", async () => {
    const host = new MockHost({
      manifest,
      loadApp: async () => ({ default: {} }),
      developerPlatformHandler: () => {
        throw new MockHostError("管理后端未开放", "BACKEND_CAPABILITY_UNAVAILABLE");
      },
    });
    await expect(host.bridge.request(RequestMethod.DeveloperPlatformProductsList, {
      teamId: TEAM_ID,
    }))
      .rejects.toMatchObject({ code: "BACKEND_CAPABILITY_UNAVAILABLE" });
  });
});
