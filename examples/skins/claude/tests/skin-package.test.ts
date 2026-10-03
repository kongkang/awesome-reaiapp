import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const manifest = JSON.parse(readFileSync(join(root, "app.manifest.json"), "utf8"));
const skin = JSON.parse(readFileSync(join(root, "skin/skin.json"), "utf8"));
const expectedTokens = [
  "accent", "accent-glow", "accent-soft", "alert", "alert-line", "alert-soft",
  "bar-bg", "bar-border", "bar-shadow", "bg", "bound", "bound-line", "bound-soft",
  "cap-accent", "cap-bg", "cap-dim", "cap-shadow", "cap-text", "cap-wave",
  "card-bg", "card-border", "card-shadow", "desk-bg", "divider", "panel-bg",
  "panel-border", "panel-shadow", "panel-sub", "panel-text", "scroll-thumb",
  "scroll-thumb-hi", "text-primary", "text-secondary", "text-tertiary", "toggle-active",
  "toggle-bg", "warn", "warn-line", "warn-soft",
].sort();

describe("Claude skin example", () => {
  test("manifest and both theme token sets stay complete", () => {
    expect(manifest).toMatchObject({
      packageType: "skin",
      appId: "com.reai.skin.claude-demo",
      version: "0.1.0",
      skin: { apiVersion: "1", entry: "skin/skin.json" },
    });
    expect(Object.keys(skin.tokens.light).sort()).toEqual(expectedTokens);
    expect(Object.keys(skin.tokens.dark).sort()).toEqual(expectedTokens);
  });
});
