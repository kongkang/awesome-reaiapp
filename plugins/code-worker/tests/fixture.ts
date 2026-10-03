import { admitPlanned, newBoard, registerOrchestrator, transition, type Board, type Operation } from "../src/domain";

/** Test-only state. This file is never imported by the installed plugin entry. */
export function fixture() {
  let board = admitPlanned(newBoard(), ["A", "B", "C"].map(id => ({ id, title: `Demand ${id}`, body: `Private goal ${id}`, status: "planned" })));
  board = registerOrchestrator(registerOrchestrator(board, "O-A"), "O-B");
  let sequence = 0;
  const apply = (actor: string, operation: Operation, payload: Record<string, unknown>) => {
    board = transition(board, actor, { requestId: `request-${++sequence}`, expectedRevision: board.revision, operation, payload });
    if (operation === "startWorker" || operation === "startTester") {
      const child = board.children.find(c => c.id === payload.childId)!;
      const id = operation === "startWorker" ? child.worker! : child.tester!;
      board = transition(board, id, { requestId: `request-${++sequence}`, expectedRevision: board.revision, operation: "begin", payload: { childId: child.id } });
    }
    return board;
  };
  const a = board.tasks[0].id, b = board.tasks[1].id;
  apply("O-A", "claim", { taskId: a }); apply("O-B", "claim", { taskId: b });
  apply("O-A", "addChild", { taskId: a, title: "Subtask A", acceptance: "Evidence A" });
  apply("O-B", "addChild", { taskId: b, title: "Subtask B", acceptance: "Evidence B" });
  const ca = board.children[0].id, cb = board.children[1].id;
  return { get board() { return board; }, replace(value: Board) { board = value; }, apply, a, b, ca, cb,
    work(owner: string, childId: string) {
      apply(owner, "startWorker", { childId });
      const worker = board.children.find(c => c.id === childId)!.worker!;
      apply(worker, "work", { childId, result: "Implementation and self-check" }); return worker;
    },
    test(owner: string, childId: string, verdict: "pass" | "fail" = "pass") {
      apply(owner, "startTester", { childId });
      const tester = board.children.find(c => c.id === childId)!.tester!;
      apply(tester, "test", { childId, verdict, evidence: "Independent test evidence" }); return tester;
    },
  };
}
