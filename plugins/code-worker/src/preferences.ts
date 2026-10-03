import { DEFAULT_LIMITS, validateLimits, type Limits } from "./domain";

export interface Preferences { version: 1; limits: Limits }
export function readPreferences(value: unknown): Preferences {
  if (value === undefined || value === null) return { version: 1, limits: { ...DEFAULT_LIMITS } };
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid preference record");
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || Object.keys(record).some(key => !["version", "limits"].includes(key))) throw new Error("Unsupported preference schema");
  validateLimits(record.limits);
  return { version: 1, limits: { ...record.limits } };
}

/** Writes are serialized and local state advances only after Host persistence succeeds. */
export function preferenceWriter(write: (record: Preferences) => Promise<void>) {
  let pending = Promise.resolve();
  return (limits: Limits) => {
    const record = readPreferences({ version: 1, limits });
    const job = pending.then(() => write(record));
    pending = job.catch(() => undefined);
    return job;
  };
}
