/** Prevent duplicate user gestures from starting the same irreversible async action twice. */
export class ExclusiveAction {
  #busy = false;

  get busy(): boolean {
    return this.#busy;
  }

  async run<T>(action: () => Promise<T>): Promise<T | undefined> {
    if (this.#busy) return undefined;
    this.#busy = true;
    try {
      return await action();
    } finally {
      this.#busy = false;
    }
  }
}

export interface DeviceLoginDetails {
  verificationUrl: string;
  userCode: string;
}

export function normalizeDeviceLogin(value: unknown): DeviceLoginDetails | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  return typeof record.verificationUrl === "string" && record.verificationUrl.length > 0 &&
      typeof record.userCode === "string" && record.userCode.length > 0
    ? { verificationUrl: record.verificationUrl, userCode: record.userCode }
    : undefined;
}
