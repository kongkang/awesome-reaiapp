/** Modern validation/build/pack; the frozen CLI supplies only public primitives. */
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { BuildError, PackError, type Finding } from "@reai/app-cli";
export { buildApp } from "./build";
import { createArchive } from "./pack";
import { validateManifest } from "./gateway";
export { validateManifest } from "./gateway";
import { validateLocaleBytes, validateLocaleDirectory } from "./resources";
export * from "./resources";
export * from "./source-review-evidence";
import { assertSourceReviewArchive, type SourceReviewEvidence } from "./source-review-evidence";

export function validateManifestFile(path: string, requireI18n = true, sourceReview?: SourceReviewEvidence): Finding[] {
  try {
    const manifest=JSON.parse(readFileSync(path,"utf8"));
    const findings=validateManifest(manifest,sourceReview,dirname(path));
    return findings.length ? findings : validateLocaleDirectory(dirname(path),manifest,requireI18n);
  } catch(error) { return [{code:"MANIFEST_SCHEMA_INVALID",pointer:"app.manifest.json",detail:String(error)}]; }
}
function preflight(root: string, requireI18n: boolean, sourceReview?: SourceReviewEvidence): void {
  const findings=validateManifestFile(join(root,"app.manifest.json"),requireI18n,sourceReview);
  if(findings.length)throw new BuildError("Plugin language validation failed",findings);
}

/** Parse the deterministic store-only ZIP emitted by the frozen builder, checking exact output bytes. */
export function packedFiles(zip: Buffer): Map<string, Uint8Array> {
  const files=new Map<string,Uint8Array>();let at=0;
  while(at+4<=zip.length&&zip.readUInt32LE(at)===0x04034b50){
    if(at+30>zip.length||zip.readUInt16LE(at+8)!==0||(zip.readUInt16LE(at+6)&0x0009)!==0)throw new PackError("Unsupported or truncated package entry");
    const size=zip.readUInt32LE(at+18),nameLength=zip.readUInt16LE(at+26),extraLength=zip.readUInt16LE(at+28),start=at+30+nameLength+extraLength;
    if(start+size>zip.length||zip.readUInt32LE(at+22)!==size)throw new PackError("Invalid package entry size");
    const name=new TextDecoder("utf-8",{fatal:true}).decode(zip.subarray(at+30,at+30+nameLength));
    if(files.has(name))throw new PackError("Duplicate package entry");
    files.set(name,zip.subarray(start,start+size));at=start+size;
  }
  if(!files.has("app.manifest.json")||at+4>zip.length||zip.readUInt32LE(at)!==0x02014b50)throw new PackError("Invalid package directory");
  return files;
}
/** Build Manifest and every actual ZIP resource must describe the same immutable bytes. */
export function verifyPackagedResources(files: Map<string, Uint8Array>): Record<string, unknown> {
  const decode = (path:string) => {
    const bytes=files.get(path);if(!bytes)throw new PackError(`Missing ${path}`);
    return JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes));
  };
  const manifest=decode("app.manifest.json"),build=decode("build-manifest.json");
  if(build.appId!==manifest.appId||build.version!==manifest.version||!Array.isArray(build.files))throw new PackError("Package manifest identity mismatch");
  const seen=new Set<string>();
  for(const entry of build.files){
    const bytes=files.get(entry.path);
    if(seen.has(entry.path)||entry.path==="build-manifest.json"||!bytes||bytes.byteLength!==entry.size||createHash("sha256").update(bytes).digest("hex")!==entry.sha256)throw new PackError(`Package resource mismatch: ${entry.path}`);
    seen.add(entry.path);
  }
  if(seen.size!==files.size-1)throw new PackError("Package resource whitelist differs");
  return manifest;
}
export async function packApp(root: string, outputPath: string, requireI18n = true, sourceReview?: SourceReviewEvidence) {
  preflight(root,requireI18n,sourceReview);
  const output=resolve(outputPath),temp=mkdtempSync(join(dirname(output),".reai-i18n-"));
  try {
    const { archive, ...result }=await createArchive(root,requireI18n,sourceReview);
    const files=packedFiles(archive);
    const manifest=verifyPackagedResources(files);
    const findings=[...validateManifest(manifest,sourceReview,root),...validateLocaleBytes(manifest,files,requireI18n)];
    if(findings.length)throw new BuildError("Packaged language validation failed",findings);
    assertSourceReviewArchive(sourceReview,archive);
    const candidate=join(temp,"candidate.reaiapp");
    writeFileSync(candidate,archive);
    renameSync(candidate,output);
    return {...result,outputPath:output};
  } finally { rmSync(temp,{recursive:true,force:true}); }
}
