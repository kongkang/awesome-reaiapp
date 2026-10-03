import { expect, test } from "bun:test";
import type { KeyValueStore, SavedInputSelection } from "@reai/app-sdk/v1";
import { InputSelectionJournal } from "../src/input-selection-journal";
import { VoiceStateRepository, type VoiceHistoryItem } from "../src/data";
import { projectSavedInputSession } from "../src/saved-input-retry";

test("recording selection survives settings changes, restart and a retry with another model", async () => {
  const values = new Map<string, unknown>();
  const store: KeyValueStore = {
    compareAndSet: async () => { throw new Error("CAS is not expected in this Voice test"); },
    get: async <T>(key: string) => structuredClone(values.get(key)) as T | undefined,
    set: async (key, value) => { values.set(key, structuredClone(value)); },
    delete: async key => { values.delete(key); }, keys: async () => [...values.keys()],
  };
  const original: SavedInputSelection = { engine: "cloud", modelId: "transcribe-free", modelName: "Original name", language: "en-US", punctEnabled: false };
  const journal = new InputSelectionJournal(store);
  const save = journal.remember("session", original);
  original.modelName = "Changed catalog";
  await save;
  await journal.remember("session", { ...original, modelId: "transcribe-paid" });
  const snapshot = await new InputSelectionJournal(store).read("session");
  expect(snapshot?.modelId).toBe("transcribe-free");
  expect(snapshot?.modelName).toBe("Original name");
  expect(await journal.read("legacy")).toBeUndefined();
  const item: VoiceHistoryItem = { id: "history", recordingId: "clip", transcript: "old", createdAt: new Date().toISOString(), source: "system", inserted: false, durationMs: 1000, language: "en-US", transcriptionStatus: "failed", originalSelection: snapshot };
  const local: SavedInputSelection = { engine: "local", modelId: "local", modelName: "Local", language: "zh-CN", punctEnabled: true };
  const projected = projectSavedInputSession(item, { recordingId: "clip", sessionId: "session", mode: "input", source: "System", requestedStartMs: 0, requestedEndMs: 1000, effectiveStartMs: 0, effectiveEndMs: 1000, stopReason: "user_cancel", transcriptionStatus: "complete", transcript: "new", revision: 2, attempt: { recordingId: "clip", attemptId: "a", revision: 2, state: "complete", selection: local, startedAtMs: 1 } });
  const repository = new VoiceStateRepository(store);
  await repository.appendHistory(projected);
  const restored = (await repository.load()).history![0]!;
  expect(restored.originalSelection).toEqual(snapshot);
  expect(restored.savedInput?.selection).toEqual(local);
  expect(restored.transcript).toBe("new");
});

test("恢复扫描一轮只读一次 journal 快照，快照与逐条读取一致且互不共享对象", async () => {
  const values = new Map<string, unknown>();
  let gets = 0;
  const store: KeyValueStore = {
    compareAndSet: async () => { throw new Error("CAS is not expected in this Voice test"); },
    get: async <T>(key: string) => { gets++; return structuredClone(values.get(key)) as T | undefined; },
    set: async (key, value) => { values.set(key, structuredClone(value)); },
    delete: async key => { values.delete(key); }, keys: async () => [...values.keys()],
  };
  const journal = new InputSelectionJournal(store);
  const selection = (modelId: string): SavedInputSelection => ({ engine: "cloud", modelId, modelName: modelId, language: "zh-CN", punctEnabled: true });
  for (let index = 0; index < 50; index++) await journal.remember(`s${index}`, selection(`m${index}`));
  gets = 0;
  const snapshot = await journal.snapshot();
  expect(gets).toBe(1);
  expect(snapshot.size).toBe(50);
  expect(snapshot.get("s7")).toEqual((await journal.read("s7"))!);
  snapshot.get("s7")!.modelId = "mutated";
  expect((await journal.read("s7"))?.modelId).toBe("m7");
  expect((await new InputSelectionJournal(store).snapshot()).has("missing")).toBe(false);
});

test("恢复扫描用快照取原始选择，不再按会话逐条读取 journal", async () => {
  const source = await Bun.file(new URL("../src/app.ts", import.meta.url)).text();
  const start = source.indexOf("const syncRecoverableInputSessions = async");
  expect(start).toBeGreaterThan(0);
  const body = source.slice(start, source.indexOf("\n    };\n", start));
  expect(body).toContain("inputSelections.snapshot()");
  expect(body).not.toContain("inputSelections.read(");
});
