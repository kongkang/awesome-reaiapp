import type { KeyValueStore, SavedInputSelection } from "@reai/app-sdk/v1";

const KEY = "input-selection-snapshots-v1";
type Entry = { sessionId: string; selection: SavedInputSelection };

/** Recording-start metadata, never reconstructed from today's catalog. */
export class InputSelectionJournal {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private store: KeyValueStore) {}

  async read(sessionId: string): Promise<SavedInputSelection | undefined> {
    await this.queue;
    const entries = await this.store.get<Entry[]>(KEY);
    const selection = Array.isArray(entries) ? entries.find(e => e.sessionId === sessionId)?.selection : undefined;
    return selection ? structuredClone(selection) : undefined;
  }

  /**
   * 一次读出整份 journal：恢复扫描每轮只读一次，不按会话逐条过 Bridge 读取整个 KV 值。
   * 晚于快照写入的记录由下一轮扫描补上。
   */
  async snapshot(): Promise<Map<string, SavedInputSelection>> {
    await this.queue;
    const entries = await this.store.get<Entry[]>(KEY);
    const selections = new Map<string, SavedInputSelection>();
    for (const entry of Array.isArray(entries) ? entries : []) {
      if (!selections.has(entry.sessionId)) selections.set(entry.sessionId, structuredClone(entry.selection));
    }
    return selections;
  }

  remember(sessionId: string, selection: SavedInputSelection): Promise<void> {
    const snapshot = structuredClone(selection);
    const write = async () => {
      const saved = await this.store.get<Entry[]>(KEY);
      const entries = Array.isArray(saved) ? saved : [];
      if (entries.some(e => e.sessionId === sessionId)) return;
      await this.store.set(KEY, [{ sessionId, selection: snapshot }, ...entries].slice(0, 256));
    };
    const result = this.queue.then(write, write);
    this.queue = result.catch(() => undefined);
    return result;
  }
}
