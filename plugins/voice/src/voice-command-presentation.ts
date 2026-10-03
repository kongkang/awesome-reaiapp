/**
 * Agent 实际开始后等待 3 秒，再转入 Host 全局任务。
 * 听写和翻译不启动该计时器：等待写入或取回窗口确认。
 */
export const FOREGROUND_COMMAND_WAIT_MS = 3_000;

export type CommandPresentationDisposition = "foreground" | "background";

interface CommandPresentationGateOptions {
  autoStart?: boolean;
  schedule(callback: () => void, delayMs: number): ReturnType<typeof setTimeout> | number;
  cancel(timer: ReturnType<typeof setTimeout> | number): void;
  onBackgrounded(): Promise<void> | void;
}

/**
 * 只负责一次命令运行的前台/后台归属，不猜业务阶段和结果。
 *
 * `complete()` 与 3 秒定时器可能同一拍竞争：一旦后台回调开始执行，这次运行就永久
 * 属于后台；终局不得再弹短结果面板。反之，前台先完成就取消定时器。
 */
export function createCommandPresentationGate(options: CommandPresentationGateOptions): {
  start(): void;
  complete(): Promise<CommandPresentationDisposition>;
  dispose(): Promise<void>;
} {
  let backgrounded = false;
  let completed = false;
  let backgroundPromise: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | number | undefined;
  const start = () => {
    if (completed || timer !== undefined) return;
    timer = options.schedule(() => {
      if (completed) return;
      backgrounded = true;
      backgroundPromise = Promise.resolve(options.onBackgrounded());
    }, FOREGROUND_COMMAND_WAIT_MS);
  };
  if (options.autoStart !== false) start();

  return {
    start,
    async complete() {
      completed = true;
      if (!backgrounded) {
        if (timer !== undefined) options.cancel(timer);
        return "foreground";
      }
      await backgroundPromise;
      return "background";
    },
    async dispose() {
      completed = true;
      if (timer !== undefined) options.cancel(timer);
      // 定时器已经入场时，单纯 clearTimeout 阻止不了正在执行的后台呈现。
      await backgroundPromise;
    },
  };
}
