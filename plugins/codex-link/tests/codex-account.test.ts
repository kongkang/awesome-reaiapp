import { describe, expect, test } from "bun:test";
import { CodexRepository } from "../src/codex-repository";

function store() {
  const values = new Map<string, unknown>();
  return { async get<T>(key: string) { return values.get(key) as T | undefined; }, async set(key: string, value: unknown) { values.set(key, value); }, async delete(key: string) { values.delete(key); }, async keys() { return [...values.keys()]; } };
}
const status = { connected: true, features: { thread_state_v1: true, account_v1: true }, threads: [] };

describe("local app-server account and discovery", () => {
  test("refresh reconciles every loaded page and removes external archives without dropping later visible rows", async () => {
    let revised = false;
    const cursors: unknown[] = [];
    const repo = new CodexRepository(async <T>(method: string, params?: unknown) => {
      if (method === "codex.status") return status as T;
      if (method === "codex.list_threads") {
        const cursor = (params as any).cursor;
        cursors.push(cursor);
        return (cursor ? { data: [{ id: revised ? "remaining" : "archived-later", name: revised ? "remaining" : "archived-later" }], nextCursor: "page-3" }
          : { data: [{ id: "first" }], nextCursor: "page-2" }) as T;
      }
      return { data: [] } as T;
    }, store());
    await repo.refresh();
    await repo.loadMore();
    revised = true;
    const fresh = await repo.refresh();
    expect(cursors).toEqual([undefined, "page-2", undefined, "page-2"]);
    expect(JSON.stringify(fresh.dashboard)).toContain("remaining");
    expect(JSON.stringify(fresh.dashboard)).not.toContain("archived-later");
    expect(fresh.hasMoreThreads).toBe(true);
  });

  test("a failed later-page refresh preserves the prior window and retries all loaded pages", async () => {
    let fail = false;
    const repo = new CodexRepository(async <T>(method: string, params?: unknown) => {
      if (method === "codex.status") return status as T;
      if (method === "codex.list_threads") {
        if ((params as any).cursor && fail) throw new Error("page unavailable");
        return ((params as any).cursor ? { data: [{ id: "later" }] }
          : { data: [{ id: "first" }], nextCursor: "page-2" }) as T;
      }
      return { data: [] } as T;
    }, store());
    await repo.refresh();
    const prior = await repo.loadMore();
    fail = true;
    await expect(repo.refresh()).rejects.toThrow("page unavailable");
    expect(await repo.loadMore()).toBe(prior);
    fail = false;
    expect(JSON.stringify((await repo.refresh()).dashboard)).toContain("later");
  });

  test("account synchronization requires a Host capability and propagates a busy failure", async () => {
    let supported = false;
    let syncCalls = 0;
    const repo = new CodexRepository(async <T>(method: string) => {
      if (method === "codex.status") return { ...status, features: { ...status.features, account_sync_v1: supported } } as T;
      if (method === "codex.account_sync") { syncCalls++; throw new Error("任务仍在运行"); }
      return { data: [] } as T;
    }, store());
    await repo.refresh();
    await repo.syncAccount();
    expect(syncCalls).toBe(0);
    supported = true;
    await repo.refresh();
    await expect(repo.syncAccount()).rejects.toThrow("任务仍在运行");
    expect(syncCalls).toBe(1);
  });

  test("Skill discovery reloads on first read, explicit refresh, directory change and bounded polling", async () => {
    let now = 1_000;
    const calls: Array<{ cwds: string[]; forceReload: boolean }> = [];
    const repo = new CodexRepository(async <T>(method: string, params?: unknown) => {
      if (method === "codex.status") return status as T;
      if (method === "codex.list_skills") calls.push(params as any);
      return { data: [] } as T;
    }, store(), { now: () => now });
    repo.setSkillsCwd("/work/a");
    await repo.refresh();
    await repo.refresh();
    await repo.refresh({ forceReloadSkills: true });
    repo.setSkillsCwd("/work/b");
    await repo.refresh();
    now += 60_000;
    await repo.refresh();
    expect(calls.map(c => c.forceReload)).toEqual([true, false, true, true, true]);
    expect(calls.at(-1)?.cwds).toEqual(["/work/b"]);
  });

  test("a failed Skill reload is retried instead of extending the cache lifetime", async () => {
    const reloads: boolean[] = [];
    const repo = new CodexRepository(async <T>(method: string, params?: unknown) => {
      if (method === "codex.status") return status as T;
      if (method === "codex.list_skills") {
        reloads.push((params as any).forceReload);
        if (reloads.length === 1) throw new Error("unavailable");
      }
      return { data: [] } as T;
    }, store());
    await repo.refresh();
    await repo.refresh();
    expect(reloads).toEqual([true, true]);
  });

  test("malformed history is an error, never an empty-state success", async () => {
    const repo = new CodexRepository(async <T>(method: string) => {
      if (method === "codex.status") return status as T;
      return {} as T;
    }, store());
    await expect(repo.refresh()).rejects.toThrow("列表响应无效");
  });
  test("account and skill failures do not erase readable local history or pretend sign-out", async () => {
    const repo = new CodexRepository(async <T>(method: string) => {
      if (method === "codex.status") return status as T;
      if (method === "codex.list_threads") return { data: [{ id: "local", cwd: "/work/a", name: "local task" }] } as T;
      throw new Error("temporarily unavailable");
    }, store());
    const result = await repo.refresh();
    expect(JSON.stringify(result.dashboard)).toContain("local task");
    expect(result.account?.state).toBe("error");
    expect(result.skillsError).toBeTruthy();
  });

  test("loads the next page once, deduplicates rows, and scopes skills to the selected project", async () => {
    const calls: Array<{ method: string; params: any }> = [];
    const repo = new CodexRepository(async <T>(method: string, params?: unknown) => {
      calls.push({ method, params });
      if (method === "codex.status") return status as T;
      if (method === "codex.account_read") return { account: { type: "chatgpt", planType: "pro" }, requiresOpenaiAuth: true, login: null } as T;
      if (method === "codex.list_threads") return ((params as any).cursor
        ? { data: [{ id: "one", cwd: "/work/a" }, { id: "two", cwd: "/work/b" }], nextCursor: null }
        : { data: [{ id: "one", cwd: "/work/a" }], nextCursor: "page-2" }) as T;
      return { data: [] } as T;
    }, store());
    repo.setSkillsCwd("/work/selected");
    const first = await repo.refresh();
    expect(first.hasMoreThreads).toBe(true);
    expect(first.account?.state).toBe("signed-in");
    const [more] = await Promise.all([repo.loadMore(), repo.loadMore()]);
    expect(more.hasMoreThreads).toBe(false);
    expect(JSON.stringify(more.dashboard).match(/"id":"one"/g)?.length).toBe(1);
    expect(calls.filter(c => c.params?.cursor === "page-2")).toHaveLength(1);
    expect(calls.find(c => c.method === "codex.list_threads")?.params).toMatchObject({ modelProviders: [], useStateDbOnly: true, sortKey: "updated_at" });
    expect(calls.find(c => c.method === "codex.list_skills")?.params).toEqual({ cwds: ["/work/selected", "/work/a"], forceReload: true });
  });

  test("a repeated cursor stops pagination with an actionable error", async () => {
    const repo = new CodexRepository(async <T>(method: string) => {
      if (method === "codex.status") return status as T;
      if (method === "codex.account_read") return { account: null, requiresOpenaiAuth: true } as T;
      if (method === "codex.list_threads") return { data: [{ id: "one", cwd: "/work/a" }], nextCursor: "loop" } as T;
      return { data: [] } as T;
    }, store());
    await repo.refresh();
    await expect(repo.loadMore()).rejects.toThrow("分页");
    expect((await repo.refresh()).hasMoreThreads).toBe(true);
  });

  test("subscription-required tasks cannot create an empty thread while signed out", async () => {
    const calls: string[] = [];
    const repo = new CodexRepository(async <T>(method: string) => {
      calls.push(method);
      if (method === "codex.status") return status as T;
      if (method === "codex.account_read") return { account: null, requiresOpenaiAuth: true } as T;
      return { data: [] } as T;
    }, store());
    await repo.refresh();
    await expect(repo.startTask("/work/a", "hello")).rejects.toThrow("登录");
    expect(calls).not.toContain("codex.start_thread");
  });
});
