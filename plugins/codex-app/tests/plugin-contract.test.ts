import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const pathFor = (path: string) => join(root, path);
const read = (path: string) => readFileSync(pathFor(path), "utf8");

const loadManifest = () => {
  const relative = "app.manifest.json";
  expect(existsSync(pathFor(relative))).toBe(true);
  return JSON.parse(read(relative));
};

describe("Codex App plugin contract", () => {
  test("manifest exposes only the owned work client surface", () => {
    const manifest = loadManifest();
    expect(manifest.appId).toBe("com.reai.codex-app");
    const capabilities = manifest.requires.hostCapabilities;
    expect(capabilities).toEqual(
      expect.arrayContaining([
        "surface.main@1",
        "titlebar.action@1",
        "apps.intent@1",
        "system.folder-pick@1",
        "agent.codex.tasks@1",
      ]),
    );
    expect(capabilities).not.toContain("agent.codex@1");
    expect(capabilities).not.toContain("local.files@1");
    expect(capabilities).toContain("storage.kv@1");
    expect(manifest.data.privateStores).toEqual([
      { id: "codex-preferences", schemaVersion: 1 },
    ]);
  });

  test("source groups threads by cwd and hands files to the editor", () => {
    const relative = "src/main.ts";
    expect(existsSync(pathFor(relative))).toBe(true);
    const source = read(relative);
    const threadState = read("src/thread-state.ts");
    expect(threadState).toContain('stringAt(raw, "cwd")');
    expect(source).toContain("loadThreadPages");
    expect(source).toContain("codex.tasks.");
    expect(source).toContain("com.reai.text-editor");
    expect(source).toContain("open-document");
    expect(source).toContain("userInputRequested");
    expect(source).toContain("respondUserInput");
    expect(source).toContain("loadThreadPages");
    expect(source).toContain("sendThreadMessage");
    expect(source).toContain("interruptActiveTurn");
    expect(source).toContain("requestResolved");
    expect(source).toContain('event.type === "resyncRequired"');
    expect(source).toContain("Promise.allSettled");
    expect(source).toContain('eventPayloadResult.status === "fulfilled"');
    expect(source).toContain("accountProbeGeneration += 1");
    expect(source).toContain("unsupportedRequests.filter");
    expect(source).toContain("targetGeneration === selectionGeneration");
    expect(source).toContain("pendingThread?.id !== taskId");
    expect(source).not.toContain("Monaco");
  });

  test("CODEXAPP-01：首 turn 后的首次权威详情读取走有界宽限，不闪 m110", () => {
    const source = read("src/main.ts");
    const threadState = read("src/thread-state.ts");
    // 宽限语义在 thread-state 内实现（行为测试见 thread-state.test.ts）。
    expect(threadState).toContain("FIRST_TURN_READ_GRACE_MS");
    expect(threadState).toContain("isFirstTurnReadWithinGrace");
    expect(threadState).toContain("openFirstTurnReadGrace");
    // 源码合同只锁「调用点」：先剥掉 import 与注释再断言，杜绝 import 语句、
    // 变量声明或纯注释让断言恒真（旧版 indexOf 命中 import，删掉宽限分支
    // 只留 import 时照样绿）。
    const body = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/[^\n]*/gm, "")
      .replace(/^import[\s\S]*?from\s+"[^"]+";\s*$/gm, "");
    const countCalls = (needle: string): number => body.split(needle).length - 1;
    // 1) 开窗：onSend 成功处经 openFirstTurnReadGrace（每个首 turn 周期只设定
    //    一次，后续发送不得重开/延长）。
    expect(countCalls("openFirstTurnReadGrace(")).toBe(1);
    // 2) 判断：catch 内的调用点（带括号）恰好一次，且必须先于真实失败分支；
    //    import 已剥掉，删掉宽限分支会让这里直接失败。
    const graceCall = body.indexOf("isFirstTurnReadWithinGrace(");
    expect(graceCall).toBeGreaterThanOrEqual(0);
    expect(body.indexOf("isFirstTurnReadWithinGrace(", graceCall + 1)).toBe(-1);
    expect(graceCall).toBeLessThan(body.indexOf("THREAD_LOAD_FAILED_NOTICE;\n"));
    // 3) 收窗：权威详情落地（selectedDetailRaw = detail）后紧跟 deadline 清零；
    //    单独的变量声明行满足不了这个上下文锚定。
    expect(body).toMatch(
      /selectedDetailRaw\s*=\s*detail;[\s\S]{0,160}?firstTurnReadDeadline\s*=\s*0;/,
    );
    // 4) 单调时钟：开窗与宽限判断都用 graceClockNow()，窗口不依赖可回拨墙钟。
    expect(countCalls("graceClockNow()")).toBeGreaterThanOrEqual(2);
    // 5) UI 门控：宽限占位期间投影 firstTurnGrace，视图据此禁用必然失败的
    //    停止/发送入口（视图行为测试见 codex-view.test.ts）。
    expect(body).toContain("firstTurnGrace,");
    expect(body).toContain("selectedDetailRaw === gracePlaceholderDetail");
    expect(read("src/codex-view.ts")).toContain("firstTurnGrace");
  });

  test("titlebar matches the design order, icons and normal color state", () => {
    const manifest = loadManifest();
    expect(manifest.contributes.titlebarActions).toEqual([
      {
        id: "add-project",
        label: "添加工作文件夹",
        icon: "folder",
        showOnTitlebarHover: false,
        intent: { type: "add-project" },
      },
      {
        id: "settings",
        label: "Codex App 设置",
        icon: "settings",
        showOnTitlebarHover: false,
        intent: { type: "open-settings" },
      },
    ]);
  });

  test("compose textarea 不泄漏被卡片裁断的浏览器 focus outline", () => {
    const styles = read("src/styles.css");
    expect(styles).toContain("textarea.cxa-input:focus-visible");
    expect(styles).toMatch(/textarea\.cxa-input:focus-visible\s*\{[^}]*outline:\s*0/s);
  });

  test("Codex 工作台常驻内容不用重复投影制造层级", () => {
    const styles = read("src/styles.css");
    for (const selector of [".cxa-artifact", ".cxa-compose-card", ".cxa-tab.active"]) {
      const escaped = selector.replaceAll(".", "\\.");
      const rule = styles.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, "s"))?.[1] ?? "";
      expect(rule).not.toContain("box-shadow");
    }
    const narrowInspector = styles.match(
      /@media \(max-width: 900px\)\s*\{[\s\S]*?\.cxa-inspector\s*\{([^}]*)\}/,
    )?.[1] ?? "";
    expect(narrowInspector).not.toContain("box-shadow");
  });

  test("顶部 1px 分割线只属于 Codex App workspace，不回流 Host titlebar", () => {
    const styles = read("src/styles.css");
    const workspaceRule = styles.match(/\.cxa-workspace\s*\{([^}]*)\}/s)?.[1] ?? "";
    const pageRule = styles.match(/\.cxa-page\s*\{([^}]*)\}/s)?.[1] ?? "";
    expect(workspaceRule).toMatch(
      /border-top:\s*1px solid var\(--divider,\s*rgba\(92,\s*92,\s*224,\s*\.08\)\)/,
    );
    expect(pageRule).not.toMatch(/border-top/);

  });
});
