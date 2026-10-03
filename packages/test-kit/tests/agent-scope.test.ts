import { expect, test } from "bun:test";
import { RequestMethod, type AgentBackendStatus } from "@reai/app-sdk/v1";
import { MockHost } from "../src/v1/index";

const makeHost = () => new MockHost({
  manifest: {
    appId: "com.example.scoped-agent",
    requires: { hostCapabilities: ["agent.session@1", "agent.session@2"] },
    permissions: [{ id: "agent.session@1" }, { id: "agent.session@2" }],
  },
  loadApp: async () => ({ default: {} }),
});

test("1.21 MockHost 默认宣传范围执行，显式 legacy override 不补字段", async () => {
  const host = makeHost();
  const initial = await host.bridge.request<{ backends: AgentBackendStatus[] }>(RequestMethod.AgentBackendsList, {});
  for (const backend of ["pi", "dsh", "codex"]) {
    expect(initial.backends.find(item => item.backend === backend)?.capabilities)
      .toMatchObject({ scopedExecutionVersion: 1, commandExecution: true });
  }
  host.setAgentDshStatus({ available: true, detail: "legacy, no scope declaration" });
  const legacy = await host.bridge.request<{ backends: AgentBackendStatus[] }>(RequestMethod.AgentBackendsList, {});
  expect(legacy.backends.find(item => item.backend === "dsh")?.capabilities).toBeUndefined();
});

test("1.21 MockHost v1 create 只在申请文件/命令工具时回工作根，mounted 保持旧形状", async () => {
  const host = makeHost();
  for (const workspace of [{ kind: "app-private" }, { kind: "direct", path: "/mock/selected-project" }]) {
    await expect(host.bridge.request(RequestMethod.AgentSessionCreate, { spec: { backend: "pi", workspace, tools: ["read", "command"] } }))
      .resolves.toMatchObject({ workspace, scopeVersion: 1, workspaceRoot: workspace.kind === "direct" ? workspace.path : "/mock/agent-workspaces/mock-agent-session-1" });
  }
  const plain = await host.bridge.request<Record<string, unknown>>(RequestMethod.AgentSessionCreate, { spec: { backend: "pi", workspace: { kind: "app-private" }, tools: ["web_search"] } });
  expect(plain.scopeVersion).toBeUndefined();
  const mounted = await host.bridge.request<Record<string, unknown>>(RequestMethod.AgentSessionCreate, { spec: { backend: "pi", workspace: { kind: "mounted", path: "/mock/legacy-mirror" }, tools: ["read"] } });
  expect(mounted.scopeVersion).toBeUndefined();
});

test("1.21 MockHost v2 create 同样回工作根，审批列表只读为空", async () => {
  const host = makeHost();
  const created = await host.bridge.request<Record<string, unknown>>(RequestMethod.AgentV2Create, { config: {
    schemaVersion: 2, systemPrompt: "x", tools: [{ ref: "read" }, { ref: "command" }], skills: [],
    workspace: { kind: "direct", path: "/mock/selected-project" }, memory: "session", mode: "yolo",
  } });
  expect(created).toMatchObject({ workspaceRoot: "/mock/selected-project", scopeVersion: 1 });
  await expect(host.bridge.request(RequestMethod.AgentV2ApprovalsList, { sessionId: String(created.sessionId) })).resolves.toEqual({ approvals: [] });
  await expect(host.bridge.request(RequestMethod.AgentSessionApprovalsList, { sessionId: "mock-agent-session-1" })).resolves.toEqual({ approvals: [] });
});
