import { afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { EmployeeController } from "../src/controller";
import { EmployeeRepository, type StoreLike } from "../src/repository";
import { EmployeeAgent, createDemoAgentAdapter } from "../src/agent";
import { mountEmployee } from "../src/view";
import { SAMPLE_FINANCE_CSV, SAMPLE_HR_CSV } from "../src/sample-data";
import { FINANCE_PROFILE, HR_PROFILE } from "../src/profiles";

const nativeCrypto = globalThis.crypto;
if (typeof document === "undefined") GlobalRegistrator.register();
Object.defineProperty(globalThis, "crypto", { value: nativeCrypto, configurable: true });
class TestStore implements StoreLike {
  data = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> { return structuredClone(this.data.get(key)) as T | undefined; }
  async set(key: string, value: unknown) { this.data.set(key, structuredClone(value)); }
  async compareAndSet(key: string, expected: unknown, value: unknown) { if (JSON.stringify(this.data.get(key)) !== JSON.stringify(expected)) return false; this.data.set(key, structuredClone(value)); return true; }
  async keys() { return [...this.data.keys()]; }
}
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); document.body.replaceChildren(); });
async function fixture(profile = FINANCE_PROFILE) {
  const controller = new EmployeeController(new EmployeeRepository(new TestStore()), { defaultProfile: profile }); await controller.init();
  const agent = new EmployeeAgent(controller, createDemoAgentAdapter());
  const root = document.createElement("div"); document.body.append(root);
  const view = mountEmployee(root, { controller, agent, version: "0.1.0", appId: "com.reai.ai-employee", changelogText: "## 0.1.0\n本地候选：可追溯的 AI 员工范式。" });
  cleanups.push(() => { view.dispose(); agent.dispose(); });
  return { controller, agent, root, view };
}
function click(root: HTMLElement, action: string) { const target = root.querySelector<HTMLButtonElement>(`[data-action="${action}"]`); if (!target) throw new Error(`Button absent: ${action}`); target.click(); }
function page(root: HTMLElement, name: string) { root.querySelector<HTMLButtonElement>(`[data-page="${name}"]`)!.click(); }
async function until(check: () => boolean) { const end = Date.now() + 3000; while (!check()) { if (Date.now() > end) throw new Error("UI state did not change"); await new Promise(resolve => setTimeout(resolve, 10)); } }
function input(root: HTMLElement, name: string, value: string) { const el = root.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(`[name="${name}"]`); if (!el) throw new Error(`Field absent: ${name}`); el.value = value; }

describe("employee workbench interaction", () => {
  test("imports fictional CSV, processes it, edits cents and keeps original bytes", async () => {
    const { root, controller } = await fixture(); page(root, "sources"); click(root, "import-sample");
    await until(() => controller.snapshot().sources.length === 1 && root.textContent!.includes("虚构演示 CSV 已保存"));
    const source = controller.snapshot().sources[0]!; const original = await controller.getSource(source.id);
    click(root, `process:${source.id}`); await until(() => controller.snapshot().records.length === 5 && root.textContent!.includes("整理完成"));
    page(root, "records"); const record = controller.snapshot().records[0]!; click(root, `edit:${record.id}`);
    input(root, "field:amount", "58000.25"); click(root, "save-record");
    await until(() => controller.snapshot().records.find(r => r.id === record.id)?.revision === 2 && root.textContent!.includes("标准记录已保存")).catch(error => { throw new Error(`${error.message}: ${root.querySelector(".ae-dialog-error")?.textContent}; ${root.querySelector(".ae-feedback")?.textContent}`); });
    expect(controller.snapshot().records.find(r => r.id === record.id)?.values.amount).toBe(5_800_025);
    expect((await controller.getSource(source.id)).bytesBase64).toBe(original.bytesBase64);
    expect(root.querySelector("table")?.textContent).toContain("58,000.25");
  });
  test("explicit CSV text format adds the extension and mismatches preserve the draft", async () => {
    const { root, controller } = await fixture(); page(root, "sources");
    input(root, "name", "十月收支"); input(root, "text", SAMPLE_FINANCE_CSV); click(root, "append-text");
    await until(() => controller.snapshot().sources.length === 1 && root.textContent!.includes("文本资料已保存"));
    const source = controller.snapshot().sources[0]!; expect(source.name).toBe("十月收支.csv"); click(root, `process:${source.id}`);
    await until(() => controller.snapshot().records.length === 5 && root.textContent!.includes("整理完成"));
    input(root, "name", "new-data.json"); input(root, "text", SAMPLE_FINANCE_CSV); click(root, "append-text");
    await until(() => root.textContent!.includes("扩展名与所选格式不一致"));
    expect(controller.snapshot().sources).toHaveLength(1);
    expect(root.querySelector<HTMLInputElement>('[data-form="text"] [name="name"]')?.value).toBe("new-data.json");
    expect(root.querySelector<HTMLTextAreaElement>('[data-form="text"] [name="text"]')?.value).toBe(SAMPLE_FINANCE_CSV);
  });
  test("shows cleaning errors and keeps invalid source pending", async () => {
    const { root, controller } = await fixture(); const source = await controller.appendText({ name: "invalid.csv", text: "日期,收支,金额,对方\n2026-10-01,收入,bad,示例客户\n" });
    page(root, "sources"); click(root, `process:${source.id}`); await until(() => root.textContent!.includes("资料未生成标准记录"));
    expect(controller.snapshot().records.length).toBe(0); expect(controller.snapshot().sources[0]?.status).toBe("pending");
    expect(root.querySelector('[role="alert"]')?.textContent).toContain("金额"); expect(root.textContent).not.toContain("整理完成。");
  });
  test("keyboard form submission shows money validation errors without changing data", async () => {
    const { root, controller } = await fixture(); const source = await controller.appendText({ name: "ledger.csv", text: SAMPLE_FINANCE_CSV }); await controller.processSource(source.id);
    page(root, "records"); const record = controller.snapshot().records[0]!; click(root, `edit:${record.id}`); input(root, "field:amount", "1.005");
    root.querySelector<HTMLFormElement>('[data-form="record"]')!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await until(() => root.querySelector(".ae-dialog-error")!.textContent!.includes("最多两位小数"));
    expect(controller.snapshot().records.find(r => r.id === record.id)?.revision).toBe(1);
    expect(controller.snapshot().records.find(r => r.id === record.id)?.values.amount).toBe(record.values.amount);
  });
  test("archives and restores a derived record without removing source", async () => {
    const { root, controller } = await fixture(); const source = await controller.appendText({ name: "ledger.csv", text: SAMPLE_FINANCE_CSV }); await controller.processSource(source.id);
    page(root, "records"); const record = controller.snapshot().records[0]!; click(root, `archive:${record.id}`); await until(() => root.textContent!.includes("记录已归档"));
    expect(controller.snapshot().sources).toHaveLength(1); expect(controller.snapshot().records.find(r => r.id === record.id)?.archived).toBe(true);
    const check = root.querySelector<HTMLInputElement>("[data-archived]")!; check.checked = true; check.dispatchEvent(new Event("change", { bubbles: true }));
    click(root, `restore:${record.id}`); await until(() => root.textContent!.includes("记录已恢复"));
    expect(controller.snapshot().records.find(r => r.id === record.id)?.archived).toBe(false);
  });
  test("requires password confirmation, rejects wrong password, and changes job profile", async () => {
    const { root, controller } = await fixture(); page(root, "settings");
    input(root, "password", "demo-password-42"); input(root, "confirmPassword", "different-password-42"); click(root, "unlock");
    expect(root.textContent).toContain("两次输入的开发者密码不一致"); expect(controller.snapshot().passwordConfigured).toBe(false);
    input(root, "password", "demo-password-42"); input(root, "confirmPassword", "demo-password-42"); click(root, "unlock"); await until(() => root.textContent!.includes("开发模式已解锁。") && !root.textContent!.includes("正在验证"));
    click(root, "lock"); input(root, "password", "wrong-password-42"); click(root, "unlock"); await until(() => root.textContent!.includes("开发者密码不正确"));
    expect(controller.snapshot().developerUnlocked).toBe(false); expect(root.querySelector("[data-profile-json]")).toBeNull();
    input(root, "password", "demo-password-42"); click(root, "unlock"); await until(() => root.querySelector("[data-role]") !== null && !root.textContent!.includes("正在验证"));
    const role = root.querySelector<HTMLSelectElement>("[data-role]")!; role.value = "hr"; role.dispatchEvent(new Event("change", { bubbles: true })); await until(() => controller.snapshot().profile.id === "hr" && root.textContent!.includes("岗位已切换"));
    page(root, "records"); click(root, "add-record"); expect(root.querySelector(".ae-drawer")?.textContent).toContain("姓名"); expect(root.querySelector('[name="field:amount"]')).toBeNull();
  });
  test("agent supports multiple turns with source citations and saves a report", async () => {
    const { root, controller, agent } = await fixture(); const source = await controller.appendText({ name: "ledger.csv", text: SAMPLE_FINANCE_CSV }); await controller.processSource(source.id);
    click(root, "agent"); input(root, "chat", "汇总当前记录"); click(root, "send-agent"); await until(() => agent.messages.length === 2 && !agent.busy);
    input(root, "chat", "按类别继续汇总"); click(root, "send-agent"); await until(() => agent.messages.length === 4 && !agent.busy);
    expect(root.querySelectorAll("[data-message-id]")).toHaveLength(4); expect(root.querySelector(".ae-chat-sources")?.textContent).toContain("ledger.csv");
    click(root, "save-analysis"); await until(() => controller.snapshot().reports.length === 1 && root.textContent!.includes("分析已保存"));
    expect(controller.snapshot().reports[0]?.kind).toBe("demo"); expect(controller.snapshot().reports[0]?.sourceIds).toContain(source.id); expect(root.querySelector('[data-action="save-analysis"]')).toBeNull();
  });
  test("drawer supports focus cycling, Escape and scrim close", async () => {
    const { root } = await fixture(); const trigger = root.querySelector<HTMLButtonElement>('[data-action="agent"]')!; trigger.focus(); trigger.click();
    const close = root.querySelector<HTMLButtonElement>("[data-close]")!; expect(document.activeElement).toBe(close);
    close.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(root.querySelector('[data-action="send-agent"]'));
    root.querySelector(".ae-drawer")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(root.querySelector<HTMLElement>(".ae-overlay")!.hidden).toBe(true); expect(document.activeElement).toBe(trigger);
    trigger.click(); root.querySelector<HTMLElement>(".ae-overlay")!.click(); expect(root.querySelector<HTMLElement>(".ae-overlay")!.hidden).toBe(true); expect(document.activeElement).toBe(trigger);
  });
  test("unsafe source names and agent content remain inert text", async () => {
    const { root, controller, agent } = await fixture(); await controller.appendText({ name: '<img onerror="alert(1)">.txt', text: "事实资料" }); page(root, "sources");
    expect(root.querySelector("img")).toBeNull(); expect(root.textContent).toContain('<img onerror="alert(1)">.txt');
    agent.messages.push({ id: "inert", role: "assistant", text: "<script>window.evil=true</script>", sourceIds: [] }); click(root, "agent");
    expect(root.querySelector("script")).toBeNull(); expect(root.querySelector("[data-message-id]")?.textContent).toContain("<script>");
  });
  test("job templates display current finance and HR statistics", async () => {
    const finance = await fixture({ ...FINANCE_PROFILE, ui: { ...FINANCE_PROFILE.ui, html: "<section>收入 {{income}} 支出 {{expense}} 净额 {{net}} 缺票 {{pendingInvoices}}</section>" } });
    const source = await finance.controller.appendText({ name: "finance.csv", text: SAMPLE_FINANCE_CSV }); await finance.controller.processSource(source.id);
    const financialStats = finance.root.querySelector("[data-profile-preview]")!.textContent!;
    expect(financialStats).toContain("82,000.00"); expect(financialStats).toContain("17,250.00"); expect(financialStats).toContain("64,750.00"); expect(financialStats).toContain("缺票 1");
    const hr = await fixture({ ...HR_PROFILE, ui: { ...HR_PROFILE.ui, html: "<section>在职 {{activeEmployees}} 部门 {{departmentCount}}</section>" } });
    const people = await hr.controller.appendText({ name: "hr.csv", text: SAMPLE_HR_CSV }); await hr.controller.processSource(people.id);
    expect(hr.root.querySelector("[data-profile-preview]")!.textContent).toBe("在职 2 部门 3");
  });
  test("empty templates omit the preview and binary sources disclose missing extraction", async () => {
    const { root, controller } = await fixture({ ...FINANCE_PROFILE, ui: { ...FINANCE_PROFILE.ui, html: "" } });
    expect(root.querySelector(".ae-profile-preview")).toBeNull();
    const source = await controller.importBytes({ name: "source.pdf", bytes: new TextEncoder().encode("%PDF-1.7 fictional"), mimeType: "application/pdf" }); page(root, "sources"); click(root, `source:${source.id}`);
    await until(() => root.querySelector(".ae-source-content") !== null);
    expect(root.querySelector(".ae-source-content")!.textContent).toContain("二进制原件"); expect(root.querySelector(".ae-source-content")!.textContent).toContain("Demo 暂不执行 OCR");
  });
  test("version and about open precise local candidate details", async () => {
    const { root } = await fixture(); page(root, "settings"); click(root, "version"); expect(root.querySelector(".ae-drawer")?.textContent).toContain("可追溯的 AI 员工范式");
    root.querySelector<HTMLButtonElement>("[data-close]")!.click(); click(root, "about");
    expect(root.querySelector(".ae-drawer")?.textContent).toContain("本地 Demo 候选");
    expect(root.querySelector<HTMLInputElement>('[aria-label="公开应用详情地址"]')?.value).toBe("https://open.reai.com/apps/com.reai.ai-employee");
  });
});
