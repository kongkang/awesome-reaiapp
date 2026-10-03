import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { bindText, bindAttribute, bindTemplate, releaseLocaleBindings, setCodexLocale, t } from "../src/codex-i18n";

let ownsDom = false;
beforeAll(() => { if (typeof document === "undefined") { GlobalRegistrator.register(); ownsDom = true; } });
afterEach(() => setCodexLocale("zh"));
afterAll(() => { if (ownsDom) GlobalRegistrator.unregister(); });

for (const kind of ["element", "text"] as const) test(`rebinding ${kind} retains only the current translation callback`, () => {
  const node = kind === "text" ? document.createTextNode("") : document.createElement("button");
  let oldReads = 0, currentReads = 0;
  try {
    bindText(node, () => { oldReads++; return "old"; });
    bindText(node, () => { currentReads++; return "current"; });
    oldReads = currentReads = 0;
    setCodexLocale("en");
    expect([oldReads, currentReads]).toEqual([0, 1]);
    expect(node.textContent).toBe("current");
    bindText(node, "original user text");
    currentReads = 0;
    setCodexLocale("zh");
    expect(currentReads).toBe(0);
    expect(node.textContent).toBe("original user text");
  } finally { releaseLocaleBindings(node); }
});

test("static template binding never invents parameters for a dynamic accessible label", () => {
  const root = document.createElement("div");
  root.innerHTML = '<button aria-label="Skills" data-i18n-aria-label="skills.openCount">Skills</button>';
  const button = root.querySelector("button")!;
  try {
    bindTemplate(root);
    expect(button.getAttribute("aria-label")).toBe("Skills");
    bindAttribute(button, "aria-label", () => t("skills.openCount", { count: 7 }));
    expect(button.getAttribute("aria-label")).toBe(t("skills.openCount", { count: 7 }));
    setCodexLocale("en");
    expect(button.getAttribute("aria-label")).toBe("Open Skills, count: 7");
  } finally { releaseLocaleBindings(root); }
});
