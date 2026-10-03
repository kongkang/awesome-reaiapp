/** UI language is independent of speech recognition and translation targets. */
export type UiLocale = "zh" | "en";

export interface LocaleSnapshot {
  readonly locale: UiLocale;
  /** Monotonic within one Host process; compare only within the current session. */
  readonly revision: number;
}

/** Read-only Host environment. Translation resources belong to each plugin. */
export interface LocaleClient {
  getSnapshot(): LocaleSnapshot;
  /** Immediately replays the current snapshot. Returns an unsubscribe function. */
  onChange(handler: (snapshot: LocaleSnapshot) => void): () => void;
}

export function parseLocaleSnapshot(value: unknown): LocaleSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if ((candidate.locale !== "zh" && candidate.locale !== "en")
    || !Number.isSafeInteger(candidate.revision) || (candidate.revision as number) < 0) return null;
  return Object.freeze({ locale: candidate.locale, revision: candidate.revision as number });
}

/** Internal session/revision merge shared by activation and live environment events. */
export function createLocaleEnvironment() {
  let session = "";
  let snapshot: LocaleSnapshot = Object.freeze({ locale: "zh", revision: 0 });
  const pending = new Map<string, LocaleSnapshot>();
  const handlers = new Set<(snapshot: LocaleSnapshot) => void>();
  const deliver = (handler: (snapshot: LocaleSnapshot) => void) => {
    try { handler(snapshot); } catch (error) { console.error("[app-sdk] locale subscriber failed", error); }
  };
  const apply = (next: LocaleSnapshot) => {
    if (next.revision <= snapshot.revision) return;
    snapshot = next;
    for (const handler of [...handlers]) deliver(handler);
  };
  const client: LocaleClient = Object.freeze({
    getSnapshot: () => snapshot,
    onChange(handler: (snapshot: LocaleSnapshot) => void) {
      handlers.add(handler);
      deliver(handler);
      return () => { handlers.delete(handler); };
    },
  });
  return {
    client,
    begin(runtimeSessionId: string, initial: LocaleSnapshot | null) {
      handlers.clear();
      session = runtimeSessionId;
      snapshot = initial ?? Object.freeze({ locale: "zh", revision: 0 });
      const buffered = pending.get(session);
      if (buffered) apply(buffered);
      pending.clear();
    },
    receive(runtimeSessionId: string, value: unknown) {
      const next = parseLocaleSnapshot(value);
      if (!next || !runtimeSessionId) return;
      if (session) {
        if (runtimeSessionId === session) apply(next);
        return;
      }
      const previous = pending.get(runtimeSessionId);
      if (previous && previous.revision >= next.revision) return;
      if (!previous && pending.size >= 8) pending.delete(pending.keys().next().value!);
      pending.set(runtimeSessionId, next);
    },
    dispose() { handlers.clear(); pending.clear(); session = ""; },
  };
}
