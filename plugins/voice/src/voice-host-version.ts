import type { SystemTaskVersionStatus } from "@reai/app-sdk/v1";
import type { VoiceHostVersion } from "./voice-diagnostics";
import { collectErrorFields } from "./voice-error-fields";

/**
 * Host（Driver App）版本读取状态机（设计规范 §6.0 ⑨：有 Host 版本接口就带上）。
 *
 * 唯一来源是已声明的 `system.tasks@1` version-status；Host 只允许用户正在看的插件界面调用、
 * 同界面 2 秒限频、缓存缺失时还会触网。所以：activation 内共享一个在途请求，只缓存成功，
 * 两次发起至少间隔 2.5 秒，本地最多等 5 秒（超时后 Host 请求可能仍在进行，晚到的成功照样采用），
 * dispose 后的晚到结果丢弃；失败后下一次可见挂载或复制诊断可以重试。
 */
/** 本地等 Host 版本回复的上限；诊断文案「读取超时（N 秒内未返回）」按它插值。 */
export const HOST_VERSION_TIMEOUT_MS = 5_000;

export interface HostVersionReaderOptions {
  read(): Promise<SystemTaskVersionStatus>;
  publish(value: VoiceHostVersion): void;
  now?(): number;
  timeoutMs?: number;
  minIntervalMs?: number;
}

export class HostVersionReader {
  private value: VoiceHostVersion = { state: "unread" };
  private inflight: Promise<VoiceHostVersion> | undefined;
  private lastAttemptAt = Number.NEGATIVE_INFINITY;
  private disposed = false;
  private visibleRefresh: (() => void) | undefined;
  private renewVisibleRefresh: (() => void) | undefined;
  private visibleScopes = new Map<object, () => void>();
  private requestId = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private timerRequest = 0;
  /** 结算当前等待者（dispose 时也要结算，不让调用方永远挂着）。 */
  private settleCurrent: (() => void) | undefined;

  constructor(private readonly options: HostVersionReaderOptions) {}

  get current(): VoiceHostVersion {
    return this.value;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private set(value: VoiceHostVersion): void {
    if (this.disposed) return;
    this.value = value;
    this.options.publish(value);
  }

  /**
   * 在可见 Surface 上触发一次读取；已成功、在途或间隔不足时复用当前结果，不另起查询。
   * 返回的 Promise 最迟在本地时限（默认 5 秒）结算：Host 不返回时调用方也能按超时继续（如安排重试）。
   * 每次请求有代次：晚到的**成功**总是采用（版本就是版本），晚到的**失败**只在仍是最新请求时采用，
   * 不会把新请求的 loading 改写掉。
   */
  request(): Promise<VoiceHostVersion> {
    if (this.disposed || this.value.state === "ready") return Promise.resolve(this.value);
    if (this.inflight) return this.inflight;
    if (this.now() - this.lastAttemptAt < (this.options.minIntervalMs ?? 2500)) return Promise.resolve(this.value);
    this.lastAttemptAt = this.now();
    const requestId = ++this.requestId;
    this.set({ state: "loading" });
    let settle!: (value: VoiceHostVersion) => void;
    const bounded = new Promise<VoiceHostVersion>((resolve) => { settle = resolve; });
    const release = () => {
      if (this.settleCurrent === release) this.settleCurrent = undefined;
      if (this.inflight === bounded) this.inflight = undefined;
      if (this.timer !== undefined && this.timerRequest === requestId) { clearTimeout(this.timer); this.timer = undefined; }
      settle(this.value);
    };
    this.options.read().then(
      (status): VoiceHostVersion => {
        const version = status?.app?.currentVersion;
        return typeof version === "string" && version.trim()
          // 不截断：截断后的前缀可能恰好又是合法版本号，冒充另一个版本；完整值交给展示层文法校验。
          ? { state: "ready", version: version.trim() }
          : { state: "rejected", missing: true };
      },
      (cause: unknown): VoiceHostVersion => {
        // 只留错误码（结构化文法）；Host 的原因原文不进诊断。
        const code = collectErrorFields(cause).code;
        return { state: "rejected", ...(code ? { code } : {}) };
      },
    ).then((result) => {
      if (!this.disposed && this.value.state !== "ready" && (result.state === "ready" || requestId === this.requestId)) {
        this.set(result);
      }
      if (requestId === this.requestId) release();
    });
    this.inflight = bounded;
    this.settleCurrent = release;
    this.timerRequest = requestId;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (requestId !== this.requestId || this.inflight !== bounded) return;
      if (this.value.state === "loading") this.set({ state: "timeout" });
      // Host 可能永不返回：结算等待者并放开在途引用，下一次可见挂载或复制仍可重试（受最小间隔约束）。
      release();
    }, this.options.timeoutMs ?? HOST_VERSION_TIMEOUT_MS);
    return bounded;
  }

  /** Each user-visible mount, intent or history navigation renews at most two refresh attempts.
   * Coalesce requests; new visible events renew the bounded retry budget. Wait out the existing
   * 2.5s interval, never bypass Host admission or poll without a new visible event.
   * The returned cancellation belongs to the mounted Surface; dispose also cancels it.
   */
  refreshOnVisible(scope: object = this): () => void {
    if (this.disposed || this.value.state === "ready") return () => {};
    const existingScope = this.visibleScopes.get(scope);
    if (existingScope) {
      this.renewVisibleRefresh?.();
      return existingScope;
    }
    const cancelScope = () => {
      if (this.visibleScopes.get(scope) !== cancelScope) return;
      this.visibleScopes.delete(scope);
      if (this.visibleScopes.size === 0) this.visibleRefresh?.();
    };
    this.visibleScopes.set(scope, cancelScope);
    if (this.visibleRefresh) {
      this.renewVisibleRefresh?.();
      return cancelScope;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempts = 2;
    const cancel = () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
      if (this.visibleRefresh === cancel) {
        this.visibleRefresh = undefined;
        this.renewVisibleRefresh = undefined;
        this.visibleScopes.clear();
      }
    };
    const schedule = () => {
      if (cancelled || this.disposed) return;
      const delay = Math.max(0, (this.options.minIntervalMs ?? 2500) - (this.now() - this.lastAttemptAt) + 1);
      timer = setTimeout(() => {
        timer = undefined;
        if (cancelled || this.disposed) return;
        const previousRequestId = this.requestId;
        const reusedInflight = this.inflight !== undefined;
        const pending = this.request();
        const consumedAttempt = reusedInflight || this.requestId !== previousRequestId;
        void pending.then((value) => {
          if (cancelled || this.disposed) return;
          // A timer wakeup still inside admission's interval is not a Host read.
          // Preserve the bounded read budget and wait out the remaining interval.
          if (consumedAttempt) attempts -= 1;
          if (value.state === "ready" || attempts === 0) cancel();
          else schedule();
        });
      }, delay);
    };
    this.visibleRefresh = cancel;
    // A new visible intent while the final hidden request is still settling must not be lost.
    this.renewVisibleRefresh = () => { attempts = 2; };
    schedule();
    return cancelScope;
  }

  /** 复制诊断前补读：复用在途请求，最多等 `waitMs`，到点返回当时状态。 */
  async ensure(waitMs = 3000): Promise<VoiceHostVersion> {
    const pending = this.request();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<VoiceHostVersion>((resolve) => {
      timer = setTimeout(() => resolve(this.value), waitMs);
    });
    try {
      return await Promise.race([pending, timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  dispose(): void {
    this.visibleRefresh?.();
    const settleNow = this.settleCurrent;
    this.settleCurrent = undefined;
    this.disposed = true;
    this.inflight = undefined;
    this.requestId += 1;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    settleNow?.();
  }
}
