import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { validateManifest, type StableErrorCode } from "../src/validate";

type Json = Record<string, unknown>;
type FixtureCase = {
  name: string;
  requirementPatch?: Json;
  omitRequirementsVersion?: boolean;
  expectedCodes: StableErrorCode[];
};

const fixturesRoot = join(import.meta.dir, "../../contract");
const suite = JSON.parse(
  readFileSync(join(fixturesRoot, "managed-requirements-v1.2.json"), "utf8"),
) as { validRequirement: Json; cases: FixtureCase[] };
const minimal = JSON.parse(
  readFileSync(join(fixturesRoot, "manifest-fixtures/valid/minimal-todo.json"), "utf8"),
) as Json;

function merge(base: Json, patch: Json): Json {
  const output = structuredClone(base);
  for (const [key, value] of Object.entries(patch)) {
    const current = output[key];
    output[key] = value && typeof value === "object" && !Array.isArray(value)
      && current && typeof current === "object" && !Array.isArray(current)
      ? merge(current as Json, value as Json)
      : structuredClone(value);
  }
  return output;
}

describe("managed requirements v1.2 shared fixtures", () => {
  for (const fixture of suite.cases) {
    test(fixture.name, () => {
      const manifest = structuredClone(minimal);
      manifest.requirementsVersion = "1.2";
      manifest.requirements = [merge(suite.validRequirement, fixture.requirementPatch ?? {})];
      if (fixture.omitRequirementsVersion) delete manifest.requirementsVersion;

      const codes = [...new Set(validateManifest(manifest).map((finding) => finding.code))].sort();
      expect(codes).toEqual([...fixture.expectedCodes].sort());
    });
  }
});
