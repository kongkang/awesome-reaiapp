import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

test("the packaged stylesheet is declared and matches its build-manifest digest", async () => {
  const root = join(import.meta.dir, "..");
  const build = Bun.spawn(["bun", "x", "--no-install", "-p", "@reai/app-cli", "reai-app", "pack", ".", "--out", "titlebar-actions-demo-1.0.2.reaiapp"], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([build.exited, new Response(build.stdout).text(), new Response(build.stderr).text()]);
  expect({ code, error: code === 0 ? "" : stdout + stderr }).toEqual({ code: 0, error: "" });
  const manifest = JSON.parse(readFileSync(join(root, "build-manifest.json"), "utf8"));
  expect(manifest.styles).toEqual(["dist/app.css"]);
  const css = readFileSync(join(root, manifest.styles[0]));
  expect(manifest.files.find((file: { path: string }) => file.path === manifest.styles[0])).toMatchObject({
    size: css.byteLength, sha256: createHash("sha256").update(css).digest("hex"), mime: "text/css",
  });
  const archive = readFileSync(join(root, "titlebar-actions-demo-1.0.2.reaiapp"));
  // CLI's canonical ZIP uses stored entries. Check the actual CSS bytes made it into the package.
  expect(archive.includes(css)).toBe(true);
  expect(css.toString()).toContain("--reai-plugin-titlebar-safe-top");
  expect(readFileSync(join(root, "src/app.ts"), "utf8")).not.toContain('createElement("style")');
}, 20_000);
