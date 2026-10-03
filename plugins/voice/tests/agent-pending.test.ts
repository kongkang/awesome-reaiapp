import { expect, test } from "bun:test";
import { PendingAgentRequests } from "../src/agent-pending";
import type { KeyValueStore } from "@reai/app-sdk/v1";
function fixture() {
  const data = new Map<string, unknown>(); let epoch = "account-a"; let now = 100;
  const store: KeyValueStore = {
    async get<T>(key: string) { return structuredClone(data.get(key)) as T | undefined; },
    async set(key,value) { data.set(key,structuredClone(value)); }, async delete(key) { data.delete(key); }, async keys() { return [...data.keys()]; },
    async compareAndSet(key,expected,value) { if (JSON.stringify(data.get(key)) !== JSON.stringify(expected)) return false; data.set(key,structuredClone(value)); return true; },
  };
  return { journal: () => new PendingAgentRequests(store, async () => epoch === "account-a" ? ["agent2-owned"] : [], () => now), setEpoch: (value: string) => { epoch = value; }, advance: () => { now += 24*60*60*1000+1; } };
}
const request = { sessionId: "agent2-owned", idempotencyKey: "original-key", text: "exact polished question", taskPresentation: "caller" as const };
test("pending request survives restart with exact key/body and pending cancellation", async () => {
  const f=fixture(); await f.journal().save("task",request); await f.journal().cancel("task");
  expect(await f.journal().get("task")).toMatchObject({taskId:"task",request,cancelled:true});
  await f.journal().clear("task"); await expect(f.journal().get("task")).rejects.toMatchObject({code:"AGENT_PENDING_NOT_FOUND"});
});
test("pending requests cannot cross account epochs and expire after a day", async () => {
  const f=fixture(); await f.journal().save("task",request);f.setEpoch("account-b");
  await expect(f.journal().get("task")).rejects.toMatchObject({code:"AGENT_PENDING_NOT_FOUND"});
  f.setEpoch("account-a");f.advance();await expect(f.journal().get("task")).rejects.toMatchObject({code:"AGENT_PENDING_NOT_FOUND"});
});
test("journal refuses a ninth unknown admission and cannot overwrite a key with different contents", async () => {
  const f=fixture();for(let i=0;i<8;i++) await f.journal().save(`task-${i}`,{...request,idempotencyKey:`key-${i}`});
  await expect(f.journal().save("ninth",request)).rejects.toMatchObject({code:"AGENT_PENDING_CAPACITY"});
  await expect(f.journal().save("task-0",request)).rejects.toMatchObject({code:"AGENT_PENDING_IDENTITY_CONFLICT"});
});
