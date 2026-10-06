import { afterAll, beforeAll, expect, test } from "bun:test";
import { brokerFetch, RequestMethod, type HostBridge } from "@reai/app-sdk/v1";
import matrix from "@reai/app-contract/host-support-matrix.json";
import { MockHost, type MockHostOptions, type AppManifestLike } from "../src/v1/index";

const MiB = 1024 * 1024;
const url = "https://synthetic.invalid/fixture/upload";
const limits = matrix.limits;
const hash = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
const encode = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const body = (size = 512 * 1024 + 1) => new Uint8Array(size).map((_, i) => (i * 37) % 251);
const response = { status: 201, statusText: "Created", headers: { "content-type": "application/json" }, bodyBase64: btoa('{"fixture":true}') };
type NetworkInput = { request: Readonly<Record<string, unknown>>; body: Blob; signal: AbortSignal };
type UploadOptions = { networkHandler?: (input: NetworkInput) => typeof response | Promise<typeof response>; networkUploadNow?: () => number };
const manifest = (): AppManifestLike => ({
  appId: "com.synthetic.http-upload-contract",
  permissions: [{ id: "http.fetch@1" }],
  network: { endpoints: [{ id: "fixture", origins: ["https://synthetic.invalid"], pathPrefixes: ["/fixture"], methods: ["POST"] }] },
});
const makeHost = (options: UploadOptions = {}, declaration = manifest()) => new MockHost({
  manifest: declaration, loadApp: async () => ({ default: {} }), networkResponse: response, ...options,
} as MockHostOptions);
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function traced(host: MockHost, hooks: {
  before?: (method: string, params: Record<string, unknown>) => void | Promise<void>;
  after?: (method: string, params: Record<string, unknown>, result: unknown) => void | Promise<void>;
} = {}) {
  const calls: Array<{ method: string; params: Record<string, unknown>; messageBytes: number }> = [];
  const chunks = new Bun.CryptoHasher("sha256");
  const bridge: HostBridge = {
    async request<T>(method: string, params: unknown, options?: { signal?: AbortSignal }): Promise<T> {
      const data = params as Record<string, unknown>;
      await hooks.before?.(method, data);
      const snapshot = { ...data };
      if (typeof snapshot["bodyBase64"] === "string") delete snapshot["bodyBase64"];
      calls.push({ method, params: snapshot, messageBytes: new TextEncoder().encode(JSON.stringify(data)).byteLength });
      if (method === RequestMethod.HttpUploadChunk && typeof data["bodyBase64"] === "string") chunks.update(Buffer.from(data["bodyBase64"], "base64"));
      const result = await host.bridge.request<T>(method as RequestMethod, data, options);
      await hooks.after?.(method, data, result);
      return result;
    }, notify: host.bridge.notify, subscribe: host.bridge.subscribe,
  };
  return { bridge, calls, chunkHash: () => chunks.digest("hex") };
}
const send = (bridge: HostBridge, bytes: BodyInit = body(), signal?: AbortSignal) => brokerFetch(bridge, url, {
  method: "POST", endpointId: "fixture", body: bytes, ...(signal ? { signal } : {}),
});
const directStart = (host: MockHost, requestId: string = crypto.randomUUID(), bodyBytes = 1) => host.bridge.request<{ uploadId: string }>(RequestMethod.HttpUploadStart, {
  requestId, url, method: "POST", endpointId: "fixture", headers: {}, bodyBytes,
});
async function succeed(host: MockHost) {
  const result = await send(host.bridge);
  expect(result.status).toBe(201);
  expect(await result.json()).toEqual({ fixture: true });
}

// A response callback is a deterministic fixture. No request uses a real network service.
let networkCalls = 0;
const originalFetch = globalThis.fetch;
beforeAll(() => {
  globalThis.fetch = Object.assign(async () => { networkCalls++; throw new Error("Unexpected network request in upload contract test"); }, { preconnect: originalFetch.preconnect });
});
afterAll(() => {
  globalThis.fetch = originalFetch;
  expect(networkCalls).toBe(0);
});

for (const size of [64, 512 * 1024, 512 * 1024 + 1]) {
  test(`production SDK + MockHost route and complete SHA at ${size} bytes`, async () => {
    const bytes = body(size);
    const observed: string[] = [];
    const host = makeHost({ networkHandler: async input => { observed.push(hash(new Uint8Array(await input.body.arrayBuffer()))); return response; } });
    const trace = traced(host);
    const result = await send(trace.bridge, bytes);
    expect(result.status).toBe(201);
    expect(observed).toEqual([hash(bytes)]);
    const methods = trace.calls.map(call => call.method);
    if (size <= 512 * 1024) expect(methods).toEqual([RequestMethod.HttpFetch]);
    else {
      expect(methods[0]).toBe(RequestMethod.HttpUploadStart);
      expect(methods.at(-1)).toBe(RequestMethod.HttpUploadFinish);
      expect(methods).not.toContain(RequestMethod.HttpFetch);
      expect(trace.chunkHash()).toBe(hash(bytes));
      expect(host.networkRequests).toHaveLength(1);
      expect(host.networkRequests[0]).toMatchObject({ bodyBytes: size });
      expect(host.networkRequests[0]).not.toHaveProperty("bodyBase64");
    }
    expect(trace.calls.every(call => call.messageBytes <= limits.networkRequestBytes)).toBe(true);
  });
}

test("production multipart preserves boundary, fields, File metadata and both full-body/file SHA", async () => {
  const original = body(2 * MiB);
  const form = new FormData();
  form.append("file", new File([original], "synthetic.bin", { type: "application/octet-stream" }));
  form.append("label", "synthetic-only");
  let fullHash = "";
  let totalBytes = 0;
  let header = "";
  const host = makeHost({ networkHandler: async input => {
    const raw = new Uint8Array(await input.body.arrayBuffer());
    totalBytes = raw.byteLength; fullHash = hash(raw);
    // CLI contract tests install Happy DOM, whose Headers retains original casing.
    header = new Headers(input.request["headers"] as Record<string, string>).get("content-type")!;
    const parsed = await new Response(input.body, { headers: { "content-type": header } }).formData();
    const file = parsed.get("file") as File;
    expect(file.name).toBe("synthetic.bin"); expect(file.type).toBe("application/octet-stream");
    expect(file.size).toBe(original.byteLength); expect(hash(new Uint8Array(await file.arrayBuffer()))).toBe(hash(original));
    expect(parsed.get("label")).toBe("synthetic-only");
    return response;
  } });
  const trace = traced(host);
  expect((await send(trace.bridge, form)).status).toBe(201);
  expect(fullHash).toBe(trace.chunkHash());
  expect(header).toContain("multipart/form-data; boundary=");
  expect(trace.calls[0]!.params["bodyBytes"]).toBe(totalBytes);
  const offsets = trace.calls.filter(call => call.method === RequestMethod.HttpUploadChunk).map(call => call.params["offset"]);
  expect(offsets).toEqual(Array.from({ length: Math.ceil(totalBytes / limits.networkUploadChunkBytes) }, (_, i) => i * limits.networkUploadChunkBytes));
  expect(trace.calls.every(call => call.messageBytes <= limits.networkRequestBytes)).toBe(true);
});

for (const [name, mutate, code] of [
  ["missing bodyBytes before permission", (p: Record<string, unknown>) => { delete p["bodyBytes"]; }, "BRIDGE_BAD_PARAMS"],
  ["negative bodyBytes", (p: Record<string, unknown>) => { p["bodyBytes"] = -1; }, "BRIDGE_BAD_PARAMS"],
  ["noninteger bodyBytes", (p: Record<string, unknown>) => { p["bodyBytes"] = 0.5; }, "BRIDGE_BAD_PARAMS"],
  ["invalid URL before endpoint", (p: Record<string, unknown>) => { p["url"] = ":invalid"; }, "NETWORK_URL_INVALID"],
  ["unknown start field", (p: Record<string, unknown>) => { p["extra"] = true; }, "NETWORK_URL_INVALID"],
  ["redirect enum", (p: Record<string, unknown>) => { p["redirect"] = "not-a-mode"; }, "NETWORK_URL_INVALID"],
  ["redirect array", (p: Record<string, unknown>) => { p["redirect"] = ["follow"]; }, "NETWORK_URL_INVALID"],
  ["requestId over 128 UTF8 bytes", (p: Record<string, unknown>) => { p["requestId"] = "😀".repeat(33); }, "NETWORK_URL_INVALID"],
  ["zero body", (p: Record<string, unknown>) => { p["bodyBytes"] = 0; }, "NETWORK_REQUEST_TOO_LARGE"],
  ["oversized body", (p: Record<string, unknown>) => { p["bodyBytes"] = limits.networkUploadBodyBytes + 1; }, "NETWORK_REQUEST_TOO_LARGE"],
  ["inline body supplied", (p: Record<string, unknown>) => { p["bodyBase64"] = "YQ=="; }, "NETWORK_REQUEST_TOO_LARGE"],
  ["bounded metadata", (p: Record<string, unknown>) => { p["headers"] = { "x-fixture": "a".repeat(limits.networkRequestBytes + 1) }; }, "NETWORK_REQUEST_TOO_LARGE"],
] as const) {
  test(`SDK start rejection: ${name}`, async () => {
    const declaration = manifest();
    if (name === "missing bodyBytes before permission") declaration.permissions = [];
    const host = makeHost({}, declaration);
    const trace = traced(host, { before(method, params) { if (method === RequestMethod.HttpUploadStart) mutate(params); } });
    await expect(send(trace.bridge)).rejects.toMatchObject({ code });
    expect(host.networkRequests).toHaveLength(0);
    declaration.permissions = [{ id: "http.fetch@1" }];
    await succeed(host);
  });
}

for (const [name, init, code] of [
  ["permission", {}, "NETWORK_PERMISSION_REQUIRED"],
  ["endpoint id", { endpointId: "not-declared" }, "NETWORK_ENDPOINT_NOT_DECLARED"],
  ["origin", { url: "https://other.invalid/fixture/upload" }, "NETWORK_ENDPOINT_NOT_DECLARED"],
  ["path sibling", { url: "https://synthetic.invalid/fixture-other" }, "NETWORK_ENDPOINT_NOT_DECLARED"],
  ["method", { method: "PUT" }, "NETWORK_ENDPOINT_NOT_DECLARED"],
] as const) {
  test(`SDK uses existing declared network scope: ${name}`, async () => {
    const declaration = manifest();
    if (name === "permission") declaration.permissions = [];
    const host = makeHost({}, declaration);
    const trace = traced(host, { before(method, params) { if (method === RequestMethod.HttpUploadStart) Object.assign(params, init); } });
    await expect(send(trace.bridge)).rejects.toMatchObject({ code });
    expect(host.networkRequests).toHaveLength(0);
  });
}

for (const [name, mutate, code] of [
  ["offset", (p: Record<string, unknown>) => { p["offset"] = 1; }, "NETWORK_URL_INVALID"],
  ["base64 alphabet", (p: Record<string, unknown>) => { p["bodyBase64"] = "!!!="; }, "NETWORK_URL_INVALID"],
  ["base64 padding", (p: Record<string, unknown>) => { p["bodyBase64"] = "YQ"; }, "NETWORK_URL_INVALID"],
  ["base64 whitespace", (p: Record<string, unknown>) => { p["bodyBase64"] = "Y Q=="; }, "NETWORK_URL_INVALID"],
  ["base64 tail bits", (p: Record<string, unknown>) => { p["bodyBase64"] = "YR=="; }, "NETWORK_URL_INVALID"],
  ["empty chunk", (p: Record<string, unknown>) => { p["bodyBase64"] = ""; }, "NETWORK_REQUEST_TOO_LARGE"],
  ["encoded limit", (p: Record<string, unknown>) => { p["bodyBase64"] = "A".repeat(Math.ceil(limits.networkUploadChunkBytes / 3) * 4 + 4); }, "NETWORK_REQUEST_TOO_LARGE"],
  ["decoded limit", (p: Record<string, unknown>) => { p["bodyBase64"] = encode(new Uint8Array(limits.networkUploadChunkBytes + 1)); }, "NETWORK_REQUEST_TOO_LARGE"],
] as const) {
  test(`SDK chunk rejection and cleanup: ${name}`, async () => {
    const host = makeHost();
    const trace = traced(host, { before(method, params) { if (method === RequestMethod.HttpUploadChunk) mutate(params); } });
    await expect(send(trace.bridge)).rejects.toMatchObject({ code });
    expect(trace.calls.map(call => call.method)).not.toContain(RequestMethod.HttpUploadFinish);
    await succeed(host);
  });
}

test("direct envelope parsing does not claim/delete an existing upload; production SDK remains usable", async () => {
  const host = makeHost();
  const { uploadId } = await directStart(host);
  for (const params of [{ uploadId, offset: 0, bodyBase64: "YQ==", extra: true }, { uploadId, offset: "0", bodyBase64: "YQ==" }]) {
    await expect(host.bridge.request(RequestMethod.HttpUploadChunk, params)).rejects.toMatchObject({ code: "BRIDGE_BAD_PARAMS" });
  }
  await expect(host.bridge.request(RequestMethod.HttpUploadFinish, { uploadId, extra: true })).rejects.toMatchObject({ code: "BRIDGE_BAD_PARAMS" });
  await expect(host.bridge.request(RequestMethod.HttpUploadChunk, { uploadId: "foreign", offset: 0, bodyBase64: "YQ==" })).rejects.toMatchObject({ code: "NETWORK_CANCELLED" });
  await expect(host.bridge.request(RequestMethod.HttpUploadChunk, { uploadId, offset: 0, bodyBase64: "YQ==" })).resolves.toEqual({ receivedBytes: 1 });
  await expect(host.bridge.request(RequestMethod.HttpUploadFinish, { uploadId })).resolves.toMatchObject({ status: 201 });
  await expect(host.bridge.request(RequestMethod.HttpUploadFinish, { uploadId })).rejects.toMatchObject({ code: "NETWORK_CANCELLED" });
  await succeed(host);
});

for (const fault of ["incomplete finish", "duplicate offset", "cumulative length"]) {
  test(`owned direct state error releases its quota: ${fault}`, async () => {
    const host = makeHost();
    const { uploadId } = await directStart(host, crypto.randomUUID(), 2);
    await host.bridge.request(RequestMethod.HttpUploadChunk, { uploadId, offset: 0, bodyBase64: "YQ==" });
    const failure = fault === "incomplete finish" ? host.bridge.request(RequestMethod.HttpUploadFinish, { uploadId })
      : host.bridge.request(RequestMethod.HttpUploadChunk, { uploadId, offset: fault === "duplicate offset" ? 0 : 1, bodyBase64: fault === "duplicate offset" ? "YQ==" : "YWI=" });
    await expect(failure).rejects.toMatchObject({ code: "NETWORK_URL_INVALID" });
    await succeed(host);
  });
}

test("quota rejects second SDK start without cancelling first, including duplicate requestId", async () => {
  const host = makeHost();
  const started = deferred<void>(), resume = deferred<void>();
  let requestId = "";
  const first = traced(host, { async after(method, params) { if (method === RequestMethod.HttpUploadStart) { requestId = params["requestId"] as string; started.resolve(); await resume.promise; } } });
  const pending = send(first.bridge); await Promise.race([started.promise, pending]);
  await expect(send(host.bridge)).rejects.toMatchObject({ code: "NETWORK_RATE_LIMITED" });
  await expect(directStart(host, requestId)).rejects.toMatchObject({ code: "NETWORK_RATE_LIMITED" });
  resume.resolve(); expect((await pending).status).toBe(201);
  await succeed(host);
});

test("SDK abort after first chunk cancels exact request and never finishes", async () => {
  const controller = new AbortController();
  const host = makeHost();
  const trace = traced(host, { after(method) { if (method === RequestMethod.HttpUploadChunk) controller.abort(); } });
  await expect(send(trace.bridge, body(), controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  expect(trace.calls.filter(call => call.method === RequestMethod.HttpUploadChunk)).toHaveLength(1);
  expect(trace.calls.map(call => call.method)).toContain(RequestMethod.HttpCancel);
  expect(trace.calls.map(call => call.method)).not.toContain(RequestMethod.HttpUploadFinish);
  await succeed(host);
});

test("scope is rechecked during SDK chunk and cleanup permits a fresh request", async () => {
  const declaration = manifest();
  const host = makeHost({}, declaration);
  const trace = traced(host, { after(method) { if (method === RequestMethod.HttpUploadChunk) declaration.permissions = []; } });
  await expect(send(trace.bridge)).rejects.toMatchObject({ code: "NETWORK_PERMISSION_REQUIRED" });
  declaration.permissions = [{ id: "http.fetch@1" }]; await succeed(host);
});

test("finish rechecks endpoint before callback, then clears staging", async () => {
  const declaration = manifest(); let handled = 0;
  const host = makeHost({ networkHandler() { handled++; return response; } }, declaration);
  const trace = traced(host, { before(method) { if (method === RequestMethod.HttpUploadFinish) declaration.network!.endpoints = []; } });
  await expect(send(trace.bridge)).rejects.toMatchObject({ code: "NETWORK_ENDPOINT_NOT_DECLARED" });
  expect(handled).toBe(0); declaration.network = manifest().network!; await succeed(host);
});

test("callback failure keeps typed error and releases staging", async () => {
  let fail = true;
  const host = makeHost({ networkHandler() { if (fail) throw { code: "NETWORK_UPSTREAM_FAILED", message: "Synthetic fixture failure" }; return response; } });
  await expect(send(host.bridge)).rejects.toMatchObject({ code: "NETWORK_UPSTREAM_FAILED" });
  fail = false; await succeed(host);
});

test("sending keeps quota; cancel rejects promptly; old callback cannot clear new upload", async () => {
  const old = deferred<typeof response>(), current = deferred<typeof response>();
  const entered = [deferred<void>(), deferred<void>()];
  const signals: AbortSignal[] = []; let number = 0;
  const host = makeHost({ networkHandler(input) { const index = number++; signals.push(input.signal); entered[index]?.resolve(); return index === 0 ? old.promise : current.promise; } });
  let requestId = "", uploadId = "";
  const trace = traced(host, { after(method, params, result) { if (method === RequestMethod.HttpUploadStart) { requestId = params["requestId"] as string; uploadId = (result as { uploadId: string }).uploadId; } } });
  const first = send(trace.bridge); const firstOutcome = first.then(() => ({ code: "unexpected-success" }), error => ({ code: error.code }));
  await Promise.race([entered[0]!.promise, first]);
  await expect(send(host.bridge)).rejects.toMatchObject({ code: "NETWORK_RATE_LIMITED" });
  await expect(host.bridge.request(RequestMethod.HttpUploadFinish, { uploadId })).rejects.toMatchObject({ code: "NETWORK_CANCELLED" });
  expect(signals[0]!.aborted).toBe(false);
  await expect(host.bridge.request(RequestMethod.HttpCancel, { requestId: "unmatched" })).resolves.toEqual({ cancelled: false });
  await expect(host.bridge.request(RequestMethod.HttpCancel, { requestId })).resolves.toEqual({ cancelled: true });
  expect(signals[0]!.aborted).toBe(true);
  const outcome = await Promise.race([firstOutcome, Bun.sleep(1000).then(() => ({ code: "fixture-timeout" }))]);
  expect(outcome.code).toBe("NETWORK_CANCELLED");
  await expect(host.bridge.request(RequestMethod.HttpCancel, { requestId })).resolves.toEqual({ cancelled: false });
  const second = send(host.bridge); await Promise.race([entered[1]!.promise, second]);
  old.resolve(response); await Promise.resolve();
  await expect(send(host.bridge)).rejects.toMatchObject({ code: "NETWORK_RATE_LIMITED" });
  current.resolve(response); expect((await second).status).toBe(201);
  expect(number).toBe(2);
});

for (const [kind, increment, size] of [["idle", limits.networkUploadIdleTimeoutMs, 512 * 1024 + 1], ["absolute", limits.networkUploadIdleTimeoutMs / 2, 3 * MiB]] as const) {
  test(`SDK observes lazy ${kind} expiry and cleaned quota`, async () => {
    let now = 0;
    const host = makeHost({ networkUploadNow: () => now });
    const trace = traced(host, { before(method) { if (method === RequestMethod.HttpUploadChunk) now += increment; } });
    await expect(send(trace.bridge, body(size))).rejects.toMatchObject({ code: "NETWORK_TIMEOUT" });
    await succeed(host);
  });
}

test("canonical bounds accept maximum declaration and chunk, then explicit cancel releases memory", async () => {
  const host = makeHost();
  const requestId = crypto.randomUUID();
  const { uploadId } = await directStart(host, requestId, limits.networkUploadBodyBytes);
  await expect(host.bridge.request(RequestMethod.HttpUploadChunk, { uploadId, offset: 0, bodyBase64: encode(new Uint8Array(limits.networkUploadChunkBytes)) }))
    .resolves.toEqual({ receivedBytes: limits.networkUploadChunkBytes });
  await expect(host.bridge.request(RequestMethod.HttpCancel, { requestId })).resolves.toEqual({ cancelled: true });
  await expect(host.bridge.request(RequestMethod.HttpUploadFinish, { uploadId })).rejects.toMatchObject({ code: "NETWORK_CANCELLED" });
  await succeed(host);
});

test("production SDK rejects >50MiB File and >52MiB body before creating mock staging", async () => {
  const host = makeHost(); const trace = traced(host);
  const form = new FormData(); form.append("file", new File([new Uint8Array(50 * MiB + 1)], "oversized.bin"));
  await expect(send(trace.bridge, form)).rejects.toMatchObject({ code: "NETWORK_REQUEST_TOO_LARGE" });
  await expect(send(trace.bridge, new Uint8Array(limits.networkUploadBodyBytes + 1))).rejects.toMatchObject({ code: "NETWORK_REQUEST_TOO_LARGE" });
  expect(trace.calls).toEqual([]); expect(host.networkRequests).toEqual([]);
});

test("disable clears only this MockHost staging; separate synthetic instance is independent", async () => {
  const host = makeHost(), other = makeHost();
  const first = await directStart(host); const second = await directStart(other);
  await host.disable();
  await expect(host.bridge.request(RequestMethod.HttpUploadFinish, first)).rejects.toMatchObject({ code: "NETWORK_CANCELLED" });
  await other.bridge.request(RequestMethod.HttpUploadChunk, { ...second, offset: 0, bodyBase64: "YQ==" });
  await expect(other.bridge.request(RequestMethod.HttpUploadFinish, second)).resolves.toMatchObject({ status: 201 });
  await succeed(host); // Quota cleanup only. This is not native enabled-state or account isolation proof.
});

test("staged metadata snapshot cannot be changed by the original caller", async () => {
  let observed = "";
  const host = makeHost({ networkHandler(input) { observed = String((input.request["headers"] as Record<string, unknown>)["x-fixture"]); return response; } });
  const trace = traced(host, {
    before(method, params) { if (method === RequestMethod.HttpUploadStart) (params["headers"] as Record<string, unknown>)["x-fixture"] = "original"; },
    after(method, params) { if (method === RequestMethod.HttpUploadStart) (params["headers"] as Record<string, unknown>)["x-fixture"] = "changed"; },
  });
  expect((await send(trace.bridge)).status).toBe(201); expect(observed).toBe("original");
  expect(host.networkRequests[0]!["headers"]).toMatchObject({ "x-fixture": "original" });
});
