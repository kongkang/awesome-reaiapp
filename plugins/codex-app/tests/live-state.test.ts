import { describe, expect, test } from "bun:test";

import { normalizeSkills } from "../src/live-state";

describe("Codex App 真实能力快照", () => {
  test("只读取目标 cwd 中 app-server 明确启用的 Skills", () => {
    expect(
      normalizeSkills(
        {
          data: [
            {
              cwd: "/work/a",
              skills: [
                {
                  name: "z-skill",
                  description: "完整描述",
                  enabled: true,
                  path: "/skills/z/SKILL.md",
                  scope: "repo",
                  interface: {
                    displayName: "Z Skill",
                    shortDescription: "界面短描述",
                  },
                },
                {
                  name: "disabled-skill",
                  description: "不能显示",
                  enabled: false,
                  path: "/skills/disabled/SKILL.md",
                  scope: "user",
                },
              ],
            },
            {
              cwd: "/work/b",
              skills: [
                {
                  name: "other-work",
                  description: "另一个项目",
                  enabled: true,
                  path: "/skills/other/SKILL.md",
                  scope: "repo",
                },
              ],
            },
          ],
        },
        "/work/a",
      ),
    ).toEqual([
      {
        name: "z-skill",
        displayName: "Z Skill",
        description: "界面短描述",
        scope: "repo",
      },
    ]);
  });

  test("app-server 没有返回目标 cwd 时保持空，不借用其他项目数据", () => {
    expect(
      normalizeSkills(
        { data: [{ cwd: "/work/b", skills: [{ name: "wrong", enabled: true }] }] },
        "/work/a",
      ),
    ).toEqual([]);
  });
});

test("missing Skill description has a locale identity while supplied descriptions stay original", async () => {
  const { setLocale, resolveText } = await import("../src/i18n");
  const skills = normalizeSkills({ data: [{ cwd: "/work", skills: [
    { name: "a", enabled: true },
    { name: "b", enabled: true, description: "Codex 已报告这个 Skill 可用" },
  ] }] }, "/work");
  try {
    setLocale("en");
    expect(resolveText(skills[0]!.description)).toBe("Codex reported this Skill as available");
    expect(resolveText(skills[1]!.description)).toBe("Codex 已报告这个 Skill 可用");
  } finally { setLocale("zh"); }
});
