import { expect, test } from "bun:test";
import fixture from "../../contract/i18n-v2-target-fixtures.json";
import schema from "../../contract/schemas/app-manifest-1.1.schema.json";
import { metadataTargets, validateI18nDeclaration, validateLocaleBytes } from "../src/resources";

function manifest(version = 2): any {
  return { name: "Source name", ...structuredClone(fixture.overlay),
    contributes: {}, requires: { hostCapabilities: [`metadata.i18n@${version}`] },
    i18n: { locales: ["zh", "en"], messages: [{ target: "name", key: "metadata.name" }, ...(version === 2 ? structuredClone(fixture.references) : [])] } };
}
const identity = (ref: any) => `${ref.target}${ref.id === undefined && ref.index === undefined ? "" : `:${ref.id ?? ref.index}`}`;

test("v1 still validates only its original targets despite visible extended source fields", () => {
  const m = manifest(1);
  expect([...metadataTargets(m).keys()]).toEqual(["name"]);
  expect(validateI18nDeclaration(m)).toEqual([]);
  m.i18n.messages.push(fixture.references[0]);
  expect(validateI18nDeclaration(m).some(f => f.detail.includes("unknown metadata target"))).toBe(true);
});

test("v2 includes every real visible target, resolves positions and IDs without altering source", () => {
  const m = manifest(); const before = JSON.stringify(m);
  expect([...metadataTargets(m).keys()].sort()).toEqual(m.i18n.messages.map(identity).sort());
  expect(metadataTargets(m).get("storeListing.capability.detail:1")).toBe("Other detail");
  expect(metadataTargets(m).get("permission.purpose:local.files@1")).toBe("Source files purpose");
  expect(metadataTargets(m).get("requirement.displayName:runtime.example")).toBe("Source Runtime");
  expect(validateI18nDeclaration(m)).toEqual([]);
  expect(JSON.stringify(m)).toBe(before);
});

test("v2 cannot omit any present field; absent optional fields are not invented", () => {
  const m = manifest(); m.i18n.messages.pop();
  expect(validateI18nDeclaration(m).some(f => f.detail.includes("missing metadata target requirement.displayName:runtime.example"))).toBe(true);
  delete m.storeListing.tagline;
  m.i18n.messages = m.i18n.messages.filter((r: any) => r.target !== "storeListing.tagline");
  m.i18n.messages.push(fixture.references.at(-1));
  expect(validateI18nDeclaration(m)).toEqual([]);
});

test("v2 rejects malformed, out-of-bounds, duplicated and non-visible references", () => {
  const variants = [
    { target: "storeListing.capability.label", index: -1 },
    { target: "storeListing.capability.label", index: 2 },
    { target: "storeListing.capability.label", index: 0.5 },
    { target: "storeListing.capability.label", index: "0" },
    { target: "storeListing.capability.label", id: "0" },
    { target: "storeListing.capability.label", index: 0, id: "0" },
    { target: "storeListing.category", index: 0 },
    { target: "permission.purpose", index: 0 },
    { target: "permission.purpose", id: "../local.files@1" },
    { target: "requirement.remediation.label", id: "runtime.example" },
    { target: "storeListing.phaseOneCommitment", index: 3 },
    { target: "storeListing.screenshot.caption", index: 0, path: "../../other" },
  ];
  for (const ref of variants) {
    const m = manifest(); m.i18n.messages.push({ ...ref, key: "metadata.extra" });
    expect(validateI18nDeclaration(m).length, JSON.stringify(ref)).toBeGreaterThan(0);
  }
  const m = manifest(); m.i18n.messages.push({ ...fixture.references[3] });
  expect(validateI18nDeclaration(m).some(f => f.code === "MANIFEST_DUPLICATE_ID")).toBe(true);
});

test("v2 package languages cover all declared metadata and preserve existing text safety", () => {
  const m = manifest();
  const resource = { metadata: Object.fromEntries(m.i18n.messages.map((r: any, i: number) => [r.key.split(".")[1], `Label ${i}`])) };
  const bytes = new TextEncoder().encode(JSON.stringify(resource));
  const files = new Map([["assets/locales/zh.json", bytes], ["assets/locales/en.json", bytes]]);
  expect(validateLocaleBytes(m, files, true)).toEqual([]);
  resource.metadata.runtime = "Runtime {name}";
  files.set("assets/locales/en.json", new TextEncoder().encode(JSON.stringify(resource)));
  expect(validateLocaleBytes(m, files, true).length).toBeGreaterThan(0);
});

test("schema advertises the same v2 reference targets and a bounded integer position", () => {
  const properties: any = schema.properties.i18n.properties.messages.items.properties;
  for (const ref of fixture.references) expect(properties.target.enum).toContain(ref.target);
  expect(properties.index).toMatchObject({ type: "integer", minimum: 0 });
});
