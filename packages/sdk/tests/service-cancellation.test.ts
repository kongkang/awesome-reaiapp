import { describe, expect, test } from "bun:test";
import { ServiceCancellationLedger, serviceRequestIdFactory } from "../src/v1/service-cancellation";
const uuid = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const caller = (runtimeSessionId = "a") => ({ appId: "consumer", surfaceMountId: "mount", runtimeSessionId });
const envelope = (time: number, runtime = "a", correlationId = `${runtime}-${time}`) => ({ correlationId, caller: caller(runtime), requestId: `service-v1:${time}:${uuid}`, deadlineUnixMs: time + 300_000 });
describe("service cancellation scoped admission", () => {
  test("outer IDs increase during same millisecond and clock rollback", () => {
    let now = 100_000;
    const next = serviceRequestIdFactory(() => now, () => uuid);
    expect(next()).toBe(`service-v1:100000:${uuid}`);
    expect(next()).toBe(`service-v1:100001:${uuid}`);
    now--;
    expect(next()).toBe(`service-v1:100002:${uuid}`);
  });
  test("early cancellation is never consumed and other callers remain independent", () => {
    const ledger = new ServiceCancellationLedger(() => 100_000);
    ledger.cancel(envelope(100_000));
    expect(ledger.admit(envelope(100_000))).toBe("SERVICE_CANCELLED");
    expect(ledger.admit(envelope(100_000))).toBe("SERVICE_CANCELLED");
    expect(ledger.admit(envelope(100_000, "b"))).toBeUndefined();
  });
  test("local overflow keeps old cancels and allows newer controls", () => {
    const ledger = new ServiceCancellationLedger(() => 100_000);
    for (let n = 0; n < 257; n++) ledger.cancel(envelope(100_000 + n));
    expect(ledger.admit(envelope(100_000))).toBe("SERVICE_CANCELLED");
    expect(ledger.admit(envelope(100_256))).toBe("SERVICE_CANCELLED");
    expect(ledger.admit(envelope(100_257))).toBeUndefined();
    expect(ledger.admit(envelope(100_000, "b"))).toBeUndefined();
  });
  test("full pool watermark survives collection and newer status creating its scope", () => {
    let now = 100_000;
    const ledger = new ServiceCancellationLedger(() => now);
    for (let n = 0; n < 128; n++) expect(ledger.admit({ ...envelope(now, `old-${n}`), deadlineUnixMs: 101_000 })).toBeUndefined();
    now = 159_900;
    ledger.cancel(envelope(now, "waiting"));
    expect(ledger.admit(envelope(now + 1, "old-0"))).toBeUndefined();
    expect(ledger.admit(envelope(now + 1, "waiting"))).toBe("SERVICE_BUSY");
    now = 160_002;
    expect(ledger.admit(envelope(now, "waiting"))).toBeUndefined();
    expect(ledger.admit(envelope(159_900, "waiting"))).toBe("SERVICE_CANCELLED");
    for (let n = 0; n < 126; n++) ledger.admit(envelope(now, `new-${n}`));
    ledger.cancel(envelope(now + 10, "unregistered"));
    expect(ledger.admit(envelope(now + 1, "waiting"))).toBeUndefined();
  });
  test("expiry and clock rollback cannot revive cancellation", () => {
    let now = 100_000;
    const ledger = new ServiceCancellationLedger(() => now);
    ledger.cancel({ ...envelope(now), deadlineUnixMs: now + 100 });
    now += 60_001;
    expect(ledger.admit({ ...envelope(100_000), deadlineUnixMs: 100_100 })).toBe("SERVICE_TIMEOUT");
    now = 100_000;
    expect(ledger.admit({ ...envelope(100_000), deadlineUnixMs: 100_100 })).toBe("SERVICE_TIMEOUT");
  });
  test("legacy overflow never blocks modern or other runtimes", () => {
    const ledger = new ServiceCancellationLedger(() => 100_000);
    for (let n = 0; n < 257; n++) ledger.cancel({ correlationId: `legacy-${n}`, requestId: `legacy-${n}`, caller: caller() });
    expect(ledger.admit({ correlationId: "new", caller: caller() })).toBe("SERVICE_BUSY");
    expect(ledger.admit(envelope(100_000))).toBeUndefined();
    expect(ledger.admit({ correlationId: "new", caller: caller("b") })).toBeUndefined();
  });
  test("unknown old cancellation transfers only exact late modern identity", () => {
    const ledger = new ServiceCancellationLedger(() => 100_000);
    ledger.cancel({ correlationId: "late" });
    expect(ledger.admit(envelope(100_000, "a", "late"))).toBe("SERVICE_CANCELLED");
    expect(ledger.admit(envelope(100_000, "a", "redelivery"))).toBe("SERVICE_CANCELLED");
    expect(ledger.admit(envelope(100_000, "b", "different"))).toBeUndefined();
  });
  test("Host admission before cold start keeps its original deadline after 60 seconds", () => {
    const ledger = new ServiceCancellationLedger(() => 165_000);
    const original = envelope(100_000);
    expect(ledger.admit(original)).toBeUndefined();
    const cancelled = envelope(100_001, "other-runtime");
    ledger.cancel(cancelled);
    expect(ledger.admit(cancelled)).toBe("SERVICE_CANCELLED");
    // The envelope's original total deadline cannot be extended by re-delivery.
    const expired = new ServiceCancellationLedger(() => original.deadlineUnixMs + 1);
    expect(expired.admit(original)).toBe("SERVICE_TIMEOUT");
  });
  test("unscoped legacy overflow does not disable complete modern Host envelopes", () => {
    const ledger = new ServiceCancellationLedger(() => 100_000);
    for (let n = 0; n < 257; n++) ledger.cancel({ correlationId: `old-${n}` });
    expect(ledger.admit({ correlationId: "new-legacy" })).toBe("SERVICE_BUSY");
    const full = envelope(100_000);
    // Modern Host routes always carry the complete identity, including Surface teardown.
    ledger.cancel(full);
    expect(ledger.admit(full)).toBe("SERVICE_CANCELLED");
    expect(ledger.admit(envelope(100_001))).toBeUndefined();
  });
  test("malformed and future IDs cannot raise watermarks", () => {
    const ledger = new ServiceCancellationLedger(() => 100_000);
    for (const requestId of ["service-v1:100000:bad", `service-v1:100000:${uuid}x`, "x".repeat(257)]) {
      const bad = { ...envelope(100_000), requestId };
      expect(ledger.admit(bad)).toBe("INVALID_ARGUMENT");
      ledger.cancel(bad);
    }
    expect(ledger.admit({ ...envelope(39_999), deadlineUnixMs: 99_999 })).toBe("SERVICE_TIMEOUT");
    ledger.cancel(envelope(105_001));
    expect(ledger.admit(envelope(105_001))).toBe("INVALID_ARGUMENT");
    expect(ledger.admit(envelope(100_000))).toBeUndefined();
  });
});
