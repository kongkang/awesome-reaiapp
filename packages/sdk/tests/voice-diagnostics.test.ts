import { expect, test } from "bun:test";
import { defineApp, runApp, RequestMethod, type AppContext, type HostBridge, type HostMessage } from "../src/v1/index";

// Host API 1.22（同版本并入）：取回卡与结果面板的可选诊断字段。给了才发，缺省时请求形状与旧版一致。
test("presentTakeback 透传 errorCode / detail，缺省不发", async () => {
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
  await ctx.delivery.presentTakeback({ title: "t", reason: "r", text: "x" });
  await ctx.delivery.presentTakeback({
    title: "t", reason: "r", text: "x", errorCode: "com.reai.voice/VOICE_START_TIMEOUT", detail: "HTTP 504",
  });
  await ctx.voiceCommand.presentAnswer({
    runId: "run-1", title: "t", text: "x", originalText: "o", status: "failed", errorCode: "AI_TIMEOUT", detail: "upstream 504",
  });
  expect(calls).toEqual([
    { method: RequestMethod.VoiceDeliverPresentTakeback, params: { title: "t", reason: "r", text: "x" } },
    {
      method: RequestMethod.VoiceDeliverPresentTakeback,
      params: { title: "t", reason: "r", text: "x", errorCode: "com.reai.voice/VOICE_START_TIMEOUT", detail: "HTTP 504" },
    },
    {
      method: RequestMethod.VoiceCommandPresentAnswer,
      params: { runId: "run-1", title: "t", text: "x", originalText: "o", status: "failed", errorCode: "AI_TIMEOUT", detail: "upstream 504" },
    },
  ]);
  await app.dispose();
});
