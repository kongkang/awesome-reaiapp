import type { ServiceCaller } from "@reai/app-sdk/v1";

const ADMISSION_WINDOW_MS = 60_000;
const FUTURE_TOLERANCE_MS = 5_000;
const MAX_ENTRIES = 256;
const ID = /^(\d{1,16}):[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i;

/** 只用于服务错误码映射，调用入口按当前 locale 生成用户文案。 */
export class VoiceAdmissionError extends Error {
  constructor(readonly code: string) { super(code); }
}

export interface VoiceTextRequest {
  requestId: string;
  timeoutMs: number;
}

export function parseVoiceTextRequest(input: unknown): VoiceTextRequest {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new VoiceAdmissionError("VOICE_REQUEST_INVALID");
  }
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some((key) => key !== "requestId" && key !== "timeoutMs")
    || typeof value.requestId !== "string" || !ID.test(value.requestId)) {
    throw new VoiceAdmissionError("VOICE_REQUEST_INVALID");
  }
  const createdAt = Number(value.requestId.split(":", 1)[0]);
  const timeoutMs = value.timeoutMs === undefined ? 180_000 : value.timeoutMs;
  if (!Number.isSafeInteger(createdAt) || !Number.isSafeInteger(timeoutMs)
    || (timeoutMs as number) < 1_000 || (timeoutMs as number) > 300_000) {
    throw new VoiceAdmissionError("VOICE_REQUEST_INVALID");
  }
  return { requestId: value.requestId, timeoutMs: timeoutMs as number };
}

/**
 * F01 合同（plans/2026-09-06-f01-auth-session-api-clarifications.md §「F04 唯一非敏感
 * epoch」）：accountGeneration 是 Host 下发的非敏感操作归属标签（instance_id +
 * 权威 generation 派生的不透明字符串），consumer 只比较/携带，不解析内容、不自造
 * 格式、不伪造值。四项（appId/surfaceMountId/runtimeSessionId/accountGeneration）均必填
 * ——主裁定 A 的过渡性放宽已于 2026-09-06 按台账必做项收回：Host 信封已在可读时
 * 携带代际，不可读时省略字段，由这里 fail-closed 拒绝（1.0 发布合同必填）。
 */
export function voiceRequestOwnerKey(caller: ServiceCaller | undefined): string {
  const parts = [caller?.appId, caller?.surfaceMountId, caller?.runtimeSessionId, caller?.accountGeneration];
  if (parts.some((part) => typeof part !== "string" || !part || part.length > 256)) {
    throw new VoiceAdmissionError("VOICE_REQUEST_IDENTITY_REQUIRED");
  }
  return JSON.stringify(parts);
}

/** 仅保存已消耗的 ID 和身份元数据；不含音频、文字、截图或账号资料。 */
export interface VoiceAdmissionState {
  version: 1;
  clockFloor: number;
  entries: Array<{ owner: string; requestId: string; expiresAt: number; cancelled?: boolean }>;
}

export interface VoiceAdmissionStore {
  read(): Promise<unknown>;
  write(value: VoiceAdmissionState): Promise<void>;
}

function readState(value: unknown): VoiceAdmissionState {
  if (value === undefined || value === null) return { version: 1, clockFloor: 0, entries: [] };
  if (typeof value !== "object") throw new VoiceAdmissionError("VOICE_REQUEST_STORAGE_UNAVAILABLE");
  const state = value as VoiceAdmissionState;
  if (state.version !== 1 || !Number.isSafeInteger(state.clockFloor) || state.clockFloor < 0
    || !Array.isArray(state.entries) || state.entries.length > MAX_ENTRIES
    || state.entries.some((entry) => !entry || typeof entry.owner !== "string" || entry.owner.length > 2_048
      || typeof entry.requestId !== "string" || !ID.test(entry.requestId)
      || !Number.isSafeInteger(entry.expiresAt)
      || (entry.cancelled !== undefined && typeof entry.cancelled !== "boolean")
      || entry.expiresAt !== Number(entry.requestId.split(":", 1)[0]) + ADMISSION_WINDOW_MS)) {
    throw new VoiceAdmissionError("VOICE_REQUEST_STORAGE_UNAVAILABLE");
  }
  return structuredClone(state);
}

/**
 * 在任何采集副作用之前持久消耗业务 requestId。状态展示的 60 秒/32 条缓存另行管理，
 * 不能因 UI 缓存淘汰而重新接受旧请求。只有首次 admission 检查新鲜度，录音中不复查。
 */
export class VoiceRequestAdmission {
  private queue = Promise.resolve();
  private unavailable = false;

  private constructor(
    private readonly store: VoiceAdmissionStore,
    private state: VoiceAdmissionState,
    private readonly now: () => number,
    private readonly capacity: number,
  ) {}

  static async open(store: VoiceAdmissionStore, now = Date.now, capacity = MAX_ENTRIES): Promise<VoiceRequestAdmission> {
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > MAX_ENTRIES) {
      throw new VoiceAdmissionError("VOICE_REQUEST_INVALID");
    }
    try {
      return new VoiceRequestAdmission(store, readState(await store.read()), now, capacity);
    } catch {
      throw new VoiceAdmissionError("VOICE_REQUEST_STORAGE_UNAVAILABLE");
    }
  }

  claim(caller: ServiceCaller | undefined, input: unknown, cancelled = false): Promise<VoiceTextRequest> {
    // 只捕获不可变标量，不把调用方传入的可变对象带过异步边界。
    let owner: string;
    let request: VoiceTextRequest;
    try {
      owner = voiceRequestOwnerKey(caller);
      request = parseVoiceTextRequest(input);
    } catch (error) {
      return Promise.reject(error);
    }
    const result = this.queue.then(async () => {
      if (this.unavailable) throw new VoiceAdmissionError("VOICE_REQUEST_STORAGE_UNAVAILABLE");
      const now = this.now();
      if (!Number.isSafeInteger(now) || now < this.state.clockFloor) {
        throw new VoiceAdmissionError("VOICE_REQUEST_CLOCK_CHANGED");
      }
      const createdAt = Number(request.requestId.split(":", 1)[0]);
      if (createdAt > now + FUTURE_TOLERANCE_MS || createdAt + ADMISSION_WINDOW_MS <= now) {
        throw new VoiceAdmissionError("VOICE_REQUEST_EXPIRED");
      }
      const entries = this.state.entries.filter((entry) => entry.expiresAt > now);
      const existing = entries.find((entry) => entry.owner === owner && entry.requestId === request.requestId);
      if (existing) {
        throw new VoiceAdmissionError(existing.cancelled ? "SERVICE_CANCELLED" : "VOICE_REQUEST_REPLAYED");
      }
      if (entries.length >= this.capacity) throw new VoiceAdmissionError("SERVICE_BUSY");
      const next: VoiceAdmissionState = {
        version: 1, clockFloor: now,
        entries: [...entries, { owner, requestId: request.requestId, expiresAt: createdAt + ADMISSION_WINDOW_MS, ...(cancelled ? { cancelled: true } : {}) }],
      };
      try {
        await this.store.write(next);
      } catch {
        // KV 返回失败可能发生在落盘之后；本进程不得假定未消耗而重试启动。
        this.unavailable = true;
        throw new VoiceAdmissionError("VOICE_REQUEST_STORAGE_UNAVAILABLE");
      }
      this.state = next;
      return request;
    });
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
}
