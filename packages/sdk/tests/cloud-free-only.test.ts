import { expect, test } from "bun:test";
import { defineApp, runApp, type AppContext, type HostMessage } from "../src/v1/index";

test("free-only intent crosses live and saved transcription bridges unchanged", async () => {
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
  expect(ctx.aiApi.freeOnlyTranscriptionSupported).toBe(true);
  const live = { invocationId: "free-live", sessionId: "session", model: "transcribe-free", billingPolicy: "free-only" as const };
  await ctx.aiApi.transcribe(live);
  const saved = { recordingId: "recording", attemptId: "attempt", expectedRevision: 1,
    selection: { engine: "cloud" as const, modelId: "transcribe-free", language: "auto", punctEnabled: true, billingPolicy: "free-only" as const } };
  await ctx.voiceRecordings.transcribeSavedInput(saved);
  expect(calls[0]!.params).toEqual(live);
  expect(calls[1]!.params).toEqual(saved);
  await app.dispose();
});
