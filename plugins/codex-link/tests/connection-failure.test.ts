import { afterAll, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { CodexRepository, type CodexCall, type CodexStore } from "../src/codex-repository";
import { mountCodexView } from "../src/codex-view";

let ownsDom = false;
beforeAll(() => { if (typeof document === "undefined") { GlobalRegistrator.register(); ownsDom = true; } });
afterAll(() => { if (ownsDom) GlobalRegistrator.unregister(); });
const VERSION_ERROR = "Codex 版本不兼容（userAgent=Codex Desktop/0.154.0，需 >=0.146.0 <0.154.0）";
function store(): CodexStore {
  const values = new Map<string, unknown>();
  return {
    async get<T>(key: string) { return values.get(key) as T | undefined; },
    async set(key: string, value: unknown) { values.set(key, value); },
    async delete(key: string) { values.delete(key); },
    async keys() { return [...values.keys()]; },
  };
}
function status(connected: boolean, error?: string) {
  return { connected, threadCount: 0, threads: [],
    features: { thread_state_v1: true },
    ...(error ? { lastError: error, lastErrorCode: "CODEX_LINK_VERSION_UNSUPPORTED" } : {}) };
}

test("known connection failure preserves the version reason without issuing history or account RPCs", async () => {
  const calls: string[] = [];
  const repository = new CodexRepository(async <T>(method: string): Promise<T> => {
    calls.push(method);
    if (method === "codex.status") return status(false, VERSION_ERROR) as T;
    throw new Error("generic connection timeout");
  }, store());
  await expect(repository.refresh()).rejects.toThrow(VERSION_ERROR);
  await expect(repository.startTask("/tmp/link-fixture", "test")).rejects.toThrow(VERSION_ERROR);
  expect(calls).toEqual(["codex.status"]);
});

test("failure occurring after the initial status read is recovered from the latest Host status", async () => {
  let reads = 0;
  const repository = new CodexRepository(async <T>(method: string): Promise<T> => {
    if (method === "codex.status") return status(false, ++reads === 1 ? undefined : VERSION_ERROR) as T;
    throw new Error("generic connection timeout");
  }, store());
  await expect(repository.refresh()).rejects.toThrow(VERSION_ERROR);
  expect(reads).toBe(2);
});

test("normal cold start without a previous error still waits for the initial history response", async () => {
  let reads = 0;
  const repository = new CodexRepository(async <T>(method: string): Promise<T> => {
    if (method === "codex.status") return status(++reads > 1) as T;
    if (method === "codex.list_threads" || method === "codex.list_skills") return { data: [] } as T;
    throw new Error(`unexpected ${method}`);
  }, store());
  expect((await repository.refresh()).status.connected).toBe(true);
  expect(reads).toBe(2);
});

function delayedHistory() {
  let connected = true;
  let finishPage!: (value: unknown) => void;
  const page = new Promise(resolve => { finishPage = resolve; });
  const call: CodexCall = async <T>(method: string, params?: unknown): Promise<T> => {
    if (method === "codex.status") return status(connected, connected ? undefined : VERSION_ERROR) as T;
    if (method === "codex.list_skills") return { data: [] } as T;
    if (method === "codex.list_threads") {
      if ((params as { cursor?: string }).cursor) return await page as T;
      return { data: [{ id: "first", name: "First page", updatedAt: 1 }], nextCursor: "page-2" } as T;
    }
    throw new Error(`unexpected ${method}`);
  };
  return { call, disconnect() { connected = false; }, finish() {
    finishPage({ data: [{ id: "stale", name: "Stale page", updatedAt: 2 }] });
  } };
}

test("failed refresh invalidates an in-flight history page and preserves the connection error", async () => {
  const fixture = delayedHistory();
  const repository = new CodexRepository(fixture.call, store());
  await repository.refresh();
  const pending = repository.loadMore();
  fixture.disconnect();
  await expect(repository.refresh()).rejects.toThrow(VERSION_ERROR);
  fixture.finish();
  await expect(pending).rejects.toThrow(VERSION_ERROR);
});

test("a stale history page cannot repaint a failed connection as connected", async () => {
  const fixture = delayedHistory();
  const root = document.createElement("div");
  const view = mountCodexView(root, { call: fixture.call, store: store(), pollIntervalMs: 0 });
  try {
    await view.refresh();
    root.querySelector<HTMLButtonElement>('[data-action="load-more"]')!.click();
    fixture.disconnect();
    await view.refresh();
    fixture.finish();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(root.querySelector<HTMLElement>('[data-slot="error"]')!.hidden).toBe(false);
    expect(root.querySelector('[data-slot="error"]')!.textContent).toContain(VERSION_ERROR);
    expect(root.querySelector('[data-slot="connection"]')!.textContent).toContain("连接失败");
    expect(root.textContent).not.toContain("Stale page");
  } finally { view.dispose(); }
});

test("new task after a failed first refresh explains the error immediately and does not replay on recovery", async () => {
  let connected = false;
  const call: CodexCall = async <T>(method: string): Promise<T> => {
    if (method === "codex.status") return status(connected, connected ? undefined : VERSION_ERROR) as T;
    if (!connected) throw new Error("generic connection timeout");
    if (method === "codex.list_threads" || method === "codex.list_skills") return { data: [] } as T;
    throw new Error(`unexpected ${method}`);
  };
  const root = document.createElement("div");
  const view = mountCodexView(root, { call, store: store(), pollIntervalMs: 0 });
  try {
    await view.refresh();
    const error = root.querySelector<HTMLElement>('[data-slot="error"]')!;
    expect(error.hidden).toBe(false);
    expect(error.textContent).toContain(VERSION_ERROR);
    expect(root.querySelector('[data-slot="connection"]')?.textContent).not.toContain("连接中");
    view.applyComposePreset({ promptPrefix: "do not replay" });
    const toast = root.querySelector<HTMLElement>('[data-slot="toast"]')!;
    expect(toast.hidden).toBe(false);
    expect(toast.textContent).toContain(VERSION_ERROR);
    connected = true;
    await view.refresh();
    expect(error.hidden).toBe(true);
    expect(root.querySelector<HTMLElement>(".cx-compose")!.hidden).toBe(true);
    view.applyComposePreset({});
    expect(root.querySelector<HTMLElement>(".cx-compose")!.hidden).toBe(false);
  } finally { view.dispose(); }
});
