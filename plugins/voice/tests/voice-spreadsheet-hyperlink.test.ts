import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const fixture = join(import.meta.dir, "fixtures/hyperlink-range-1001.xlsx");
const fixtureSha256 = "0a89b1caa1881ec9a0044a463e39ea9338d09dd95dc46e9acaed0d658941240c";
for (const mode of ["direct", "worker"]) test(`${mode}: same-byte range rejects before hyperlink stub assignment`, async () => {
  const bytes = readFileSync(fixture);
  expect(bytes.length).toBe(15911);
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(fixtureSha256);
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "spreadsheet-hyperlink-child.ts"), fixture, mode], { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill(), 10000);
  const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  clearTimeout(timer);
  if (process.env.HYPERLINK_EVIDENCE_DIR) {
    mkdirSync(process.env.HYPERLINK_EVIDENCE_DIR, { recursive: true });
    writeFileSync(join(process.env.HYPERLINK_EVIDENCE_DIR, `${mode}.json`), JSON.stringify({ childPid: child.pid, childReaped: true, exit, stdout, stderr }, null, 2));
  }
  expect(exit).toBe(0);
  expect(stderr).toBe("");
  const observed = JSON.parse(stdout.trim());
  console.info(`HYPERLINK_OBSERVATION=${stdout.trim()}`);
  expect(observed.inputSha256).toBe(fixtureSha256);
  expect(observed.networkAttempts).toBe(0);
  expect(observed.result.code).toBe("VOICE_ATTACHMENT_DOCUMENT_LIMIT");
  if (mode === "worker") expect(observed.result.networkAttempts).toBe(0);
  expect(observed.result.stubAssignments).toBe(0);
}, 15000);
