import { describe, expect, test } from "bun:test";
import type { VoiceInputClient, VoicePermissionInfo, VoicePermissionState } from "@reai/app-sdk/v1";
import { DEFAULT_SETTINGS } from "../src/data";
import { prepareVoiceRequest } from "../src/voice-request-permission";
import { VoiceRequestAdmission } from "../src/voice-request-admission";
import { VoiceRequestTextProvider } from "../src/voice-request-text";

const messages = { cancelled: "cancelled", upgrade: "update Driver", microphone: "allow microphone" };
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
function harness(info: VoicePermissionInfo) {
  const calls: string[] = [];
  let answer!: (value: VoicePermissionState) => void;
  const permission = new Promise<VoicePermissionState>((resolve) => { answer = resolve; });
  const voice: Pick<VoiceInputClient, "configure" | "checkPermissions" | "requestPermission"> = {
    async configure() { calls.push("configure"); },
    async checkPermissions() { calls.push("check"); return info; },
    async requestPermission(kind) { calls.push(kind); return permission; },
  };
  const controller = new AbortController();
  const prepare = (signal = controller.signal, report = () => { calls.push("waiting"); }) =>
    prepareVoiceRequest(voice, DEFAULT_SETTINGS, signal, report, messages);
  return { calls, voice, answer, controller, prepare };
}

describe("request-text uses Host route permission requirements", () => {
  for (const microphone of ["denied", "not_determined", "granted"] as VoicePermissionState[]) {
    test(`native Board route skips microphone authorization (${microphone})`, async () => {
      const h = harness({ microphone, accessibility: "granted", microphoneRequired: false });
      await h.prepare();
      expect(h.calls).toEqual(["configure", "check"]);
    });
  }
  test("old Host missing the requirement fails closed even with a microphone grant", async () => {
    const h = harness({ microphone: "granted", accessibility: "granted" });
    await expect(h.prepare()).rejects.toMatchObject({ code: "com.reai.voice/VOICE_HOST_UPGRADE_REQUIRED", userMessage: messages.upgrade });
    expect(h.calls).toEqual(["configure", "check"]);
  });
  test("required microphone already granted does not prompt again", async () => {
    const h = harness({ microphone: "granted", accessibility: "granted", microphoneRequired: true });
    await h.prepare();
    expect(h.calls).toEqual(["configure", "check"]);
  });
  for (const answer of ["granted", "denied"] as VoicePermissionState[]) {
    test(`Host-required microphone waits for real permission: ${answer}`, async () => {
      const h = harness({ microphone: "denied", accessibility: "granted", microphoneRequired: true });
      const op = h.prepare();
      await tick();
      expect(h.calls).toEqual(["configure", "check", "waiting", "microphone"]);
      h.answer(answer);
      if (answer === "granted") await op;
      else await expect(op).rejects.toMatchObject({ code: "com.reai.voice/VOICE_MIC_PERMISSION_REQUIRED" });
    });
  }
  test("cancellation during permission read never prompts", async () => {
    const h = harness({ microphone: "denied", accessibility: "granted", microphoneRequired: true });
    const read = h.voice.checkPermissions;
    h.voice.checkPermissions = async () => { const result = await read(); h.controller.abort(); return result; };
    await expect(h.prepare()).rejects.toMatchObject({ code: "SERVICE_CANCELLED" });
    expect(h.calls).toEqual(["configure", "check"]);
  });
  test("provider cancellation during real preparation isolates a late grant and permits a new request", async () => {
    const h = harness({ microphone: "denied", accessibility: "granted", microphoneRequired: true });
    const admission = await VoiceRequestAdmission.open({ read: async () => undefined, write: async () => undefined });
    let busy = false;
    const provider = new VoiceRequestTextProvider(admission, {
      reserve() { if (busy) return; busy = true; return () => { busy = false; }; },
      prepare: h.prepare,
      async isAccountCurrent() { return true; },
      async start() { h.calls.push("start"); return { phase: "listening", sessionId: "new" }; },
      async finish() { return { phase: "idle" }; },
      async cancelPendingStart() {}, async cancel() {}, async acknowledge() {},
      async readStatus() { return { phase: "listening" }; },
      async process() { return { text: "text", kind: "processed" }; },
    }, { pollMs: 100_000 });
    const caller = { appId: "consumer", surfaceMountId: "surface", runtimeSessionId: "runtime", accountGeneration: "epoch" };
    const input = { requestId: `${Date.now()}:${crypto.randomUUID()}` };
    try {
      const op = provider.request({ caller, input, signal: h.controller.signal }).catch((error) => error);
      await tick();
      expect(provider.status(caller, input).phase).toBe("waiting_permission");
      h.controller.abort();
      expect(await op).toMatchObject({ code: "SERVICE_CANCELLED" });
      h.answer("granted");
      await tick();
      expect(h.calls).not.toContain("start");
      expect(provider.status(caller, input).phase).toBe("cancelled");
      expect(busy).toBe(false);
      const nextInput = { requestId: `${Date.now()}:${crypto.randomUUID()}` };
      const next = provider.request({ caller, input: nextInput, signal: new AbortController().signal }).catch((error) => error);
      await tick();
      expect(provider.status(caller, nextInput).phase).toBe("listening");
      expect(h.calls.filter((call) => call === "start")).toHaveLength(1);
      provider.cancel(caller, nextInput);
      await next;
    } finally { provider.dispose(); }
  });
});
