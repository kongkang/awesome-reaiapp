import { expect, test } from "bun:test";
import { defineApp, runApp, type AppContext, type HostBridge, type HostMessage } from "../src/v1/index";

test("Agent service selects Pi, DSH, Codex or leaves runtime omitted for Host default", async () => {
  let ctx!: AppContext;
  let receive!: (message: HostMessage) => void;
  const calls: Array<{ method: string; params: unknown }> = [];
  const bridge: HostBridge = {
    request: async (method, params) => { calls.push({ method, params }); return {} as never; },
    notify: () => undefined,
    subscribe: listener => { receive = listener; return () => undefined; },
  };
  const app = runApp(defineApp({ activate(context) { ctx = context; } }), bridge);
  receive({ type: "activate", runtimeSessionId: "agent-config-test" });
  await new Promise(resolve => setTimeout(resolve, 0));
  calls.length = 0;
  try {
    for (const runtime of ["pi", "dsh", "codex", undefined] as const) {
      const config = {
        schemaVersion: 2 as const,
        ...(runtime ? { runtime } : {}),
        systemPrompt: "Answer briefly.", tools: [], skills: [],
        workspace: { kind: "app-private" as const }, memory: "session" as const,
      };
      // The service owns default resolution; SDK must not read or change app settings.
      await ctx.agent.createSession(config);
      expect(calls.at(-1)).toEqual({ method: "agent.v2.session.create", params: { config } });
    }
    expect(calls).toHaveLength(4);
  } finally {
    await app.dispose();
  }
});
