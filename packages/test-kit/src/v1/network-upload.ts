import matrix from "@reai/app-contract/host-support-matrix.json" with { type: "json" };

type Request = Record<string, unknown> & { requestId: string; url: string };
type CheckScope = (request: Request) => void;
type Failure = (code: string, message: string) => Error;
interface Entry {
  uploadId: string;
  request: Request;
  expected: number;
  received: number;
  created: number;
  touched: number;
  buffer: Uint8Array | undefined;
  controller: AbortController;
  phase: "staging" | "sending";
}

const limits = matrix.limits;
for (const key of ["networkRequestBytes", "networkUploadBodyBytes", "networkUploadChunkBytes",
  "networkUploadInflightPerApp", "networkUploadIdleTimeoutMs", "networkUploadAbsoluteTimeoutMs"] as const) {
  if (!Number.isSafeInteger(limits[key]) || limits[key] <= 0) throw new Error(`Invalid upload limit: ${key}`);
}
if (limits.networkUploadInflightPerApp !== 1) throw new Error("Mock upload storage requires one entry per App");

/** One synthetic App's bounded upload storage. It does not model native grants or account quotas. */
export class MockNetworkUploads {
  private current: Entry | undefined;

  constructor(private readonly failure: Failure, private readonly now: () => number = Date.now) {}

  start(params: unknown, checkScope: CheckScope): { uploadId: string; request: Request; bodyBytes: number } {
    const input = this.record(params, "BRIDGE_BAD_PARAMS");
    const bodyBytes = input["bodyBytes"];
    if (typeof bodyBytes !== "number" || !Number.isFinite(bodyBytes) || !Number.isInteger(bodyBytes) || bodyBytes < 0) {
      throw this.failure("BRIDGE_BAD_PARAMS", "bodyBytes must be a nonnegative integer");
    }
    this.keys(input, ["requestId", "url", "endpointId", "method", "headers", "timeoutMs", "redirect", "bodyBase64", "bodyBytes"], "NETWORK_URL_INVALID");
    const requestId = input["requestId"];
    if (typeof requestId !== "string" || !requestId || new TextEncoder().encode(requestId).byteLength > 128
      || typeof input["url"] !== "string"
      || (input["method"] !== undefined && typeof input["method"] !== "string")
      || (input["endpointId"] !== undefined && typeof input["endpointId"] !== "string")
      || (input["redirect"] !== undefined && (typeof input["redirect"] !== "string" || !["follow", "manual", "error"].includes(input["redirect"])))
      || (input["timeoutMs"] !== undefined && (typeof input["timeoutMs"] !== "number" || !Number.isSafeInteger(input["timeoutMs"]) || input["timeoutMs"] < 0))
      || (input["bodyBase64"] !== undefined && typeof input["bodyBase64"] !== "string")) {
      throw this.failure("NETWORK_URL_INVALID", "Invalid upload request metadata");
    }
    try { new URL(input["url"]); } catch { throw this.failure("NETWORK_URL_INVALID", "Invalid upload URL"); }
    const headers = input["headers"];
    if (headers !== undefined && (!headers || typeof headers !== "object" || Array.isArray(headers)
      || Object.values(headers).some(value => typeof value !== "string"))) {
      throw this.failure("NETWORK_URL_INVALID", "Upload headers must contain string values");
    }
    const { bodyBytes: _bytes, ...metadata } = input;
    const request = structuredClone(metadata) as Request;
    checkScope(request);
    if (!bodyBytes || bodyBytes > limits.networkUploadBodyBytes || input["bodyBase64"] !== undefined
      || new TextEncoder().encode(JSON.stringify(request)).byteLength > limits.networkRequestBytes) {
      throw this.failure("NETWORK_REQUEST_TOO_LARGE", "Upload body or metadata exceeds the limit");
    }
    if (this.current?.phase === "staging" && this.expired(this.current)) this.clear(this.current, true);
    if (this.current) throw this.failure("NETWORK_RATE_LIMITED", "An upload is already active for this App");
    const time = this.now();
    const entry: Entry = { uploadId: crypto.randomUUID(), request, expected: bodyBytes, received: 0,
      created: time, touched: time, buffer: new Uint8Array(bodyBytes), controller: new AbortController(), phase: "staging" };
    this.current = entry;
    return { uploadId: entry.uploadId, request: structuredClone(request), bodyBytes };
  }

  chunk(params: unknown, checkScope: CheckScope): { receivedBytes: number } {
    const input = this.record(params, "BRIDGE_BAD_PARAMS");
    this.keys(input, ["uploadId", "offset", "bodyBase64"], "BRIDGE_BAD_PARAMS");
    if (typeof input["uploadId"] !== "string" || typeof input["bodyBase64"] !== "string"
      || typeof input["offset"] !== "number" || !Number.isSafeInteger(input["offset"]) || input["offset"] < 0) {
      throw this.failure("BRIDGE_BAD_PARAMS", "Invalid upload chunk envelope");
    }
    const entry = this.claim(input["uploadId"]);
    try {
      this.check(entry, checkScope);
      const encoded = input["bodyBase64"];
      if (encoded.length > Math.ceil(limits.networkUploadChunkBytes / 3) * 4) {
        throw this.failure("NETWORK_REQUEST_TOO_LARGE", "Upload chunk exceeds the encoded limit");
      }
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
        throw this.failure("NETWORK_URL_INVALID", "Upload chunk must use canonical base64");
      }
      const bytes = Buffer.from(encoded, "base64");
      if (bytes.toString("base64") !== encoded) throw this.failure("NETWORK_URL_INVALID", "Upload chunk has invalid base64 tail bits");
      if (!bytes.length || bytes.length > limits.networkUploadChunkBytes) {
        throw this.failure("NETWORK_REQUEST_TOO_LARGE", "Upload chunk is empty or exceeds the limit");
      }
      if (input["offset"] !== entry.received || entry.received + bytes.length > entry.expected) {
        throw this.failure("NETWORK_URL_INVALID", "Upload chunk offset or total length does not match");
      }
      entry.buffer!.set(bytes, entry.received);
      entry.received += bytes.length;
      entry.touched = this.now();
      return { receivedBytes: entry.received };
    } catch (error) { this.clear(entry, true); throw error; }
  }

  async finish<T>(params: unknown, checkScope: CheckScope,
    send: (input: { request: Readonly<Record<string, unknown>>; body: Blob; signal: AbortSignal }) => T | Promise<T>): Promise<T> {
    const input = this.record(params, "BRIDGE_BAD_PARAMS");
    this.keys(input, ["uploadId"], "BRIDGE_BAD_PARAMS");
    if (typeof input["uploadId"] !== "string") throw this.failure("BRIDGE_BAD_PARAMS", "Invalid upload finish envelope");
    const entry = this.claim(input["uploadId"]);
    let onCancel: (() => void) | undefined;
    try {
      this.check(entry, checkScope);
      if (entry.received !== entry.expected) throw this.failure("NETWORK_URL_INVALID", "Upload body is incomplete");
      const body = new Blob([entry.buffer!]);
      entry.buffer = undefined;
      entry.phase = "sending";
      const signal = entry.controller.signal;
      const cancelled = new Promise<never>((_, reject) => {
        onCancel = () => reject(this.failure("NETWORK_CANCELLED", "Upload was cancelled"));
        signal.addEventListener("abort", onCancel, { once: true });
      });
      return await Promise.race([Promise.resolve(send({ request: structuredClone(entry.request), body, signal })), cancelled]);
    } catch (error) { this.clear(entry, true); throw error; }
    finally {
      if (onCancel) entry.controller.signal.removeEventListener("abort", onCancel);
      this.clear(entry, false);
    }
  }

  cancel(params: unknown): { cancelled: boolean } {
    const input = this.record(params, "BRIDGE_BAD_PARAMS");
    if (typeof input["requestId"] !== "string") throw this.failure("BRIDGE_BAD_PARAMS", "requestId must be a string");
    const entry = this.current;
    if (!entry || entry.request.requestId !== input["requestId"]) return { cancelled: false };
    this.clear(entry, true);
    return { cancelled: true };
  }

  dispose(): void { if (this.current) this.clear(this.current, true); }

  private record(params: unknown, code: string): Record<string, unknown> {
    if (!params || typeof params !== "object" || Array.isArray(params)) throw this.failure(code, "Upload parameters must be an object");
    return params as Record<string, unknown>;
  }
  private keys(input: Record<string, unknown>, allowed: readonly string[], code: string): void {
    if (Object.keys(input).some(key => !allowed.includes(key))) throw this.failure(code, "Upload parameters contain an unknown field");
  }
  private claim(uploadId: string): Entry {
    if (!this.current || this.current.uploadId !== uploadId || this.current.phase !== "staging") {
      throw this.failure("NETWORK_CANCELLED", "Upload is not available for staging");
    }
    return this.current;
  }
  private expired(entry: Entry): boolean {
    const time = this.now();
    return time - entry.touched >= limits.networkUploadIdleTimeoutMs || time - entry.created >= limits.networkUploadAbsoluteTimeoutMs;
  }
  private check(entry: Entry, checkScope: CheckScope): void {
    if (this.expired(entry)) throw this.failure("NETWORK_TIMEOUT", "Upload staging expired");
    checkScope(entry.request);
  }
  private clear(entry: Entry, cancel: boolean): void {
    entry.buffer = undefined;
    if (this.current === entry) this.current = undefined;
    if (cancel) entry.controller.abort();
  }
}
