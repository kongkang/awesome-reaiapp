import { describe, expect, test } from "bun:test";
import { EmployeeController } from "../src/controller";
import { EmployeeRepository } from "../src/repository";
import { FINANCE_PROFILE, HR_PROFILE } from "../src/profiles";
import { MemoryStore } from "./repository.test";

const csv = "日期,收支,对方,金额,说明\n2026-10-08,收入,演示客户,100.25,服务费\n2026-10-08,支出,演示供应商,20.10,办公用品\n";
async function fixture(store = new MemoryStore()) { const controller = new EmployeeController(new EmployeeRepository(store), { defaultProfile: FINANCE_PROFILE }); await controller.init(); return { controller, store }; }

describe("three-stage employee workflow", () => {
  test("a generated role keeps both built-in roles available without unused bootstrap objects", async () => {
    const custom = { ...FINANCE_PROFILE, id: "support", name: "客服工作台", jobTitle: "AI 客服专员" };
    const controller = new EmployeeController(new EmployeeRepository(new MemoryStore()), { defaultProfile: custom }); await controller.init();
    expect(controller.snapshot().profile.id).toBe("support");
    expect(controller.snapshot().availableProfiles.map(profile => profile.id).sort()).toEqual(["finance", "hr", "support"]);
    expect(controller.snapshot().storage.orphanCount).toBe(0);
    await controller.setupPassword("example-password-42"); await controller.switchProfile("finance");
    expect(controller.snapshot().profile.id).toBe("finance");
    await controller.switchProfile("hr"); expect(controller.snapshot().profile.id).toBe("hr");
    await controller.switchProfile("support"); expect(controller.snapshot().profile.id).toBe("support");
  });
  test("stores 128 KiB once and preserves binary originals without claiming extraction", async () => {
    const { controller, store } = await fixture();
    const source = await controller.importBytes({ name: "invoice.pdf", bytes: new Uint8Array(131072).fill(255), mimeType: "application/pdf" });
    const persisted = store.values.get(`raw/${source.id}`) as Record<string, unknown>;
    expect(persisted.text).toBeUndefined();
    expect(new TextEncoder().encode(JSON.stringify(persisted)).length).toBeLessThan(262144);
    expect((await controller.getSource(source.id)).byteLength).toBe(131072);
    expect((await controller.processSource(source.id)).issues.length).toBe(1);
    expect(controller.snapshot().sources[0]?.status).toBe("pending");
  });
  test("imports, cleans, revises, archives and reloads without changing original bytes", async () => {
    const { controller, store } = await fixture();
    const source = await controller.appendText({ name: "ledger.csv", text: csv });
    expect((await controller.processSource(source.id)).createdCount).toBe(2);
    const original = await controller.getSource(source.id); const row = controller.snapshot().records[0]!;
    await controller.editRecord(row.id, { amount: 10100 }, row.revision);
    await controller.archiveRecord(row.id, 2);
    expect(controller.snapshot().records.find(item => item.id === row.id)?.revision).toBe(3);
    expect((await controller.getSource(source.id)).bytesBase64).toBe(original.bytesBase64);
    expect((await controller.getRecordHistory(row.id)).map(item => item.revision)).toEqual([1, 2, 3]);
    const reopened = (await fixture(store)).controller;
    expect(reopened.snapshot().records.length).toBe(2);
    expect(reopened.snapshot().sources[0]?.status).toBe("processed");
    expect(reopened.snapshot().audit.length).toBeGreaterThanOrEqual(3);
  });
  test("same SHA imports once and same-source processing does not duplicate rows", async () => {
    const { controller } = await fixture();
    const source = await controller.appendText({ name: "one.csv", text: csv });
    await controller.appendText({ name: "two.csv", text: csv });
    await controller.processSource(source.id); await controller.processSource(source.id);
    expect(controller.snapshot().sources.length).toBe(1);
    expect(controller.snapshot().records.length).toBe(2);
  });
  test("invalid rows publish no partial standard records", async () => {
    const { controller } = await fixture();
    const source = await controller.appendText({ name: "bad.csv", text: csv + "2026-10-08,收入,甲,bad,x\n" });
    const result = await controller.processSource(source.id);
    expect(result.issues.length).toBeGreaterThan(0);
    expect(controller.snapshot().records).toEqual([]);
    expect(controller.snapshot().sources[0]?.status).toBe("pending");
  });
  test("developer password unlock stays in memory and export contains only role configuration", async () => {
    const { controller, store } = await fixture();
    await expect(controller.saveProfile(FINANCE_PROFILE)).rejects.toThrow();
    await controller.setupPassword("example-password-42"); controller.lock();
    expect(await controller.unlock("wrong-password")).toBe(false);
    expect(await controller.unlock("example-password-42")).toBe(true);
    await controller.switchProfile(HR_PROFILE.id);
    const exported = controller.exportProfile();
    expect(JSON.parse(exported).id).toBe("hr");
    expect(exported).not.toContain("example-password-42");
    expect(exported).not.toContain("sources");
    expect((await fixture(store)).controller.snapshot().developerUnlocked).toBe(false);
  });
  test("a schema change cannot reinterpret existing records", async () => {
    const { controller } = await fixture(); await controller.setupPassword("example-password-42");
    const source = await controller.appendText({ name: "ledger.csv", text: csv }); await controller.processSource(source.id);
    await expect(controller.saveProfile({ ...FINANCE_PROFILE, fields: FINANCE_PROFILE.fields.slice(1) })).rejects.toThrow();
  });
  test("stale record edits fail and reports remain separate derived objects", async () => {
    const { controller } = await fixture(); const source = await controller.appendText({ name: "ledger.csv", text: csv }); await controller.processSource(source.id);
    const record = controller.snapshot().records[0]!; await controller.editRecord(record.id, { amount: 1234 }, 1);
    await expect(controller.editRecord(record.id, { amount: 9999 }, 1)).rejects.toThrow();
    const report = await controller.saveReport({ title: "现金流", body: "仅基于示例数据", kind: "demo", sourceIds: [source.id], recordIds: [record.id] });
    expect(controller.snapshot().reports[0]?.id).toBe(report.id);
    expect(controller.snapshot().records.find(item => item.id === record.id)?.values.amount).toBe(1234);
  });
  test("report references preserve prior revisions and reject nonexistent ones", async () => {
    const { controller } = await fixture(); const source = await controller.appendText({ name: "ledger.csv", text: csv }); await controller.processSource(source.id);
    const record = controller.snapshot().records[0]!; await controller.editRecord(record.id, { amount: 10000 }, 1);
    const report = await controller.saveReport({ title: "原版本分析", text: "复核原始整理结果", mode: "演示分析·非大模型", sourceIds: [source.id], recordRefs: [{ id: record.id, revision: 1 }] });
    expect(report.recordRefs).toEqual([{ id: record.id, revision: 1 }]);
    await expect(controller.saveReport({ title: "错误引用", body: "错误", recordRefs: [{ id: record.id, revision: 999 }] })).rejects.toThrow();
  });
  test("a queued company change invalidates a report even when its caller observes the prior revision", async () => {
    const { controller } = await fixture();
    const basedOnRevision = controller.snapshot().revision;
    const queuedChange = controller.setCompanySettings({ name: "更新后的示例公司" });
    // The caller can still see the old snapshot while a prior action is queued.
    expect(controller.snapshot().revision).toBe(basedOnRevision);
    const queuedReport = controller.saveReport({ title: "旧配置分析", text: "基于之前的公司要求", basedOnRevision });
    const rejected = expect(queuedReport).rejects.toThrow("重新分析");
    await queuedChange;
    await rejected;
    expect(controller.snapshot().company.name).toBe("更新后的示例公司");
    expect(controller.snapshot().reports).toEqual([]);
    expect(controller.snapshot().storage.orphanCount).toBe(0);
    const latestRevision = controller.snapshot().revision;
    const current = await controller.saveReport({ title: "新配置分析", text: "基于当前公司要求", basedOnRevision: latestRevision });
    expect(current.dataRevision).toBe(latestRevision);
  });
});
