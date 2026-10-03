/** Screenshot consent is owned by Voice. Epochs always come from the Host's
 * authoritative login session; the local revision only invalidates in-flight use. */
export interface VoiceScreenshotConsentRecord { enabled: boolean; consentEpoch?: string; version: 1 }
export interface VoiceScreenshotGrant {
  readonly sessionId: string;
  readonly consentEpoch: string;
  readonly signal?: AbortSignal;
  isCurrent(): boolean;
}
export interface VoiceScreenshotConsentPorts {
  readEpoch(): Promise<string>;
  save(record: VoiceScreenshotConsentRecord): Promise<void>;
  revoked(): void;
}

export class VoiceScreenshotConsent {
  private enabled = false;
  private epoch: string | undefined;
  private revision = 0;
  private usage = new AbortController();
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly ports: VoiceScreenshotConsentPorts, saved?: unknown) {
    if (saved && typeof saved === "object") {
      const value = saved as Partial<VoiceScreenshotConsentRecord>;
      if (value.version === 1 && value.enabled === true && this.validEpoch(value.consentEpoch)) {
        this.enabled = true;
        this.epoch = value.consentEpoch;
      }
    }
  }

  /** 当前会话是否处于已同意状态（含持久化恢复后的有效 epoch）。 */
  isEnabled(): boolean {
    return this.enabled;
  }

  private validEpoch(value: unknown): value is string {
    return typeof value === "string" && value.length > 0 && value.length <= 256;
  }

  private persist(record: VoiceScreenshotConsentRecord): Promise<void> {
    const write = this.writes.catch(() => undefined).then(() => this.ports.save(record));
    this.writes = write;
    return write;
  }

  async confirmEnable(confirm: () => Promise<boolean>): Promise<boolean> {
    const attempt = ++this.revision;
    const epoch = await this.ports.readEpoch();
    if (!this.validEpoch(epoch) || attempt !== this.revision) return false;
    if (!await confirm() || attempt !== this.revision) return false;
    if (await this.ports.readEpoch() !== epoch || attempt !== this.revision) return false;
    // Persist the explicit answer before enabling any collection.
    await this.persist({ enabled: true, consentEpoch: epoch, version: 1 });
    if (attempt !== this.revision) return false;
    this.epoch = epoch;
    this.enabled = true;
    return true;
  }

  async revoke(): Promise<void> {
    this.enabled = false;
    this.epoch = undefined;
    this.revision++;
    this.usage.abort();
    this.usage = new AbortController();
    this.ports.revoked();
    // Memory is already off even when storage fails. Never roll this back.
    await this.persist({ enabled: false, version: 1 });
  }

  /** Reconcile saved consent before displaying it, without collecting context.
   * undefined means a newer confirmation/revocation owns the visible state. */
  async refresh(onCurrent?: (enabled: boolean) => void): Promise<boolean | undefined> {
    const report = (enabled: boolean) => { onCurrent?.(enabled); return enabled; };
    if (!this.enabled || !this.epoch) return report(false);
    const revision = this.revision;
    const epoch = this.epoch;
    let current: string;
    try { current = await this.ports.readEpoch(); }
    catch {
      // Unavailable is not proof of an account change. Keep the saved choice,
      // but neither display active consent nor authorize collection on this read.
      return revision === this.revision ? report(false) : undefined;
    }
    if (revision !== this.revision) return undefined;
    if (!this.validEpoch(current)) return report(false);
    if (current !== epoch) {
      await this.revoke().catch(() => undefined);
      return this.revision === revision + 1 ? report(false) : undefined;
    }
    // Publish inside the revision guard: returning a boolean and publishing after
    // another await would let a queued revoke be overwritten by this older read.
    return report(true);
  }

  async grantFor(sessionId: string): Promise<VoiceScreenshotGrant | undefined> {
    if (!this.enabled || !this.epoch || !sessionId) return undefined;
    const revision = this.revision;
    const epoch = this.epoch;
    if (await this.refresh() !== true || revision !== this.revision) return undefined;
    return { sessionId, consentEpoch: epoch, signal: this.usage.signal,
      isCurrent: () => this.enabled && this.epoch === epoch && this.revision === revision,
    };
  }
}
