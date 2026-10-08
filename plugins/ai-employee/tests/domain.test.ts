import { describe, expect, test } from "bun:test";
import { cleanSource, createRawSource, LIMITS, parseMoney, validateProfile, validateRecordValues } from "../src/domain";
import { FINANCE_PROFILE, HR_PROFILE } from "../src/profiles";

describe("immutable sources and role schemas", () => {
  test("hash identifies the original bytes independently of the filename", async () => {
    const bytes = new TextEncoder().encode("日期,金额\r\n2026-10-08,10.25\r\n");
    const first = await createRawSource({ name: "a.csv", bytes }, "2026-10-08T00:00:00Z");
    const second = await createRawSource({ name: "b.csv", bytes }, "2026-10-08T00:00:01Z");
    expect(first.id).toBe(second.id);
    expect(first.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(first.text).toContain("\r\n");
    expect(first.byteLength).toBe(bytes.byteLength);
  });
  test("rejects originals above 128 KiB and invalid UTF-8", async () => {
    await expect(createRawSource({ name: "huge.csv", bytes: new Uint8Array(131073) }, "now")).rejects.toThrow();
    await expect(createRawSource({ name: "bad.csv", bytes: new Uint8Array([0xff]) }, "now")).rejects.toThrow();
  });
  test("CSV handles aliases, quoted commas and currency in integer cents", () => {
    const result = cleanSource('日期,收支,对方,金额,说明\r\n2026-10-08,支出,"甲,乙",12.30,"办公用品"\r\n', "a.csv", FINANCE_PROFILE);
    expect(result.issues).toEqual([]);
    expect(result.rows[0]?.values).toMatchObject({ date: "2026-10-08", direction: "支出", counterparty: "甲,乙", amount: 1230 });
  });
  test("JSON uses the HR schema and rejects malformed dates", () => {
    const result = cleanSource(JSON.stringify([{ date: "2026-10-08", name: "示例员工", department: "产品", position: "经理", status: "在职", salary: "100.01" }]), "a.json", HR_PROFILE);
    expect(result.rows[0]?.values.salary).toBe(10001);
    expect(cleanSource('日期,收支,对方,金额\n2026-02-30,收入,甲,1\n', "bad.csv", FINANCE_PROFILE).issues.length).toBeGreaterThan(0);
  });
  test("rejects unknown data fields and keeps invalid rows visible as issues", () => {
    expect(cleanSource('日期,收支,对方,金额\n2026-10-08,收入,甲,NaN\n', "bad.csv", FINANCE_PROFILE).issues[0]?.field).toBe("amount");
    expect(() => validateRecordValues({ ...{ date: "2026-10-08", direction: "收入", counterparty: "甲", amount: 100 }, secret: "x" }, FINANCE_PROFILE)).toThrow();
  });
  test("money conversion does not round away hidden precision", () => {
    expect(parseMoney("0.29")).toBe(29);
    expect(parseMoney("1,234.56")).toBe(123456);
    expect(() => parseMoney("1.005")).toThrow();
    expect(() => parseMoney("-1")).toThrow();
    expect(() => parseMoney("1e5")).toThrow();
  });
  test("individual money amounts reserve safe precision for 1000-record aggregates", () => {
    const maximum = Math.floor(Number.MAX_SAFE_INTEGER / LIMITS.records);
    const values = { date: "2026-10-08", direction: "收入", counterparty: "甲", amount: maximum };
    expect(validateRecordValues(values, FINANCE_PROFILE).amount).toBe(maximum);
    expect(() => validateRecordValues({ ...values, amount: maximum + 1 }, FINANCE_PROFILE)).toThrow();
    expect(() => parseMoney(((maximum + 1) / 100).toFixed(2))).toThrow();
  });
  test("profile import rejects secrets, duplicate fields and active UI content", () => {
    expect(validateProfile(FINANCE_PROFILE).id).toBe("finance");
    expect(() => validateProfile({ ...FINANCE_PROFILE, password: "private" })).toThrow();
    expect(() => validateProfile({ ...FINANCE_PROFILE, fields: [...FINANCE_PROFILE.fields, FINANCE_PROFILE.fields[0]] })).toThrow();
    expect(() => validateProfile({ ...FINANCE_PROFILE, ui: { ...FINANCE_PROFILE.ui, css: "@import 'https://example.com/x.css';" } })).toThrow();
    expect(() => validateProfile({ ...FINANCE_PROFILE, ui: { ...FINANCE_PROFILE.ui, css: ".role-summary { position: fixed; }" } })).toThrow();
    expect(() => validateProfile({ ...FINANCE_PROFILE, ui: { ...FINANCE_PROFILE.ui, html: '<img src=x onerror="alert(1)">' } })).toThrow();
  });
  test("the read-only Demo rejects tool references that it cannot execute", () => {
    expect(() => validateProfile({ ...FINANCE_PROFILE, agent: { ...FINANCE_PROFILE.agent, tools: ["write"] } })).toThrow();
  });
  test("skill documents share the Host aggregate character budget", () => {
    const profile = { ...FINANCE_PROFILE, agent: { ...FINANCE_PROFILE.agent, skills: [
      { id: "first", title: "First", content: "a".repeat(16384) },
      { id: "second", title: "Second", content: "b".repeat(16384) },
    ] } };
    expect(validateProfile(profile).agent.skills.length).toBe(2);
    profile.agent.skills[1]!.content += "b";
    expect(() => validateProfile(profile)).toThrow("skill正文总量");
  });
});
