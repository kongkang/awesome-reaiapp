import { describe, expect, test } from "bun:test";
import { brokerFetch, type HostBridge } from "../src/v1/index";

const MiB = 1024 * 1024;
const hash = (value: Uint8Array) => new Bun.CryptoHasher("sha256").update(value).digest("hex");

function uploadHost(onChunk?: () => void) {
  let metadata: Record<string, unknown> = {};
  const chunks: Uint8Array[] = [];
  const methods: string[] = [];
  let received = 0;
  const bridge: HostBridge = {
    async request(method, params) {
      const name: string = method;
      const data = params as Record<string, unknown>;
      methods.push(name);
      if (new TextEncoder().encode(JSON.stringify(params)).byteLength > MiB) {
        throw { code: "BRIDGE_MESSAGE_TOO_LARGE", message: "exceeds real Host message cap" };
      }
      if (name === "http.upload.start") {
        metadata = data;
        return { uploadId: "host-random-upload" } as never;
      }
      if (name === "http.upload.chunk") {
        expect(data.uploadId).toBe("host-random-upload");
        expect(data.offset).toBe(received);
        const decoded = Uint8Array.from(atob(data.bodyBase64 as string), c => c.charCodeAt(0));
        expect(decoded.byteLength).toBeLessThanOrEqual(256 * 1024);
        chunks.push(decoded);
        received += decoded.byteLength;
        onChunk?.();
        return { receivedBytes: received } as never;
      }
      if (name === "http.upload.finish") {
        expect(received).toBe(metadata.bodyBytes as number);
        return { status: 201, statusText: "Created", url: metadata.url,
          headers: { "content-type": "application/json" }, bodyBase64: btoa('{"fileId":"synthetic-id"}') } as never;
      }
      if (name === "http.cancel") return { cancelled: true } as never;
      throw { code: "BRIDGE_UNKNOWN_METHOD", message: "unexpected method" };
    },
    notify() {},
    subscribe() { return () => undefined; },
  };
  return { bridge, methods, async parsed() {
    return new Response(new Blob(chunks), { headers: metadata.headers as Record<string, string> }).formData();
  } };
}

describe("普通 FormData 大文件分块上传", () => {
  for (const size of [2, 20, 50]) {
    test(`${size}MiB 文件：单消息有界，原生 boundary 和文件 SHA256 保留`, async () => {
      const original = new Uint8Array(size * MiB).fill(17);
      const form = new FormData();
      form.append("file", new File([original], "synthetic.xlsx", { type: "application/octet-stream" }));
      form.append("label", "synthetic-only");
      const host = uploadHost();
      const response = await brokerFetch(host.bridge, "https://example.com/storage/selected/upload", {
        endpointId: "project-storage", method: "POST", body: form,
      });
      expect(response.status).toBe(201);
      expect(await response.json()).toEqual({ fileId: "synthetic-id" });
      expect(host.methods[0]).toBe("http.upload.start");
      expect(host.methods.at(-1)).toBe("http.upload.finish");
      expect(host.methods).not.toContain("http.fetch");
      const parsed = await host.parsed();
      const file = parsed.get("file") as File;
      expect(file.name).toBe("synthetic.xlsx");
      expect(file.size).toBe(original.byteLength);
      expect(hash(new Uint8Array(await file.arrayBuffer()))).toBe(hash(original));
      expect(parsed.get("label")).toBe("synthetic-only");
    }, size === 50 ? 20_000 : 5_000);
  }

  test("超过 50MiB 文件在创建 Host session 前拒绝", async () => {
    const form = new FormData();
    form.append("file", new File([new Uint8Array(50 * MiB + 1)], "oversize.xlsx"));
    const host = uploadHost();
    await expect(brokerFetch(host.bridge, "https://example.com/upload", { method: "POST", body: form }))
      .rejects.toMatchObject({ code: "NETWORK_REQUEST_TOO_LARGE" });
    expect(host.methods).toEqual([]);
  });

  test("分块窗口 abort 取消已开 session，随后不发送或 finish", async () => {
    const controller = new AbortController();
    const host = uploadHost(() => controller.abort());
    await expect(brokerFetch(host.bridge, "https://example.com/upload", {
      method: "POST", body: new Uint8Array(2 * MiB), signal: controller.signal,
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(host.methods.filter(name => name === "http.upload.chunk")).toHaveLength(1);
    expect(host.methods).toContain("http.cancel");
    expect(host.methods).not.toContain("http.upload.finish");
  });

  test("旧 Host 缺少新方法给出升级错误，不回塞旧 Bridge", async () => {
    const methods: string[] = [];
    const bridge: HostBridge = { async request(method) {
      methods.push(method);
      throw { code: "BRIDGE_UNKNOWN_METHOD", message: "old Host" };
    }, notify() {}, subscribe() { return () => undefined; } };
    await expect(brokerFetch(bridge, "https://example.com/upload", { method: "POST", body: new Uint8Array(2 * MiB) }))
      .rejects.toMatchObject({ code: "NETWORK_UPLOAD_UNSUPPORTED" });
    expect(methods).not.toContain("http.fetch");
  });
});
