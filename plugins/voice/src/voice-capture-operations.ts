/** Generic operation ownership; no device, gesture, or key state belongs here. */
export class VoiceCaptureOperations {
  private readonly entries = new Map<string, { sessionId?: string; dispose(): void }>();

  async invoke<T extends { phase: string; sessionId?: string }>(
    operation: { id: string; phase: "start" | "end" },
    signal: AbortSignal,
    ports: {
      current(): string | undefined;
      start(): Promise<T>;
      finish(sessionId: string): Promise<unknown> | undefined;
      cancel(sessionId: string): Promise<unknown>;
      failed(error: unknown): void;
    },
  ): Promise<T | { phase: string }> {
    if (operation.phase === "end") {
      const entry = this.entries.get(operation.id);
      this.entries.delete(operation.id);
      entry?.dispose();
      if (!entry?.sessionId || ports.current() !== entry.sessionId) return { phase: "idle" };
      const finishing = ports.finish(entry.sessionId);
      if (finishing) void finishing.catch(ports.failed);
      return { phase: finishing ? "recognizing" : "idle" };
    }
    if (signal.aborted || this.entries.has(operation.id) || ports.current()) return { phase: "idle" };
    const entry: { sessionId?: string; dispose(): void } = { dispose: () => signal.removeEventListener("abort", cancel) };
    const cancel = () => {
      this.entries.delete(operation.id);
      entry.dispose();
      if (entry.sessionId) void ports.cancel(entry.sessionId).catch(ports.failed);
    };
    signal.addEventListener("abort", cancel, { once: true });
    this.entries.set(operation.id, entry);
    try {
      const result = await ports.start();
      if (result.phase === "listening" && result.sessionId) {
        entry.sessionId = result.sessionId;
        if (signal.aborted || this.entries.get(operation.id) !== entry) {
          await ports.cancel(result.sessionId);
          return { phase: "idle" };
        }
      } else {
        this.entries.delete(operation.id);
        entry.dispose();
      }
      return result;
    } catch (error) {
      this.entries.delete(operation.id);
      entry.dispose();
      throw error;
    }
  }
}
