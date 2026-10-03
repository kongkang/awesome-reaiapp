import { applyPushEnvelope, type TodoPushEnvelope, type TodoState } from "./todo-model";

export type TodoStateReducer = (state: TodoState) => TodoState;
export type TodoStateListener = (state: TodoState) => void;

export class TodoStateCoordinator {
  private confirmed: TodoState;
  private tail: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<TodoStateListener>();

  constructor(
    initialState: TodoState,
    private readonly persist: (state: TodoState) => Promise<void>,
  ) {
    this.confirmed = initialState;
  }

  get current(): TodoState { return this.confirmed; }

  subscribe(listener: TodoStateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  update(reducer: TodoStateReducer): Promise<TodoState> {
    let resolveResult!: (state: TodoState) => void;
    let rejectResult!: (cause: unknown) => void;
    const result = new Promise<TodoState>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    this.tail = this.tail.then(async () => {
      try {
        const next = reducer(this.confirmed);
        if (next === this.confirmed) {
          resolveResult(this.confirmed);
          return;
        }
        await this.persist(next);
        this.confirmed = next;
        for (const listener of this.listeners) {
          try {
            listener(next);
          } catch (cause) {
            console.error("[todo] state listener failed", cause);
          }
        }
        resolveResult(next);
      } catch (cause) {
        rejectResult(cause);
      }
    });
    return result;
  }

  applyPush(envelope: TodoPushEnvelope, now = new Date()): Promise<TodoState> {
    return this.update((state) => applyPushEnvelope(state, envelope, now));
  }

  async whenIdle(): Promise<void> {
    await this.tail;
  }
}
