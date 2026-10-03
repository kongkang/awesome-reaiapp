import { expect, test } from "bun:test";
import { VoiceCaptureOperations } from "../src/voice-capture-operations";

function fixture() {
  let current: string | undefined;
  const finished: string[] = [], cancelled: string[] = [];
  let starts = 0;
  const ports = {
    current: () => current,
    start: async () => { starts++; current = "original"; return { phase: "listening", sessionId: current }; },
    finish: (id: string) => { finished.push(id); current = undefined; return Promise.resolve(); },
    cancel: async (id: string) => { cancelled.push(id); if (current === id) current = undefined; },
    failed: (error: unknown) => { throw error; },
  };
  return { owner: new VoiceCaptureOperations(), controller: new AbortController(), ports, finished, cancelled, starts: () => starts, replace: (id?: string) => { current = id; } };
}
const start = { id: "operation", phase: "start" } as const;
const end = { id: "operation", phase: "end" } as const;

test("paired end finishes exact capture once; unknown end never starts", async () => {
  const f = fixture();
  await f.owner.invoke(end, f.controller.signal, f.ports);
  expect(f.starts()).toBe(0);
  await f.owner.invoke(start, f.controller.signal, f.ports);
  await f.owner.invoke(end, f.controller.signal, f.ports);
  await f.owner.invoke(end, f.controller.signal, f.ports);
  expect(f.finished).toEqual(["original"]);
  expect(f.starts()).toBe(1);
});

test("other entry ended capture; stale end cannot start or stop replacement", async () => {
  const f = fixture();
  await f.owner.invoke(start, f.controller.signal, f.ports);
  f.replace("replacement");
  await f.owner.invoke(end, f.controller.signal, f.ports);
  expect(f.finished).toEqual([]);
  expect(f.ports.current()).toBe("replacement");
  expect(f.starts()).toBe(1);
});

test("settled start remains precisely cancellable; finish detaches cancel", async () => {
  const f = fixture();
  await f.owner.invoke(start, f.controller.signal, f.ports);
  f.controller.abort();
  expect(f.cancelled).toEqual(["original"]);
  await f.owner.invoke(end, new AbortController().signal, f.ports);
  expect(f.finished).toEqual([]);
  const g = fixture();
  await g.owner.invoke(start, g.controller.signal, g.ports);
  await g.owner.invoke(end, g.controller.signal, g.ports);
  g.controller.abort();
  expect(g.cancelled).toEqual([]);
});

test("end while start awaits retires late capture instead of publishing it", async () => {
  const f = fixture();
  let resolve!: (value: { phase: string; sessionId: string }) => void;
  f.ports.start = () => new Promise(done => { resolve = done; });
  const pending = f.owner.invoke(start, f.controller.signal, f.ports);
  await f.owner.invoke(end, f.controller.signal, f.ports);
  resolve({ phase: "listening", sessionId: "late" });
  expect(await pending).toEqual({ phase: "idle" });
  expect(f.cancelled).toEqual(["late"]);
});
