#!/usr/bin/env bun
import { buildApp, packApp, validateManifestFile, readSourceReviewEvidence } from "./index";
import { join, resolve } from "node:path";
import { BuildError } from "@reai/app-cli";
const usage="reai-app-i18n validate <appDir> | build <appDir> | pack <appDir> --out <package.reaiapp> [--source-review <evidence.json>]";
async function main(){
  const [command,directory,...args]=process.argv.slice(2);
  if(command==="--help"||command==="-h"){console.log(usage);return;}
  if(command==="--version"){console.log("1.0.0");return;}
  if(!directory)throw new Error(usage);
  const reviewIndex=args.indexOf("--source-review"),reviewPath=reviewIndex<0?undefined:args[reviewIndex+1];
  if(reviewIndex>=0&&(!reviewPath||reviewPath.startsWith("--")||args.lastIndexOf("--source-review")!==reviewIndex))throw new Error(usage);
  const sourceReview=reviewPath?readSourceReviewEvidence(reviewPath):undefined;
  if(sourceReview)console.log("Source review evidence: local submission preflight only; no Host runtime authorization");
  if(command==="validate"){
    const findings=validateManifestFile(join(resolve(directory),"app.manifest.json"),true,sourceReview);
    if(findings.length)throw new BuildError("Plugin language validation failed",findings);
    console.log("✓ Manifest, language resources and metadata references validated");
  }else if(command==="build"){
    await buildApp(directory,true,sourceReview);console.log("✓ Built with language validation");
  }else if(command==="pack"){
    const index=args.indexOf("--out"),output=index<0?undefined:args[index+1];
    if(!output)throw new Error(usage);
    const result=await packApp(directory,output,true,sourceReview);console.log(`✓ ${result.outputPath}\nSHA-256 ${result.archiveDigest}`);
  }else throw new Error(usage);
}
main().catch(error=>{console.error(error instanceof Error?error.message:String(error));if(error instanceof BuildError)for(const f of error.findings)console.error(`[${f.code}] ${f.pointer}: ${f.detail}`);process.exitCode=1;});
