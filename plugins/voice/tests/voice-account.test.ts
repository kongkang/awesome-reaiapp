import { expect, test } from "bun:test";
import { isVoiceAccountCurrent, readVoiceAccountEpoch } from "../src/voice-account";

test("real account adapter reads metadata only and rejects old or absent generations", async () => {
  const options: unknown[] = [];
  let epoch: string | undefined = "a";
  const context = { async capture(value: unknown) { options.push(value); return { sessionEpoch: epoch, windowTextStatus: "not_requested" as const, screenRecording: "denied" as const }; } };
  expect(await isVoiceAccountCurrent(context, "a")).toBe(true);
  epoch = "b";
  expect(await isVoiceAccountCurrent(context, "a")).toBe(false);
  expect(await isVoiceAccountCurrent(context, undefined)).toBe(false);
  epoch = undefined;
  await expect(readVoiceAccountEpoch(context)).rejects.toMatchObject({ code: "VOICE_ACCOUNT_UNAVAILABLE" });
  expect(options).toEqual([{}, {}, {}]);
});

test("temporary account read errors are preserved rather than reported as logout", async () => {
  const temporary = { code: "VOICE_ACCOUNT_UNAVAILABLE" };
  await expect(isVoiceAccountCurrent({ capture: async () => { throw temporary; } }, "a")).rejects.toBe(temporary);
});

test("cancelled and replaced requests cannot be mistaken for ordinary polish failure", async () => {
  const { isVoiceRequestInvalidated } = await import("../src/voice-account");
  for (const code of ["VOICE_CANCELLED", "SERVICE_CANCELLED", "AI_SESSION_CHANGED", "OAUTH_SESSION_CHANGED", "CLOUD_SESSION_CHANGED"]) {
    expect(isVoiceRequestInvalidated({ code })).toBe(true);
  }
  expect(isVoiceRequestInvalidated({ code: "AI_TIMEOUT" })).toBe(false);
  expect(isVoiceRequestInvalidated({ code: "AI_RATE_LIMITED" })).toBe(false);
});
