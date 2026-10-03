import { afterEach, afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { CodexMessageError, codexLocale, setCodexLocale, t } from "../src/codex-i18n";
import { formatCodexError, formatRelativeTime } from "../src/codex-model";
import app from "../src/app";
import { BRIDGE_GLOBAL_KEY, type AppContext } from "@reai/app-sdk/v1";
import { mountCodexView, type CodexViewOptions } from "../src/codex-view";

function localePort(initial: "zh" | "en") {
  let locale = initial;
  const listeners = new Set<(snapshot: { locale: "zh" | "en" }) => void>();
  return {
    getSnapshot: () => ({ locale }),
    onChange(listener: (snapshot: { locale: "zh" | "en" }) => void) {
      listeners.add(listener); listener({ locale });
      return () => listeners.delete(listener);
    },
    set(next: "zh" | "en") { locale = next; for (const listener of listeners) listener({ locale }); },
    get count() { return listeners.size; },
  };
}

describe("Codex Link UI locale", () => {
  let ownsDom = false;
  beforeAll(() => { if (typeof document === "undefined") { GlobalRegistrator.register(); ownsDom = true; } });
  afterEach(() => setCodexLocale("zh"));
  afterAll(() => { if (ownsDom) GlobalRegistrator.unregister(); });

  test("live locale preserves compose nodes, draft, selection, model and performs no bridge work", async () => {
    const root = document.createElement("div"); document.body.append(root);
    const locale = localePort("en");
    const calls: string[] = [];
    const view = mountCodexView(root, {
      locale, pollIntervalMs: 0,
      call: async <T>(method: string): Promise<T> => {
        calls.push(method);
        if (method === "codex.status") return { connected: true, threadCount: 0, features: { thread_state_v1: true, task_options_v1: true }, threads: [] } as T;
        if (method === "codex.list_models") return { data: [{ id: "model-原样", displayName: "Model 原样", supportedReasoningEfforts: [{ reasoningEffort: "high", description: "Raw 强度" }] }] } as T;
        if (method === "codex.list_skills") return { data: [{ cwd: "/work/中文", skills: [{ name: "Skill 原样", path: "/work/技能", description: "不要翻译" }] }] } as T;
        return { data: [] } as T;
      },
    } as CodexViewOptions);
    await view.refresh(); view.openCompose();
    await new Promise(resolve => setTimeout(resolve, 0));
    const prompt = root.querySelector<HTMLTextAreaElement>("textarea")!;
    const model = root.querySelector<HTMLSelectElement>('[data-field="model"]')!;
    const page = root.querySelector<HTMLElement>("main")!;
    const card = root.querySelector<HTMLElement>(".cx-compose-card")!;
    prompt.value = "用户 draft {name}"; prompt.focus(); prompt.setSelectionRange(2, 5); card.scrollTop = 72;
    model.value = "model-原样";
    const before = calls.length;
    expect(root.querySelector("#cx-compose-title")?.textContent).toBe("New Codex task");
    locale.set("zh");
    expect(root.querySelector("#cx-compose-title")?.textContent).toBe("新建 Codex 任务");
    locale.set("en"); locale.set("en");
    expect(root.querySelector("main")).toBe(page);
    expect(root.querySelector("textarea")).toBe(prompt);
    expect(document.activeElement).toBe(prompt);
    expect(prompt.value).toBe("用户 draft {name}");
    expect([prompt.selectionStart, prompt.selectionEnd]).toEqual([2, 5]);
    expect(card.scrollTop).toBe(72);
    expect(model.value).toBe("model-原样");
    expect(root.textContent).toContain("不要翻译");
    expect(calls.length).toBe(before);
    const title = root.querySelector("#cx-compose-title")!;
    view.dispose(); root.remove();
    expect(locale.count).toBe(0);
    locale.set("zh");
    expect(title.textContent).toBe("New Codex task");
  });

  test("approval labels and dates update in place without acknowledging, approving or moving focus", async () => {
    const root = document.createElement("div"); document.body.append(root);
    const locale = localePort("zh"); const calls: string[] = []; const opened: string[] = [];
    const now = 1_800_000_000_000;
    const view = mountCodexView(root, {
      locale, pollIntervalMs: 0, now: () => now, onConversationOpened: id => opened.push(id),
      call: async <T>(method: string): Promise<T> => {
        calls.push(method);
        if (method === "codex.status") return {
          connected: true, threadCount: 1, features: { thread_state_v1: true },
          threads: [{ threadId: "审批-id", state: "needsInput", lastEventMs: now - 60_000, managedByDriver: true,
            pendingRequests: [{ threadId: "审批-id", serverRequestId: 7, kind: "commandApproval", summary: '<raw>{name} 原始请求' }] }],
        } as T;
        if (method === "codex.list_threads") return { data: [{ id: "审批-id", name: "未命名对话", cwd: "/原样", preview: "原始输出 {count}", recencyAt: (now - 60_000) / 1000 }] } as T;
        return { data: [] } as T;
      },
    });
    await view.refresh(); view.openConversation("审批-id");
    const card = root.querySelector<HTMLElement>(".cx-d-card")!;
    const approve = root.querySelector<HTMLButtonElement>('[data-action="approve"]')!;
    const row = root.querySelector<HTMLElement>(".cx-task")!;
    approve.focus(); card.scrollTop = 94;
    const before = calls.length;
    locale.set("en");
    expect(root.querySelector('[data-action="approve"]')).toBe(approve);
    expect(root.querySelector(".cx-task")).toBe(row);
    expect(document.activeElement).toBe(approve);
    expect(card.scrollTop).toBe(94);
    expect(approve.textContent).toBe("Approve");
    expect(card.textContent).toContain("Waiting for your approval: <raw>{name} 原始请求");
    expect(card.textContent).toContain("1 minute ago");
    expect(card.querySelector(".cx-d-t")?.textContent).toBe("未命名对话");
    expect(card.textContent).toContain("原始输出 {count}");
    expect(root.querySelector('[data-action="open"]')?.textContent).toBe("Open after completion");
    expect(root.querySelector("raw")).toBeNull();
    expect(calls.length).toBe(before); expect(opened).toEqual(["审批-id"]);
    locale.set("zh");
    expect(card.textContent).toContain("等待你审批：<raw>{name} 原始请求");
    expect(approve.textContent).toBe("批准");
    view.dispose(); root.remove();
  });

  test("pending model errors retain raw details and retry node across language changes", async () => {
    const root = document.createElement("div"); document.body.append(root);
    const locale = localePort("zh"); let rejectModels!: (reason: unknown) => void;
    const pending = new Promise<never>((_, reject) => { rejectModels = reject; });
    const calls: string[] = [];
    const view = mountCodexView(root, {
      locale, pollIntervalMs: 0,
      call: async <T>(method: string): Promise<T> => {
        calls.push(method);
        if (method === "codex.status") return { connected: true, threadCount: 0, threads: [], features: { thread_state_v1: true, task_options_v1: true } } as T;
        if (method === "codex.list_models") return pending;
        return { data: [] } as T;
      },
    });
    await view.refresh(); view.openCompose(); await new Promise(resolve => setTimeout(resolve, 0));
    const status = root.querySelector<HTMLElement>('[data-slot="model-status"]')!;
    locale.set("en"); expect(status.textContent).toBe("Loading available models…");
    rejectModels({ code: "RAW_CODE", userMessage: "服务原文 <b>{detail}</b>" });
    await new Promise(resolve => setTimeout(resolve, 0));
    const retry = status.querySelector<HTMLButtonElement>("button")!; retry.focus();
    const before = calls.length;
    expect(status.textContent).toContain("Model list unavailable: RAW_CODE · 服务原文 <b>{detail}</b>");
    locale.set("zh");
    expect(status.textContent).toContain("模型列表不可用：RAW_CODE · 服务原文 <b>{detail}</b>");
    expect(retry.textContent).toBe("重试");
    expect(status.querySelector("button")).toBe(retry); expect(document.activeElement).toBe(retry);
    expect(status.querySelector("b")).toBeNull(); expect(calls.length).toBe(before);
    view.dispose(); root.remove();
  });

  test("uncertain task creation keeps its controlled error current and never retries on locale events", async () => {
    const root = document.createElement("div"); document.body.append(root);
    const locale = localePort("zh"); const calls: string[] = [];
    const view = mountCodexView(root, {
      locale, pollIntervalMs: 0,
      call: async <T>(method: string): Promise<T> => {
        calls.push(method);
        if (method === "codex.status") return { connected: true, threadCount: 0, threads: [], features: { thread_state_v1: true } } as T;
        if (method === "codex.list_skills") return { data: [{ cwd: "/raw", skills: [] }] } as T;
        if (method === "codex.start_thread") throw { code: "CODEX_LINK_TIMEOUT", userMessage: "原始超时" };
        return { data: [] } as T;
      },
    });
    await view.refresh(); view.openCompose();
    const prompt = root.querySelector<HTMLTextAreaElement>("textarea")!;
    prompt.value = "用户需求";
    root.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await new Promise(resolve => setTimeout(resolve, 0));
    const progress = root.querySelector<HTMLElement>('[data-slot="compose-progress"]')!;
    expect(progress.textContent).toContain("对话创建结果不确定");
    const before = calls.length;
    locale.set("en");
    expect(progress.textContent).toContain("Conversation creation could not be confirmed");
    expect(progress.textContent).toContain("CODEX_LINK_TIMEOUT · 原始超时");
    expect(prompt.value).toBe("用户需求");
    expect(root.querySelector<HTMLButtonElement>('[data-action="submit-task"]')!.disabled).toBeTrue();
    expect(calls.filter(method => method === "codex.start_thread")).toHaveLength(1);
    expect(calls.length).toBe(before);
    view.dispose(); root.remove();
  });

  test("runtime locale applies before any surface exists, late surfaces share it, cleanup stops both lifetimes", async () => {
    const locale = localePort("en"); const registrations = new Map<string, (surface: any) => Promise<(() => void) | undefined>>();
    const storage = { get: async () => undefined, set: async () => {}, delete: async () => {}, keys: async () => [] };
    const previous = (globalThis as any)[BRIDGE_GLOBAL_KEY];
    const calls: string[] = [];
    (globalThis as any)[BRIDGE_GLOBAL_KEY] = { request: async (method: string) => {
      calls.push(method);
      if (method === "codex.status") return { connected: true, threadCount: 0, features: { thread_state_v1: true }, threads: [] };
      return { data: [] };
    } };
    const context = {
      locale, storage: { private: () => storage }, events: { onCodex: () => () => {}, on: () => () => {} },
      commands: { register() {} }, surfaces: { register(id: string, factory: any) { registrations.set(id, factory); } },
      folderPick: { pick: async () => undefined }, actionItems: { list: async () => [], onChange: () => () => {} },
    } as unknown as AppContext;
    const roots: HTMLElement[] = []; const cleanups: Array<() => void> = [];
    try {
      await app.activate(context);
      expect(codexLocale()).toBe("en"); expect(locale.count).toBe(1);
      locale.set("zh"); expect(codexLocale()).toBe("zh");
      for (const next of ["zh", "en"] as const) {
        locale.set(next);
        const root = document.createElement("div"); roots.push(root); document.body.append(root);
        const cleanup = await registrations.get("main")!({ root, onIntent: () => () => {}, ready() {}, fail(error: unknown) { throw error; } });
        if (cleanup) cleanups.push(cleanup);
        expect(root.querySelector("h1")?.textContent).toBe(next === "zh" ? "谁在等我？" : "Who needs me?");
      }
      await new Promise(resolve => setTimeout(resolve, 0));
      const before = calls.length;
      roots[0].hidden = true; locale.set("zh");
      expect(roots[0].querySelector("h1")?.textContent).toBe("谁在等我？");
      expect(roots[1].querySelector("h1")?.textContent).toBe("谁在等我？");
      expect(calls.length).toBe(before);
      for (const cleanup of cleanups) cleanup();
      expect(locale.count).toBe(1);
      await app.deactivate?.(); expect(locale.count).toBe(0);
      locale.set("en"); expect(codexLocale()).toBe("zh");
    } finally {
      for (const cleanup of cleanups) cleanup();
      await app.deactivate?.();
      for (const root of roots) root.remove();
      (globalThis as any)[BRIDGE_GLOBAL_KEY] = previous;
    }
  });

  test("owned errors resolve at display time; fallback and interpolation never rewrite raw text", () => {
    setCodexLocale("zh"); const error = new CodexMessageError("errors.emptyTask");
    expect(formatCodexError(error)).toContain("不能创建");
    setCodexLocale("unknown"); expect(codexLocale()).toBe("en");
    expect(formatCodexError(error)).toContain("Add a prompt");
    expect(formatCodexError({ code: "RAW", userMessage: "用户原文 {name}" })).toBe("RAW · 用户原文 {name}");
    expect(t("approval.summary", { summary: "<b>{summary}</b>" })).toBe("Waiting for your approval: <b>{summary}</b>");
    expect(formatRelativeTime(0)).toBe("Time unknown");
  });

  test("late model completion after unmount cannot attach new bindings to the disposed view", async () => {
    const root = document.createElement("div"); document.body.append(root);
    const locale = localePort("zh"); let resolveModels!: (value: { data: unknown[] }) => void;
    const pending = new Promise<{ data: unknown[] }>(resolve => { resolveModels = resolve; });
    const view = mountCodexView(root, {
      locale, pollIntervalMs: 0,
      call: async <T>(method: string): Promise<T> => {
        if (method === "codex.status") return { connected: true, threadCount: 0, threads: [], features: { thread_state_v1: true, task_options_v1: true } } as T;
        if (method === "codex.list_models") return await pending as T;
        return { data: [] } as T;
      },
    });
    await view.refresh(); view.openCompose(); await new Promise(resolve => setTimeout(resolve, 0));
    const status = root.querySelector<HTMLElement>('[data-slot="model-status"]')!;
    const page = root.querySelector("main")!;
    expect(status.textContent).toBe("正在读取可用模型…");
    view.dispose();
    resolveModels({ data: [{ id: "model", displayName: "原始模型" }] });
    await new Promise(resolve => setTimeout(resolve, 0));
    setCodexLocale("en");
    expect(root.childElementCount).toBe(0);
    expect(status.textContent).toBe("正在读取可用模型…");
    expect(page.lang).toBe("zh");
    expect(locale.count).toBe(0);
    root.remove();
  });
});
