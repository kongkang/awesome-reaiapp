import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { validateManifest } from "../src/index";

const contract = join(import.meta.dir, "../../contract");
const read = (path: string) => JSON.parse(readFileSync(path, "utf8"));
for (const [directory, kind] of [
  ["manifest-fixtures", "valid"], ["manifest-fixtures", "invalid"],
  ["gateway-manifest-fixtures", "invalid"],
] as const) {
  const root = join(contract, directory, kind);
  const names = readdirSync(root).filter(name => name.endsWith(".json") && !name.endsWith(".expected.json"));
  test(`${directory}/${kind} is not empty`, () => expect(names.length).toBeGreaterThan(0));
  for (const name of names) test(`modern validator: ${directory}/${kind}/${name}`, () => {
    const actual: string[] = [...new Set(validateManifest(read(join(root, name))).map(({ code }) => code))].sort();
    const expected: string[] = kind === "valid" ? [] : read(join(root, name.replace(/\.json$/, ".expected.json"))).codes;
    expect(actual).toEqual([...new Set(expected)].sort());
  });
}

for (const name of readdirSync(join(contract, "gateway-manifest-fixtures/invalid"))
  .filter(name => name.endsWith(".json") && !name.endsWith(".expected.json"))) {
  test(`real validate/build/pack commands reject ${name} before building`, () => {
    const root = mkdtempSync(join(tmpdir(), "reai-gateway-cli-"));
    try {
      writeFileSync(join(root, "app.manifest.json"), readFileSync(join(contract, "gateway-manifest-fixtures/invalid", name)));
      for (const command of ["validate", "build", "pack"]) {
        const args = [join(import.meta.dir, "../src/cli.ts"), command, root];
        if (command === "pack") args.push("--out", join(root, "bad.reaiapp"));
        const result = spawnSync(process.execPath, args, { encoding: "utf8" });
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("MANIFEST_REFERENCE_INVALID");
        expect(result.stderr).toContain("apps.gateway@1");
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}
