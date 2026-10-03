import { AppError, defineApp, type ServiceCaller } from "@reai/app-sdk/v1";
import { DEFAULT_LIMITS, project, RuleError, writeSchemas } from "./domain";
import { createAuthority } from "./authority";
import { readPreferences } from "./preferences";
import { mountCodeWorker } from "./view";
import { SKILL_CONTENT } from "./skill.generated";
import "./code-worker.css";

const SERVICE = "com.reai.code-worker/agent@1";
function actor(caller?: ServiceCaller): string {
  const principal = caller?.external?.principal;
  if (caller?.appId !== "com.reai.code-worker" || !caller.external?.id || !principal || Object.keys(principal).length !== 1 || typeof principal.agentId !== "string")
    throw new RuleError("FORBIDDEN", "A Host-issued Agent connection is required");
  return principal.agentId;
}
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function exact(value: Record<string, unknown>, keys: string[]) { if (Object.keys(value).length !== keys.length || keys.some(k => !Object.hasOwn(value, k))) throw new RuleError("SCHEMA", "Unexpected request fields"); }
function wire(error: unknown) {
  return new AppError({ code: error instanceof RuleError ? `com.reai.code-worker/${error.code}` : "com.reai.code-worker/UNAVAILABLE", userMessage: error instanceof Error ? error.message : "Task service unavailable", retryable: !(error instanceof RuleError) || ["CONFLICT", "QUOTA"].includes(error.code), cause: error });
}
export default defineApp({
  async activate(ctx) {
    const preferences = ctx.storage.private("preferences");
    // Do not silently recreate preferences or task state when persistent reads fail.
    const defaults = readPreferences(await preferences.get("defaults"));
    const authority = createAuthority(ctx.storage.private("tasks"), () => ctx.services.call("com.reai.feedback-board/planned@1", "snapshot", {}), defaults.limits);
    // List before reading state: concurrent newly issued grants cannot be swept by an old snapshot.
    const sweepConnections = async () => {
      const handles = await ctx.gateway.list();
      const state = await authority.read();
      for (const handle of handles.filter(h => h.serviceId === SERVICE)) {
        const agent = state.agents.find(a => a.id === handle.principal.agentId);
        const replayable = agent && state.receipts.some(r => r.actorId === agent.id && r.at !== undefined && Date.now() - r.at <= 86400000);
        if (!agent || agent.role !== "orchestrator" && agent.state === "idle" && !replayable) await ctx.gateway.revoke(handle.id);
      }
      return state;
    };
    let active: ReturnType<typeof mountCodeWorker> | undefined;
    const connect = async (id: string) => {
      await sweepConnections();
      return ctx.gateway.issue({ serviceId: SERVICE, methods: ["invoke"], principal: { agentId: id } });
    };
    ctx.services.provide(SERVICE, "invoke", async ({ input, caller, signal }) => {
      try {
        const id = actor(caller);
        if (!record(input) || typeof input.kind !== "string") throw new RuleError("SCHEMA", "Request kind is required");
        if (signal.aborted) throw new Error("Call cancelled");
        const state = await sweepConnections(); const snapshot = project(state, id);
        const agent = state.agents.find(a => a.id === id)!;
        if (agent.role !== "orchestrator" && agent.state === "idle") {
          const action = input.action;
          if (input.kind !== "act" || !record(action) || !state.receipts.some(r => r.actorId === id && r.requestId === action.requestId && r.at !== undefined && Date.now() - r.at <= 86400000))
            throw new RuleError("FORBIDDEN", "Execution ended; only the original receipt may be replayed in the retry window");
        }
        switch (input.kind) {
          case "read": exact(input, ["kind"]); return { ...snapshot, writeSchemas: writeSchemas(snapshot.writable), idempotency: { maxReceipts: 128, windowSeconds: 86400 }, evidenceSource: "agent-report" };
          case "skill": exact(input, ["kind"]); return { content: SKILL_CONTENT, identity: snapshot.identity };
          case "detail": exact(input, ["kind", "childId"]); return { child: await authority.detail(String(input.childId), id), evidenceSource: "agent-report" };
          case "connection": {
            exact(input, ["kind", "agentId"]);
            const childAgent = state.agents.find(a => a.id === input.agentId);
            if (snapshot.identity.role !== "orchestrator" || !childAgent || childAgent.role === "orchestrator" || !snapshot.tasks.some(t => t.id === childAgent.taskId) || childAgent.state === "idle") throw new RuleError("FORBIDDEN", "No active child Agent in this scope");
            return { connection: await connect(childAgent.id) };
          }
          case "act": {
            exact(input, ["kind", "action"]);
            if (signal.aborted) throw new Error("Call cancelled");
            const result = await authority.act(id, input.action, signal);
            const agentId = result.receipt?.agentId;
            const connection = agentId && result.board.agents.some(a => a.id === agentId && a.state !== "idle") ? await connect(agentId) : undefined;
            return { projection: project(result.board, id), appliedRevision: result.receipt?.revision, ...(connection ? { connection } : {}) };
          }
          default: throw new RuleError("SCHEMA", "Unknown request kind");
        }
      } catch (error) { throw wire(error); }
    });
    ctx.commands.register("com.reai.code-worker.back-to-root", async () => { active?.navigateRoot(); return {}; });
    ctx.surfaces.register("main", surface => {
      let stopped = false, loading = false, timer: ReturnType<typeof setTimeout> | undefined;
      let revision = -1;
      const reload = async () => {
        if (stopped || loading) return;
        loading = true;
        try {
          const board = await authority.read();
          if (!stopped && board.revision !== revision) { revision = board.revision; view.setConnection({ state: "ready", board }, board.limits); }
        } catch { if (!stopped) { revision = -1; view.setConnection({ state: "error" }); } }
        finally { loading = false; }
      };
      const view = mountCodeWorker(surface.root, {
        locale: ctx.locale.getSnapshot().locale, limits: defaults.limits ?? DEFAULT_LIMITS, connection: { state: "loading" },
        async saveDefaults(limits) { await authority.limits(limits); await reload(); },
        async createAgent() { const id = `O-${crypto.randomUUID()}`; await authority.register(id); const connection = await connect(id); await reload(); return connection; },
        async connectAgent(id) { const state = await authority.read(); if (!state.agents.some(a => a.id === id && a.role === "orchestrator")) throw Error("Orchestrator not found"); return connect(id); },
        loadChild: childId => authority.detail(childId),
        exportTask: taskId => authority.exportTask(taskId),
        async archiveTask(taskId, revision, digest) { const result = await authority.archiveTask(taskId, revision, digest); await sweepConnections(); await reload(); return result.cleanupPending; },
        retry: reload, onNavigate: nav => surface.reportNav?.(nav),
      });
      active = view;
      const stopLocale = ctx.locale.onChange(({ locale }) => view.setLocale(locale));
      surface.ready();
      const poll = async () => { await reload(); if (!stopped) timer = setTimeout(() => { void poll(); }, 2000); };
      void poll();
      return () => { stopped = true; if (timer) clearTimeout(timer); stopLocale(); if (active === view) active = undefined; view.destroy(); };
    });
  },
});
