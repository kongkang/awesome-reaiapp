import { expect, test } from "bun:test";
import { defineApp, runApp, RequestMethod, type AppContext, type HostBridge, type HostMessage } from "../src/v1/index";

test("explicit Voice start/finish/cancel use exact handles and preserve legacy toggle", async () => {
  let ctx!: AppContext;
  let receive!: (message: HostMessage) => void;
  const calls: Array<{ method: string; params: unknown }> = [];
  const bridge: HostBridge = {
    request: async (method, params) => { calls.push({ method, params }); return {} as never; },
    notify: () => undefined,
    subscribe: (listener) => { receive = listener; return () => undefined; },
  };
  const app = runApp(defineApp({ activate(context) { ctx = context; } }), bridge);
  receive({ type: "activate", runtimeSessionId: "fixture-provider" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  calls.length = 0;
  await ctx.voiceInput.beginPreparing("fixture-preparing", "task");
  await ctx.voiceInput.endPreparing("fixture-preparing");
  await ctx.voiceInput.start({ requestId: "fixture-start", insertText: false, captureDeliveryTarget: false, retainResultUntilAck: true, captureLimitAction: "finish" });
  await ctx.voiceInput.finish("fixture-session");
  await ctx.voiceInput.cancelPendingStart("fixture-start");
  await ctx.voiceInput.cancel("fixture-session");
  await ctx.voiceInput.toggle();
  await ctx.voiceInput.toggle({ mode: "command", overlayKind: "translate" });
  await ctx.voiceInput.start({ requestId: "typed-start", mode: "command", overlayKind: "task" });
  expect(calls).toEqual([
    { method: RequestMethod.VoicePreparing, params: { action: "begin", requestId: "fixture-preparing", overlayKind: "task" } },
    { method: RequestMethod.VoicePreparing, params: { action: "end", requestId: "fixture-preparing" } },
    { method: RequestMethod.VoiceToggle, params: { action: "start", requestId: "fixture-start", mode: "input", insertText: false, captureDeliveryTarget: false, retainResultUntilAck: true, captureLimitAction: "finish" } },
    { method: RequestMethod.VoiceToggle, params: { action: "finish", sessionId: "fixture-session" } },
    { method: RequestMethod.VoiceCancel, params: { requestId: "fixture-start" } },
    { method: RequestMethod.VoiceCancel, params: { sessionId: "fixture-session" } },
    { method: RequestMethod.VoiceToggle, params: { mode: "input" } },
    { method: RequestMethod.VoiceToggle, params: { mode: "command", overlayKind: "translate" } },
    { method: RequestMethod.VoiceToggle, params: { action: "start", requestId: "typed-start", mode: "command", overlayKind: "task" } },
  ]);
  await app.dispose();
});

test("Voice processing feedback transports real label and preserves old stage payload", async () => {
  let ctx!: AppContext;
  let receive!: (message: HostMessage) => void;
  const calls: Array<{ method: string; params: unknown }> = [];
  const app = runApp(defineApp({ activate(context) { ctx = context; } }), {
    request: async (method, params) => { calls.push({ method, params }); return {} as never; },
    notify: () => undefined,
    subscribe: (listener) => { receive = listener; return () => undefined; },
  });
  receive({ type: "activate", runtimeSessionId: "fixture-provider" });
  await new Promise(resolve => setTimeout(resolve, 0));
  calls.length = 0;
  await ctx.voiceInput.reportStage("exact-session", "processing", "read_file 正在执行");
  await ctx.voiceInput.reportStage("exact-session", "polishing");
  expect(calls).toEqual([
    { method: RequestMethod.VoiceReportStage, params: { sessionId: "exact-session", stage: "processing", label: "read_file 正在执行" } },
    { method: RequestMethod.VoiceReportStage, params: { sessionId: "exact-session", stage: "polishing" } },
  ]);
  app.dispose();
});
