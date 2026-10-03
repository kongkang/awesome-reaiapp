import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// Exercise the predicate used by the actual model row, without booting the Voice UI.
const source = readFileSync(new URL("../src/voice-view.ts", import.meta.url), "utf8");
const body = source.match(/function hasModelUpdate\(model: VoiceModelInfo\): boolean \{([\s\S]*?)\n\}/)?.[1];
if (!body) throw new Error("model-row update predicate not found");
const hasUpdate = new Function("model", body) as (model: object) => boolean;

test("Host digest update remains actionable when version labels are equal", () => {
  expect(hasUpdate({ updateAvailable: true, installedVersion: "v9", latestVersion: "v9" })).toBe(true);
});
test("Host receipt update remains actionable without an installed version label", () => {
  expect(hasUpdate({ updateAvailable: true, latestVersion: "v9" })).toBe(true);
});
test("legacy models without metadata are not implicitly marked outdated", () => {
  expect(hasUpdate({ updateAvailable: false })).toBe(false);
  expect(hasUpdate({ updateAvailable: false, installedVersion: "v8", latestVersion: "v9" })).toBe(false);
});
