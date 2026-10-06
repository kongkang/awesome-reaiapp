import { expect, test } from "bun:test";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
test("bounded real XML/XLSB/BIFF controls and fixed reader generation", async () => {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "spreadsheet-hyperlink-controls-child.ts")], { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill(), 15000);
  const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]); clearTimeout(timer);
  if (process.env.HYPERLINK_EVIDENCE_DIR) {
    mkdirSync(process.env.HYPERLINK_EVIDENCE_DIR, { recursive: true }); writeFileSync(join(process.env.HYPERLINK_EVIDENCE_DIR, "controls.json"), JSON.stringify({ childPid: child.pid, childReaped: true, exit, stdout, stderr }, null, 2));
  }
  expect(exit).toBe(0); expect(stderr).toBe("");
  const result = JSON.parse(stdout.trim()); expect(result.networkAttempts).toBe(0); expect(result.allControlsPassed).toBe(true); expect(result.readerDriftCheck).toBe(true);
  expect(result.reports.length).toBeGreaterThanOrEqual(30);
}, 20000);
