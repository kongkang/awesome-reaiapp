import { afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { mountCodeWorker, type Connection } from "../src/view";
import { DEFAULT_LIMITS } from "../src/domain";
import { SKILL_CONTENT } from "../src/skill.generated";
import { fixture } from "./fixture";

if (!globalThis.document) GlobalRegistrator.register();
const cleanups: (() => void)[] = [];
afterEach(() => { cleanups.splice(0).forEach(clean => clean()); document.body.replaceChildren(); });
function mount(connection: Connection, save: () => Promise<void> = async () => undefined) {
  const root = document.createElement("div"); document.body.append(root);
  const nav: unknown[] = [];
  const view = mountCodeWorker(root, { connection, locale: "zh", limits: DEFAULT_LIMITS, saveDefaults: save, retry: async () => undefined, onNavigate: value => nav.push(value) });
  cleanups.push(view.destroy);
  const click = (selector: string) => { const el = root.querySelector<HTMLButtonElement>(selector); expect(el).not.toBeNull(); el!.click(); };
  return { root, view, click, nav };
}
test("unconnected installed view has no fabricated tasks, counts, runtime controls or URL", () => {
  const { root, click, view } = mount({ state: "unavailable" });
  expect(root.textContent).toContain("编排服务尚未连接"); expect(root.querySelectorAll("[data-task]")).toHaveLength(0);
  expect(root.querySelectorAll(".cw-col")).toHaveLength(4);
  click('[data-tab="roles"]'); expect(root.textContent).toContain("执行数量未连接");
  expect(root.querySelector<HTMLButtonElement>('[data-new-agent]')?.disabled).toBe(true);
  click('[data-tab="skill"]');
  expect(root.querySelectorAll('a[href^="http"],a[href^="reai-app"]')).toHaveLength(0);
  expect(root.querySelector<HTMLTextAreaElement>("[data-skill-full]")?.value).toBe(SKILL_CONTENT);
  click('[data-select-skill="full"]');
  const field = root.querySelector<HTMLTextAreaElement>("[data-skill-full]")!;
  expect(document.activeElement === field).toBe(true); expect(field.selectionEnd).toBe(field.value.length);
  expect(root.textContent).toContain("请使用系统复制快捷键"); expect(root.textContent).not.toContain("已复制");
  view.setLocale("en");
  expect(root.querySelector(".cw-skill-status")?.textContent).toBe("Selected. Use your system copy shortcut to copy.");
  expect(field.selectionEnd).toBe(field.value.length);
});
test("accepted parent/detail mapping filters children and escapes demand content", () => {
  const f = fixture(); f.board.tasks[0].title = '<img src=x onerror="alert(1)">';
  f.work("O-A", f.ca); f.apply("O-A", "startTester", { childId: f.ca });
  const { root, click, nav } = mount({ state: "ready", board: f.board });
  expect(root.querySelector("img")).toBeNull(); expect(root.querySelectorAll(".cw-col")).toHaveLength(4);
  click(`[data-task="${f.a}"]`);
  expect(root.querySelectorAll(".cw-col")).toHaveLength(5); expect(root.querySelectorAll("[data-child]")).toHaveLength(1);
  expect(root.textContent).toContain("Subtask A"); expect(root.textContent).not.toContain("Subtask B");
  expect(root.querySelector('[data-stage="awaiting_test"]')?.textContent).toContain("验收中");
  expect(nav.at(-1)).toEqual({ key: `task:${f.a}`, label: f.board.tasks[0].title });
  click(`[data-child="${f.ca}"]`); expect(root.querySelector(".cw-dialog")?.textContent).toContain("验收证据");
  expect(root.querySelector<HTMLElement>(".cw-page")?.inert).toBe(true);
  root.querySelector(".cw-overlay")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  expect(root.querySelector<HTMLElement>(".cw-overlay")?.hidden).toBe(true);
  expect(document.activeElement === root.querySelector(`[data-child="${f.ca}"]`)).toBe(true);
});
test("Agent selector changes only the inspected scoped JSON, with no writable button", () => {
  const f = fixture(); f.apply("O-A", "startWorker", { childId: f.ca }); f.apply("O-B", "startWorker", { childId: f.cb });
  const { root, click } = mount({ state: "ready", board: f.board });
  click('[data-tab="api"]');
  const projection = () => JSON.parse(root.querySelector('[aria-label="Agent JSON"]')!.textContent!);
  expect(projection().tasks).toHaveLength(1); expect(projection().tasks[0].id).toBe(f.a);
  const select = root.querySelector<HTMLSelectElement>("[data-identity]")!; select.value = f.board.children[1].worker!;
  select.dispatchEvent(new Event("change", { bubbles: true }));
  expect(projection().children[0].id).toBe(f.cb); expect(projection().quota).toBeUndefined();
  expect(root.querySelectorAll("[data-op]")).toHaveLength(0); expect(f.board.receipts).toHaveLength(8);
});
test("language updates preserve an unsaved limit input, focus and independent instances", () => {
  const { root, click, view } = mount({ state: "unavailable" });
  click('[data-tab="roles"]'); click('[data-limit="worker"]');
  const input = root.querySelector<HTMLInputElement>('input[name="limit"]')!; input.value = "13"; input.focus();
  const second = mount({ state: "unavailable" });
  view.setLocale("en");
  expect(root.querySelector('input[name="limit"]') === input).toBe(true); expect(input.value).toBe("13"); expect(document.activeElement === input).toBe(true);
  expect(root.textContent).toContain("Concurrent Worker limit"); expect(second.root.textContent).toContain("全局看板");
  root.querySelector(".cw-overlay")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  expect(document.activeElement === root.querySelector('[data-limit="worker"]')).toBe(true);
});
test("failed persistence keeps the input and old quota, then allows a retry", async () => {
  let calls = 0;
  const { root, click } = mount({ state: "unavailable" }, async () => { if (++calls === 1) throw new Error("disk"); });
  click('[data-tab="roles"]'); click('[data-limit="worker"]');
  const input = root.querySelector<HTMLInputElement>('input[name="limit"]')!; input.value = "17";
  const form = root.querySelector<HTMLFormElement>("form")!;
  form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(root.textContent).toContain("保存失败"); expect(input.value).toBe("17"); expect(input.disabled).toBe(false);
  form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(root.querySelector<HTMLElement>(".cw-overlay")?.hidden).toBe(true); expect(root.textContent).toContain("/ 17 正在执行");
});
test("revocation removes private data and open drawers; Skill stays readable", () => {
  const f = fixture(), { root, click, view } = mount({ state: "ready", board: f.board });
  click(`[data-task="${f.a}"]`); click(`[data-child="${f.ca}"]`);
  view.setConnection({ state: "forbidden" });
  expect(root.textContent).not.toContain("Subtask A"); expect(root.textContent).toContain("无权查看");
  expect(root.querySelector<HTMLElement>(".cw-overlay")?.hidden).toBe(true);
  click('[data-tab="skill"]'); expect(root.querySelector<HTMLTextAreaElement>("[data-skill-full]")?.value).toBe(SKILL_CONTENT);
});
test("unmount during save ignores late completion and cleans every owned element", async () => {
  let finish!: () => void;
  const { root, click, view } = mount({ state: "unavailable" }, () => new Promise<void>(resolve => { finish = resolve; }));
  click('[data-tab="roles"]'); click('[data-limit="worker"]');
  root.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  view.destroy(); finish(); await Promise.resolve(); view.destroy();
  expect(root.childNodes.length).toBe(0);
});
