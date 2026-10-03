import { expect, test } from "bun:test";
import { MockHost } from "../src/v1/mock-host";

function fixture(capabilities = ["agent.session@2"]) {
  return new MockHost({ manifest: { appId: "com.example.agent", requires: { hostCapabilities: capabilities } }, loadApp: async () => ({ default: {} }) });
}
test("mock durable turns use server identities and reject conflicting retries and cross-session reads", async () => {
  const host = fixture();
  const config = { schemaVersion: 2, runtime: "dsh", systemPrompt: "fixture", workspace: { kind: "app-private" }, memory: "session" };
  const created = await host.bridge.request<any>("agent.v2.session.create", { config });
  expect(created.runtime).toBe("dsh");
  const request = { sessionId: created.sessionId, idempotencyKey: "client-key", text: "hello" };
  const first = await host.bridge.request<any>("agent.v2.turn.start", request);
  expect(first.turnId).not.toBe(request.idempotencyKey);
  expect(await host.bridge.request("agent.v2.turn.start", request)).toEqual(first);
  await expect(host.bridge.request("agent.v2.turn.start", { ...request, text: "different" })).rejects.toMatchObject({ code: "AGENT_IDEMPOTENCY_CONFLICT" });
  await expect(host.bridge.request("agent.v2.turn.get", { sessionId: "another", turnId: first.turnId })).rejects.toMatchObject({ code: "AGENT_TURN_NOT_FOUND" });
  expect(first.result).toMatchObject({ schemaVersion: 2, runtime: "dsh", channel: "external-brain", usage: null, toolAttempts: [] });
  expect(await host.bridge.request<{ cancelled: boolean }>("agent.v2.turn.cancel", { sessionId: created.sessionId, turnId: first.turnId })).toEqual({ cancelled: false });
  expect(await host.bridge.request("agent.v2.turn.get", { sessionId: created.sessionId, turnId: first.turnId })).toEqual(first);
});
test("v1 capability cannot accidentally grant v2 and v2 cannot grant v1", async () => {
  for (const [caps, method] of [[["agent.session@1"], "agent.v2.backends.list"], [["agent.session@2"], "agent.backends.list"]] as const) {
    await expect(fixture([...caps]).bridge.request(method, {})).rejects.toThrow("Manifest 未声明");
  }
});
