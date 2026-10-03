import { describe, expect, test } from "bun:test";
import type { ServiceCaller } from "@reai/app-sdk/v1";
import { VoiceRequestAdmission, parseVoiceTextRequest, voiceRequestOwnerKey, type VoiceAdmissionState } from "../src/voice-request-admission";

const owner = { appId: "consumer", surfaceMountId: "mount", runtimeSessionId: "runtime", accountGeneration: "epoch" };
const request = (now: number) => ({ requestId: `${now}:${crypto.randomUUID()}` });

function storage(initial?: VoiceAdmissionState) {
  let saved = initial;
  return { read: async () => saved, write: async (value: VoiceAdmissionState) => { saved = structuredClone(value); }, saved: () => saved };
}

describe("Voice request-text admission", () => {
  test("无音频请求默认180秒，禁止audio或其他目标入参", () => {
    const input = request(Date.now());
    expect(parseVoiceTextRequest(input).timeoutMs).toBe(180_000);
    expect(() => parseVoiceTextRequest({ ...input, audio: "private" })).toThrow();
    expect(() => parseVoiceTextRequest({ ...input, insertText: true })).toThrow();
    expect(() => parseVoiceTextRequest({ ...input, timeoutMs: 300_001 })).toThrow();
    expect(() => parseVoiceTextRequest({ ...input, timeoutMs: 999 })).toThrow();
  });

  test("控制身份必含Host caller/mount/runtime/epoch；缺代际 fail-closed（1.0 合同必填）", () => {
    expect(() => voiceRequestOwnerKey(undefined)).toThrow();
    expect(() => voiceRequestOwnerKey({ surfaceMountId: "mount", runtimeSessionId: "runtime", accountGeneration: "epoch" } as ServiceCaller)).toThrow();
    expect(() => voiceRequestOwnerKey({ appId: "consumer", runtimeSessionId: "runtime", accountGeneration: "epoch" } as ServiceCaller)).toThrow();
    expect(() => voiceRequestOwnerKey({ appId: "consumer", surfaceMountId: "mount", accountGeneration: "epoch" } as ServiceCaller)).toThrow();
    // 台账必做项（2026-09-06 收回主裁定 A 的过渡放宽）：Host 信封已在代际可读时
    // 携带；不可读时省略字段，这里 fail-closed 拒绝，不伪造空代际受理。
    expect(() => voiceRequestOwnerKey({ appId: "consumer", surfaceMountId: "mount", runtimeSessionId: "runtime" })).toThrow();
    expect(() => voiceRequestOwnerKey({ appId: "consumer", surfaceMountId: "mount", runtimeSessionId: "runtime", accountGeneration: 42 as unknown as string })).toThrow();
    expect(voiceRequestOwnerKey(owner)).not.toBe(voiceRequestOwnerKey({ ...owner, runtimeSessionId: "new" }));
    expect(voiceRequestOwnerKey(owner)).not.toBe(voiceRequestOwnerKey({ ...owner, accountGeneration: "next-epoch" }));
  });

  test("持久登记后同ID重放拒绝，provider重建后也不恢复执行", async () => {
    const now = Date.now();
    const store = storage();
    const input = request(now);
    const first = await VoiceRequestAdmission.open(store, () => now);
    await first.claim(owner, input);
    await expect(first.claim(owner, input)).rejects.toMatchObject({ code: "VOICE_REQUEST_REPLAYED" });
    const resumed = await VoiceRequestAdmission.open(store, () => now);
    await expect(resumed.claim(owner, input)).rejects.toMatchObject({ code: "VOICE_REQUEST_REPLAYED" });
  });

  test("满容量不淘汰有效ID，过期后旧ID仍自拒而新请求可进", async () => {
    let now = Date.now();
    const store = storage();
    const gate = await VoiceRequestAdmission.open(store, () => now, 2);
    const old = request(now);
    await gate.claim(owner, old);
    await gate.claim(owner, request(now));
    await expect(gate.claim(owner, request(now))).rejects.toMatchObject({ code: "SERVICE_BUSY" });
    await expect(gate.claim(owner, old)).rejects.toMatchObject({ code: "VOICE_REQUEST_REPLAYED" });
    now += 60_001;
    await gate.claim(owner, request(now));
    await expect(gate.claim(owner, old)).rejects.toMatchObject({ code: "VOICE_REQUEST_EXPIRED" });
  });

  test("并发同ID最多登记一次，换owner不会拿到另一owner的登记", async () => {
    const now = Date.now();
    const gate = await VoiceRequestAdmission.open(storage(), () => now);
    const input = request(now);
    const outcomes = await Promise.allSettled([gate.claim(owner, input), gate.claim(owner, input)]);
    expect(outcomes.filter((value) => value.status === "fulfilled")).toHaveLength(1);
    await gate.claim({ ...owner, appId: "different-consumer" }, input);
  });

  test("保存失败不允许启动或本进程继续接纳，错误不含请求内容", async () => {
    const now = Date.now();
    const gate = await VoiceRequestAdmission.open({ read: async () => undefined, write: async () => { throw new Error("private storage path"); } }, () => now);
    await expect(gate.claim(owner, request(now))).rejects.toMatchObject({ code: "VOICE_REQUEST_STORAGE_UNAVAILABLE" });
    await expect(gate.claim(owner, request(now))).rejects.toMatchObject({ code: "VOICE_REQUEST_STORAGE_UNAVAILABLE" });
  });

  test("未来请求及持久时钟回拨拒绝，登记不包含文本或图", async () => {
    let now = Date.now();
    const store = storage();
    const gate = await VoiceRequestAdmission.open(store, () => now);
    await expect(gate.claim(owner, request(now + 5_001))).rejects.toMatchObject({ code: "VOICE_REQUEST_EXPIRED" });
    await gate.claim(owner, request(now));
    now -= 10;
    const resumed = await VoiceRequestAdmission.open(store, () => now);
    await expect(resumed.claim(owner, request(now))).rejects.toMatchObject({ code: "VOICE_REQUEST_CLOCK_CHANGED" });
    expect(Object.keys(store.saved()!).sort()).toEqual(["clockFloor", "entries", "version"]);
  });
});
