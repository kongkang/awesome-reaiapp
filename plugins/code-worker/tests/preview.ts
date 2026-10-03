/** Browser-only visual harness; never imported by src/app.ts or included in .reaiapp. */
import { mountCodeWorker } from "../src/view";
import { DEFAULT_LIMITS } from "../src/domain";
import { fixture } from "./fixture";
import "../src/code-worker.css";

const f = fixture();
f.apply("O-A", "addChild", { taskId: f.a, title: "Handle empty and error states", acceptance: "No fabricated Agent execution" });
f.work("O-A", f.ca); f.apply("O-A", "startTester", { childId: f.ca });
f.work("O-B", f.cb); f.test("O-B", f.cb);
const view = mountCodeWorker(document.querySelector<HTMLElement>("#root")!, {
  locale: "zh", limits: DEFAULT_LIMITS,
  connection: { state: "unavailable" },
  saveDefaults: async () => undefined, retry: async () => view.setConnection({ state: "unavailable" }), onNavigate: () => undefined,
});
document.querySelector("[data-preview-fixture]")!.addEventListener("click", () => view.setConnection({ state: "ready", board: f.board }));
document.querySelector("[data-preview-unavailable]")!.addEventListener("click", () => view.setConnection({ state: "unavailable" }));
document.querySelector("[data-preview-dark]")!.addEventListener("click", () => document.documentElement.classList.toggle("dark"));
let english = false;
document.querySelector("[data-preview-locale]")!.addEventListener("click", () => view.setLocale((english = !english) ? "en" : "zh"));
