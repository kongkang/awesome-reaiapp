import { describe, expect, test } from "bun:test";
import { VoiceScreenshotConsent, type VoiceScreenshotConsentRecord } from "../src/voice-screenshot-consent";
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
function harness(saved?: unknown) {
  let epoch = "host-epoch-a";
  let revoked = 0;
  const writes: VoiceScreenshotConsentRecord[] = [];
  const consent = new VoiceScreenshotConsent({ readEpoch: async () => epoch, save: async (value) => { writes.push(value); }, revoked: () => { revoked++; } }, saved);
  return { consent, writes, change: (next: string) => { epoch = next; }, revoked: () => revoked };
}
describe("explicit screenshot consent", () => {
  test("a revoke queued after the epoch read remains the last visible state", async () => {
    const read = deferred<string>();
    const visible: boolean[] = [];
    const consent = new VoiceScreenshotConsent({ readEpoch: () => read.promise,
      save: async () => undefined, revoked: () => { visible.push(false); },
    }, { enabled: true, consentEpoch: "epoch", version: 1 });
    const refresh = consent.refresh(enabled => { visible.push(enabled); });
    read.resolve("epoch");
    queueMicrotask(() => { void consent.revoke(); });
    await refresh;
    expect(visible).toEqual([true, false]);
    expect(consent.isEnabled()).toBe(false);
  });
  test("a restored choice is revoked on refresh after logout or account replacement, without recording", async () => {
    const h = harness({ enabled: true, consentEpoch: "previous-login", version: 1 });
    expect(await h.consent.refresh()).toBe(false);
    expect(h.consent.isEnabled()).toBe(false);
    expect(h.writes).toEqual([{ enabled: false, version: 1 }]);
  });
  test("refresh preserves an explicitly confirmed choice in the same login", async () => {
    const h = harness();
    await h.consent.confirmEnable(async () => true);
    expect(await h.consent.refresh()).toBe(true);
    expect(h.writes).toHaveLength(1);
  });
  test("a late epoch refresh cannot revoke or repaint a newer explicit confirmation", async () => {
    const oldRead = deferred<string>();
    let nextRead: Promise<string> = oldRead.promise;
    const writes: VoiceScreenshotConsentRecord[] = [];
    const consent = new VoiceScreenshotConsent({ readEpoch: () => nextRead,
      save: async record => { writes.push(record); }, revoked: () => undefined,
    }, { enabled: true, consentEpoch: "login-a", version: 1 });
    const refresh = consent.refresh();
    nextRead = Promise.resolve("login-c");
    await consent.confirmEnable(async () => true);
    oldRead.resolve("login-b");
    expect(await refresh).toBeUndefined();
    expect(consent.isEnabled()).toBe(true);
    expect(writes).toEqual([{ enabled: true, consentEpoch: "login-c", version: 1 }]);
  });
  test("a late epoch refresh cannot repaint a revoked choice as enabled", async () => {
    const oldRead = deferred<string>();
    const consent = new VoiceScreenshotConsent({ readEpoch: () => oldRead.promise,
      save: async () => undefined, revoked: () => undefined,
    }, { enabled: true, consentEpoch: "login-a", version: 1 });
    const refresh = consent.refresh();
    await consent.revoke();
    oldRead.resolve("login-a");
    expect(await refresh).toBeUndefined();
    expect(consent.isEnabled()).toBe(false);
  });
  test("old window/enabled booleans never become consent for the current epoch", async () => {
    for (const saved of [undefined, { window: true }, { enabled: true }, { enabled: true, consentEpoch: "host-epoch-a" }]) {
      const h = harness(saved);
      expect(await h.consent.grantFor("session")).toBeUndefined();
      expect(h.writes).toHaveLength(0);
    }
  });
  test("declining confirmation never persists enabled", async () => {
    const h = harness();
    expect(await h.consent.confirmEnable(async () => false)).toBe(false);
    expect(h.writes).toHaveLength(0);
    expect(await h.consent.grantFor("session")).toBeUndefined();
  });
  test("same session refresh keeps consent; account replacement invalidates grants", async () => {
    const h = harness();
    expect(await h.consent.confirmEnable(async () => true)).toBe(true);
    const old = await h.consent.grantFor("session-a");
    expect(old?.isCurrent()).toBe(true);
    expect((await h.consent.grantFor("session-b"))?.consentEpoch).toBe("host-epoch-a");
    h.change("host-epoch-b");
    expect(await h.consent.grantFor("session-c")).toBeUndefined();
    expect(old?.isCurrent()).toBe(false);
    expect(h.revoked()).toBe(1);
  });
  test("changing account while the confirmation is open cannot authorize the new account", async () => {
    const h = harness();
    expect(await h.consent.confirmEnable(async () => { h.change("host-epoch-b"); return true; })).toBe(false);
    expect(h.writes).toHaveLength(0);
  });
  test("revoke wins while enable persistence is pending, and the final stored value is off", async () => {
    const saving = deferred<void>();
    const entered = deferred<void>();
    const writes: boolean[] = [];
    const consent = new VoiceScreenshotConsent({ readEpoch: async () => "epoch", revoked: () => undefined, save: async (value) => {
      writes.push(value.enabled);
      if (value.enabled) { entered.resolve(); await saving.promise; }
    } });
    const enable = consent.confirmEnable(async () => true);
    await entered.promise;
    const revoke = consent.revoke();
    expect(await consent.grantFor("session")).toBeUndefined();
    saving.resolve();
    expect(await enable).toBe(false);
    await revoke;
    expect(writes).toEqual([true, false]);
  });
  test("storage failure cannot restore revoked consent or leave the old grant usable", async () => {
    const consent = new VoiceScreenshotConsent({ readEpoch: async () => "epoch", revoked: () => undefined, save: async () => { throw new Error("fixture storage failure"); } }, { enabled: true, consentEpoch: "epoch", version: 1 });
    const old = await consent.grantFor("session");
    expect(old?.isCurrent()).toBe(true);
    await consent.revoke().catch(() => undefined);
    expect(old?.isCurrent()).toBe(false);
    expect(await consent.grantFor("session")).toBeUndefined();
  });

  test("readEpoch 抖动不撤销已开启的同意，只在本次采集 fail-closed", async () => {
    let epoch: string | Promise<string> = "host-epoch-a";
    let revoked = 0;
    const writes: VoiceScreenshotConsentRecord[] = [];
    const consent = new VoiceScreenshotConsent({
      readEpoch: () => (typeof epoch === "string" ? Promise.resolve(epoch) : epoch),
      save: async (value) => { writes.push(value); },
      revoked: () => { revoked++; },
    }, { enabled: true, consentEpoch: "host-epoch-a", version: 1 });
    // 鉴权临时抛错：不 revoke、不写盘，同意保留；本次不授权采集。
    const failing = Promise.reject(new Error("fixture transient auth error"));
    epoch = failing;
    await expect(consent.grantFor("session-x")).resolves.toBeUndefined();
    await failing.catch(() => undefined);
    epoch = "host-epoch-a";
    expect(revoked).toBe(0);
    expect(writes).toHaveLength(0);
    // 恢复后同一同意仍可用。
    const grant = await consent.grantFor("session-y");
    expect(grant?.consentEpoch).toBe("host-epoch-a");
    // 只有真实的 epoch 不一致才 revoke。
    epoch = "host-epoch-b";
    await expect(consent.grantFor("session-z")).resolves.toBeUndefined();
    expect(revoked).toBe(1);
    expect(writes.at(-1)).toEqual({ enabled: false, version: 1 });
  });
});

test("revoking consent immediately aborts all current image uses and cannot revive old grants", async () => {
  const h = harness();
  await h.consent.confirmEnable(async () => true);
  const first = await h.consent.grantFor("s1");
  const second = await h.consent.grantFor("s2");
  expect(first?.signal?.aborted).toBe(false);
  await h.consent.revoke();
  expect(first?.signal?.aborted).toBe(true);
  expect(second?.signal?.aborted).toBe(true);
  await h.consent.confirmEnable(async () => true);
  expect(first?.isCurrent()).toBe(false);
  expect((await h.consent.grantFor("s3"))?.signal?.aborted).toBe(false);
});
