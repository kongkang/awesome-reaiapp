import { describe, expect, test } from "bun:test";
import { admitPlanned, newBoard, project, quota, registerOrchestrator, setLimits, transition } from "../src/domain";
import { fixture } from "./fixture";

describe("plugin task rules (no runtime or transport implied)", () => {
  test("only planned visible demands enter once; failed intake is atomic", () => {
    const input = ["planned", "inbox"].map(status => ({ id: status, title: status, body: status, status }));
    const state = admitPlanned(newBoard(), [...input, { ...input[0], id: "hidden", archived: true }]);
    expect(state.tasks).toHaveLength(1); expect(admitPlanned(state, input)).toEqual(state);
    const before = structuredClone(state);
    expect(() => admitPlanned(state, [{ ...input[0], id: "new" }, { ...input[0], id: "invalid", title: "" }])).toThrow();
    expect(state).toEqual(before);
  });
  test("two claims at the same revision cannot both acquire the root", () => {
    let state = admitPlanned(newBoard(), [{ id: "a", title: "A", body: "A", status: "planned" }]);
    state = registerOrchestrator(registerOrchestrator(state, "O-1"), "O-2");
    const request = { requestId: "claim", expectedRevision: state.revision, operation: "claim" as const, payload: { taskId: state.tasks[0].id } };
    const claimed = transition(state, "O-1", request);
    expect(() => transition(claimed, "O-2", request)).toThrow(/revision/);
    expect(() => transition(claimed, "O-2", { ...request, expectedRevision: claimed.revision })).toThrow(/locked/);
    expect(state.tasks[0].owner).toBeNull();
  });
  test("one orchestrator handles one active parent and other roots remain private", () => {
    const f = fixture();
    expect(() => f.apply("O-A", "claim", { taskId: f.board.tasks[2].id })).toThrow(/locked/);
    expect(() => f.apply("O-A", "addChild", { taskId: f.b, title: "Forged", acceptance: "X" })).toThrow(/scope/);
    f.apply("O-A", "startWorker", { childId: f.ca }); f.apply("O-B", "startWorker", { childId: f.cb });
    const view = project(f.board, "O-A"), json = JSON.stringify(view);
    expect(view.tasks).toHaveLength(1); expect(view.children).toHaveLength(1); expect(view.agents).toHaveLength(2);
    expect(json).not.toContain("Private goal B"); expect(json).not.toContain("Private goal C"); expect(json).not.toContain("O-B");
    expect(Object.keys(view.claimable![0])).toEqual(["id", "title"]);
    const worker = f.board.children[0].worker!;
    expect(project(f.board, worker).quota).toBeUndefined();
    expect(() => f.apply(worker, "work", { childId: f.cb, result: "Forged" })).toThrow(/assigned/);
    expect(() => project(f.board, "admin")).toThrow(/not found/);
  });
  test("strict fields, unknown operations and stale writes leave state untouched", () => {
    const f = fixture(), before = structuredClone(f.board);
    expect(() => f.apply("O-A", "startWorker", { childId: f.ca, owner: "O-B" })).toThrow(/field/);
    expect(() => f.apply("O-A", "startWorker", {})).toThrow(/field/);
    expect(() => transition(f.board, "O-A", { requestId: "x", expectedRevision: f.board.revision, operation: "toString", payload: {} } as never)).toThrow(/envelope/);
    expect(f.board).toEqual(before);
  });
  test("identical idempotent replay is harmless and conflicting reuse fails", () => {
    const f = fixture(), request = { requestId: "work-1", expectedRevision: f.board.revision, operation: "startWorker" as const, payload: { childId: f.ca } };
    const started = transition(f.board, "O-A", request);
    const worker = started.children[0].worker!;
    const running = transition(started, worker, { requestId: "begin-1", expectedRevision: started.revision, operation: "begin", payload: { childId: f.ca } });
    const finished = transition(running, worker, { requestId: "done-1", expectedRevision: running.revision, operation: "work", payload: { childId: f.ca, result: "Delivered" } });
    expect(transition(finished, "O-A", request)).toEqual(finished);
    expect(() => transition(finished, "O-A", { ...request, payload: { childId: f.cb } })).toThrow(/reused/);
  });
  test("Worker completion returns capacity immediately, before Tester starts", () => {
    const f = fixture(); f.replace(setLimits(f.board, { orchestrator: 3, worker: 1, tester: 1 }));
    f.apply("O-A", "startWorker", { childId: f.ca });
    expect(() => f.apply("O-B", "startWorker", { childId: f.cb })).toThrow(/limit/);
    const worker = f.board.children[0].worker!;
    f.apply(worker, "work", { childId: f.ca, result: "Done" });
    expect(quota(f.board).worker.available).toBe(1); expect(f.board.children[0].status).toBe("awaiting_test");
    f.apply(f.board.children.find(c => c.id === f.cb)!.worker!, "begin", { childId: f.cb }); expect(quota(f.board).worker.running).toBe(1);
  });
  test.each(["pass", "fail"] as const)("independent Tester %s returns test capacity", verdict => {
    const f = fixture(), worker = f.work("O-A", f.ca); f.work("O-B", f.cb);
    f.replace(setLimits(f.board, { orchestrator: 3, worker: 10, tester: 1 }));
    f.apply("O-A", "startTester", { childId: f.ca });
    expect(() => f.apply("O-B", "startTester", { childId: f.cb })).toThrow(/limit/);
    expect(() => f.apply(worker, "test", { childId: f.ca, verdict, evidence: "Self approval" })).toThrow(/assigned/);
    const tester = f.board.children[0].tester!; expect(tester).not.toBe(worker);
    f.apply(tester, "test", { childId: f.ca, verdict, evidence: "Independent evidence" });
    expect(quota(f.board).tester.running).toBe(0);
  });
  test("rework retains past evidence and rejects retired attempt writes", () => {
    const f = fixture(), oldWorker = f.work("O-A", f.ca), oldTester = f.test("O-A", f.ca, "fail");
    f.apply("O-A", "startWorker", { childId: f.ca });
    const c = f.board.children[0];
    expect(c.attempt).toBe(2); expect(c.result).toBeNull(); expect(c.verdict).toBeNull(); expect(c.mergeRef).toBeNull();
    expect(c.history[0].verdict).toBe("fail"); expect(project(f.board, oldWorker).children).toHaveLength(0);
    expect(project(f.board, oldTester).children).toHaveLength(0);
    expect(() => f.apply(oldWorker, "work", { childId: f.ca, result: "Late delivery" })).toThrow(/assigned/);
  });
  test("parent requires full decomposition, independent pass, and every merge", () => {
    const f = fixture();
    expect(() => f.apply("O-A", "merge", { childId: f.ca, mergeRef: "premature" })).toThrow(/test evidence/);
    f.work("O-A", f.ca); f.test("O-A", f.ca);
    expect(f.board.tasks[0].status).toBe("open");
    f.apply("O-A", "merge", { childId: f.ca, mergeRef: "Verified merge commit" });
    expect(f.board.tasks[0].status).toBe("open");
    f.apply("O-A", "closePlan", { taskId: f.a });
    expect(f.board.tasks[0].status).toBe("done"); expect(quota(f.board).orchestrator.running).toBe(1);
  });
  test("invalid quota or lowering below running count cannot mutate state", () => {
    const f = fixture(), before = structuredClone(f.board);
    expect(() => setLimits(f.board, { orchestrator: 1, worker: 10, tester: 6 })).toThrow(/running/);
    expect(() => newBoard({ orchestrator: 3, worker: Infinity, tester: 6 })).toThrow();
    expect(f.board).toEqual(before);
  });
});
