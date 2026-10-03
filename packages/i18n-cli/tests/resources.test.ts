import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fixtures from "@reai/app-contract/i18n-fixtures.json";
import { parseMessages, validateLocaleBytes, validateLocaleDirectory, validateI18nDeclaration } from "../src/resources";
const bytes = (text: string) => new TextEncoder().encode(text);
const manifest = () => ({ name: "Original", requires: { hostCapabilities: ["metadata.i18n@1"] }, contributes: {}, i18n: { locales: ["zh", "en"], messages: [{ target: "name", key: "metadata.name" }] } });
const files = () => new Map([ ["assets/locales/zh.json", bytes('{"metadata":{"name":"名称"},"saved":"已保存 {name}"}')], ["assets/locales/en.json", bytes('{"metadata":{"name":"Name"},"saved":"Saved {name}"}')] ]);
test("translated titlebar metadata fits the Host display guards", () => {
  for (const [target, limit] of [["titlebarAction.label", 48], ["titlebarAction.text", 12], ["titlebarStatus.label", 24]] as const) {
    const m: any = manifest();
    if (target === "titlebarStatus.label") m.contributes.titlebarStatus = { label: "Status", tone: "neutral" };
    else m.contributes.titlebarActions = [{ id: "action", label: "Action", ...(target.endsWith("text") ? { text: "Run" } : { icon: "plus" }) }];
    const { metadataTargets } = require("../src/resources");
    m.i18n.messages = [...metadataTargets(m).keys()].map((identity: string) => {
      const [target, id] = identity.split(":"); return { target, ...(id ? { id } : {}), key: "metadata.name" };
    });
    for (const [length, valid] of [[limit, true], [limit + 1, false]] as const) {
      const resource = bytes(JSON.stringify({ metadata: { name: "😀".repeat(length) } }));
      const findings = validateLocaleBytes(m, new Map([ ["assets/locales/zh.json", resource], ["assets/locales/en.json", resource] ]));
      expect(findings.some(f => f.detail.includes("characters"))).toBe(!valid);
    }
  }
});
for (const fixture of fixtures) test(`shared language fixture: ${fixture.name}`, () => {
  if (fixture.valid) expect(parseMessages(bytes(fixture.source)).size).toBeGreaterThan(0);
  else expect(() => parseMessages(bytes(fixture.source))).toThrow();
});
test("UTF-8, byte and depth limits are enforced", () => {
  expect(() => parseMessages(new Uint8Array([0xff]))).toThrow();
  expect(() => parseMessages(bytes('{"a":"'+ 'x'.repeat(256*1024)+'"}'))).toThrow();
  expect(() => parseMessages(bytes('{"a":'.repeat(17)+'"x"'+'}'.repeat(17)))).toThrow();
});
test("locale parity, interpolation and immutable package byte validation", () => {
  const m=manifest(); const f=files();
  expect(validateLocaleBytes(m,f)).toEqual([]);
  f.set("assets/locales/zh.json",bytes('{"metadata":{"name":"名称"},"saved":"已保存 {other}"}'));
  expect(validateLocaleBytes(m,f).some(i=>i.detail.includes("interpolation"))).toBe(true);
  f.delete("assets/locales/en.json"); expect(validateLocaleBytes(m,f).length).toBeGreaterThan(0);
  expect(validateLocaleBytes({},new Map())).toEqual([]);
  expect(validateLocaleBytes({},new Map(),true).length).toBeGreaterThan(0);
});
test("metadata must be complete, declared, stable and non-interpolated", () => {
  const m=manifest();
  m.i18n.messages[0]!.key="metadata.absent"; expect(validateLocaleBytes(m,files()).length).toBeGreaterThan(0);
  m.i18n.messages[0]!.key="saved"; expect(validateLocaleBytes(m,files()).length).toBeGreaterThan(0);
  m.i18n.messages[0]!.key="metadata.name"; m.i18n.messages.push({...m.i18n.messages[0]!});
  expect(validateI18nDeclaration(m).some(f=>f.code==="MANIFEST_DUPLICATE_ID")).toBe(true);
  m.i18n.messages.pop(); m.requires.hostCapabilities=[];
  expect(validateI18nDeclaration(m).some(f=>f.code==="MANIFEST_REFERENCE_INVALID")).toBe(true);
});
test("extra languages must be complete and malformed files are checked without a declaration", () => {
  const f=files(); f.set("assets/locales/ja.json",bytes('{"metadata":{"name":"名前"}}'));
  expect(validateLocaleBytes(manifest(),f).length).toBeGreaterThan(0);
  expect(validateLocaleBytes({},f).length).toBeGreaterThan(0);
});
test("validate reads actual locale files and rejects missing declared files", () => {
  const root=mkdtempSync(join(tmpdir(),"reai-locale-"));
  try { mkdirSync(join(root,"assets/locales"),{recursive:true}); for(const [path,value] of files()) writeFileSync(join(root,path),value);
    expect(validateLocaleDirectory(root,manifest())).toEqual([]);
    rmSync(join(root,"assets/locales/en.json")); expect(validateLocaleDirectory(root,manifest()).length).toBeGreaterThan(0);
  } finally { rmSync(root,{recursive:true,force:true}); }
});

for (const metadataVersion of [1, 2]) test(`strict v${metadataVersion} validate/build/pack gate checks the actual archive resources`, async () => {
  const { readFileSync } = await import("node:fs");
  const { createHash } = await import("node:crypto");
  const { metadataTargets } = await import("../src/resources");
  const { validateManifestFile } = await import("../src/index");
  const { packApp, verifyPackagedResources } = await import("../src/index");
  const { buildApp } = await import("../src/index");
  const root=mkdtempSync(join(tmpdir(),"reai-i18n-pack-"));
  try {
    const m=JSON.parse(readFileSync(new URL("../../fixtures/apps/minimal/app.manifest.json",import.meta.url),"utf8"));
    m.requires.hostCapabilities.push(`metadata.i18n@${metadataVersion}`);
    if (metadataVersion === 2) m.storeListing = (await import("../../contract/i18n-v2-target-fixtures.json")).default.overlay.storeListing;
    const definitions = (await import("../../contract/i18n-targets.json")).default;
    m.i18n={locales:["zh","en"],messages:[...metadataTargets(m).keys()].map((identity,i)=>{const [target,id]=identity.split(":");return {target,...(id === undefined ? {} : definitions.find((d:any)=>d.target===target)?.indexed ? {index:Number(id)} : {id}),key:`metadata.key${i}`};})};
    const resource=bytes(JSON.stringify({metadata:Object.fromEntries(m.i18n.messages.map((_:unknown,i:number)=>[`key${i}`,`Label ${i}`]))}));
    mkdirSync(join(root,"src")); mkdirSync(join(root,"assets/locales"),{recursive:true});
    writeFileSync(join(root,"src/app.ts"),"export default { activate() {} };");
    writeFileSync(join(root,"app.manifest.json"),JSON.stringify(m));
    for(const lang of ["zh","en"])writeFileSync(join(root,`assets/locales/${lang}.json`),resource);
    expect(validateManifestFile(join(root,"app.manifest.json"),true)).toEqual([]);
    const result=await packApp(root,join(root,"out.reaiapp"),true);
    const zip=readFileSync(result.outputPath); const actual=new Map<string,Buffer>(); let at=0;
    while(zip.readUInt32LE(at)===0x04034b50){const size=zip.readUInt32LE(at+18),n=zip.readUInt16LE(at+26),x=zip.readUInt16LE(at+28),start=at+30+n+x;actual.set(zip.subarray(at+30,at+30+n).toString(),zip.subarray(start,start+size));at=start+size;}
    const bm=JSON.parse(actual.get("build-manifest.json")!.toString());
    expect(verifyPackagedResources(actual).appId).toBe(m.appId);
    const tampered=new Map(actual);tampered.set("assets/locales/en.json",Buffer.from("{}"));
    expect(()=>verifyPackagedResources(tampered)).toThrow();
    for(const lang of ["zh","en"]){const path=`assets/locales/${lang}.json`;expect(actual.get(path)).toEqual(Buffer.from(resource));expect(bm.files.find((f:any)=>f.path===path).sha256).toBe(createHash("sha256").update(actual.get(path)!).digest("hex"));}
    writeFileSync(join(root,"assets/locales/en.json"),'{"a":"x","a":"y"}');
    expect(validateManifestFile(join(root,"app.manifest.json"),true).length).toBeGreaterThan(0);
    await expect(buildApp(root,true)).rejects.toThrow();
    await expect(packApp(root,join(root,"bad.reaiapp"),true)).rejects.toThrow();
  } finally { rmSync(root,{recursive:true,force:true}); }
});
