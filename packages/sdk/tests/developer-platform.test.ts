import { expect, test } from "bun:test";
import {
  defineApp,
  DEVELOPER_PLATFORM_BACKEND_ERROR_CODES,
  DEVELOPER_PLATFORM_CAPABILITY,
  DEVELOPER_PLATFORM_REQUEST_METHODS,
  RequestMethod,
  runApp,
  type AppContext,
  type HostBridge,
  type HostMessage,
} from "../src/v1/index";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("developer.platform typed client 只编码六个固定 Bridge 方法与最小参数", async () => {
  const requests: Array<{ method: string; params: unknown }> = [];
  const handlers = new Set<(message: HostMessage) => void>();
  const bridge: HostBridge = {
    async request(method, params) {
      requests.push({ method, params });
      if (method === RequestMethod.DeveloperPlatformContextGet) {
        return {
          account: { enabled: true, loggedIn: true },
          backend: { available: false, errorCode: "BACKEND_CAPABILITY_UNAVAILABLE" },
        } as never;
      }
      if (method === RequestMethod.DeveloperPlatformProductsCreate) {
        return {
          productId: "11111111-1111-4111-8111-111111111111",
          managementClientId: "22222222-2222-4222-8222-222222222222",
          oauthClientId: "public-client-id",
          draftRevisionId: "33333333-3333-4333-8333-333333333333",
          idempotent: false,
        } as never;
      }
      if (method === RequestMethod.DeveloperPlatformClientsGet) {
        return { client: {}, revisions: [] } as never;
      }
      return [] as never;
    },
    notify() {},
    subscribe(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
  };

  let context: AppContext | undefined;
  runApp(defineApp({ activate(ctx) { context = ctx; } }), bridge);
  for (const handler of handlers) handler({ type: "activate", runtimeSessionId: "rt-developer" });
  await tick();

  await context!.developerPlatform.getContext();
  await context!.developerPlatform.listProjects({
    teamId: "11111111-1111-4111-8111-111111111111",
  });
  await context!.developerPlatform.listScopes({
    teamId: "11111111-1111-4111-8111-111111111111",
    projectId: "22222222-2222-4222-8222-222222222222",
    context: "development",
  });
  await context!.developerPlatform.listProducts({
    teamId: "11111111-1111-4111-8111-111111111111",
  });
  await context!.developerPlatform.createProduct({
    teamId: "11111111-1111-4111-8111-111111111111",
    projectId: "22222222-2222-4222-8222-222222222222",
    name: "Voice App",
    purpose: "在开发阶段验证标准插件流程",
    scopeCodes: ["profile:read"],
    idempotencyKey: "create-voice-app-1",
    packageAppId: "must-not-cross-sdk-boundary",
  } as never);
  await context!.developerPlatform.getClient({
    teamId: "11111111-1111-4111-8111-111111111111",
    managementClientId: "22222222-2222-4222-8222-222222222222",
  });

  expect(DEVELOPER_PLATFORM_CAPABILITY).toBe("developer.platform@1");
  expect(DEVELOPER_PLATFORM_REQUEST_METHODS).toEqual([
    "developer.platform.context.get",
    "developer.platform.projects.list",
    "developer.platform.scopes.list",
    "developer.platform.products.list",
    "developer.platform.products.create",
    "developer.platform.clients.get",
  ]);
  expect(requests).toEqual([
    { method: RequestMethod.DeveloperPlatformContextGet, params: {} },
    {
      method: RequestMethod.DeveloperPlatformProjectsList,
      params: { teamId: "11111111-1111-4111-8111-111111111111" },
    },
    {
      method: RequestMethod.DeveloperPlatformScopesList,
      params: {
        teamId: "11111111-1111-4111-8111-111111111111",
        projectId: "22222222-2222-4222-8222-222222222222",
        context: "development",
      },
    },
    {
      method: RequestMethod.DeveloperPlatformProductsList,
      params: { teamId: "11111111-1111-4111-8111-111111111111" },
    },
    {
      method: RequestMethod.DeveloperPlatformProductsCreate,
      params: {
        teamId: "11111111-1111-4111-8111-111111111111",
        projectId: "22222222-2222-4222-8222-222222222222",
        name: "Voice App",
        purpose: "在开发阶段验证标准插件流程",
        scopeCodes: ["profile:read"],
        idempotencyKey: "create-voice-app-1",
      },
    },
    {
      method: RequestMethod.DeveloperPlatformClientsGet,
      params: {
        teamId: "11111111-1111-4111-8111-111111111111",
        managementClientId: "22222222-2222-4222-8222-222222222222",
      },
    },
  ]);
});

test("developer.platform backend 状态错误码集合固定", () => {
  expect(DEVELOPER_PLATFORM_BACKEND_ERROR_CODES).toEqual([
    "BACKEND_CAPABILITY_UNAVAILABLE",
    "DEVELOPER_PLATFORM_NOT_LOGGED_IN",
    "DEVELOPER_PLATFORM_REAUTH_REQUIRED",
    "DEVELOPER_PLATFORM_UNAUTHORIZED_CLIENT",
    "DEVELOPER_PLATFORM_INVALID_REQUEST",
    "DEVELOPER_PLATFORM_NOT_FOUND",
    "DEVELOPER_PLATFORM_CONFLICT",
    "DEVELOPER_PLATFORM_RATE_LIMITED",
    "DEVELOPER_PLATFORM_BACKEND_REJECTED",
  ]);
});
