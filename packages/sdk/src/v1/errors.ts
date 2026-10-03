/**
 * App 侧错误类型。
 *
 * 为什么不用裸 `Error`：Host 要把失败展示给用户、写日志、决定要不要重试，这三件事
 * 需要三种不同的信息。裸 `Error` 只有一个 `message`，于是要么给用户看堆栈，要么写
 * 日志时把关键上下文丢了。
 */

/** 跨 Bridge 传输的错误形态。Host 与 App 两侧都按它读写。 */
export interface WireError {
  /** App 自定的稳定错误码，形如 `com.example.todo/STORAGE_READ_FAILED`。 */
  code: string;
  /** 给用户看的一句话。不含堆栈、不含路径。 */
  userMessage: string;
  /** 同样操作重试是否有意义。Host 据此决定要不要给「重试」按钮。 */
  retryable: boolean;
  /** 给开发者看的诊断串（原始错误的文本形式）。不会展示给用户。 */
  diagnostic?: string;
}

export interface AppErrorInit {
  code: string;
  userMessage: string;
  retryable?: boolean;
  cause?: unknown;
}

/** App 抛给 Host 的结构化错误。 */
export class AppError extends Error {
  readonly code: string;
  readonly userMessage: string;
  readonly retryable: boolean;

  constructor(init: AppErrorInit) {
    super(`${init.code}: ${init.userMessage}`, { cause: init.cause });
    this.name = "AppError";
    this.code = init.code;
    this.userMessage = init.userMessage;
    this.retryable = init.retryable ?? false;
  }

  toWire(): WireError {
    const diagnostic = describeCause(this.cause);
    return {
      code: this.code,
      userMessage: this.userMessage,
      retryable: this.retryable,
      ...(diagnostic === undefined ? {} : { diagnostic }),
    };
  }
}

/**
 * 把任意抛出物归一成 [`WireError`]。
 *
 * App 代码里 `throw "字符串"`、`throw {code: 1}` 都是可能的。Host 收到形态不一的东西
 * 会比收到一个笼统但结构正确的错误更糟——前者会让 Host 的错误处理路径自己再崩一次。
 */
export function toWireError(thrown: unknown): WireError {
  // 按**形状**判断而不是 `instanceof`：如果某个 App 因为配置失误自己打包了一份 SDK，
  // 它抛出的 AppError 与 Host 这份不是同一个类，`instanceof` 会失败，
  // 于是一个写得很清楚的错误会退化成「未处理的错误」。
  if (isAppErrorShape(thrown)) {
    const diagnostic = describeCause((thrown as { cause?: unknown }).cause);
    return {
      code: thrown.code,
      userMessage: thrown.userMessage,
      retryable: thrown.retryable === true,
      ...(diagnostic === undefined ? {} : { diagnostic }),
    };
  }

  const diagnostic = describeCause(thrown);
  return {
    code: "app/UNHANDLED",
    userMessage: "扩展遇到未处理的错误",
    retryable: false,
    ...(diagnostic === undefined ? {} : { diagnostic }),
  };
}

interface AppErrorShape {
  code: string;
  userMessage: string;
  retryable?: unknown;
}

function isAppErrorShape(value: unknown): value is AppErrorShape {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate["code"] === "string" && typeof candidate["userMessage"] === "string";
}

function describeCause(cause: unknown): string | undefined {
  if (cause === undefined || cause === null) return undefined;
  if (cause instanceof Error) return `${cause.name}: ${cause.message}`;
  if (typeof cause === "string") return cause;
  try {
    return JSON.stringify(cause);
  } catch {
    return String(cause);
  }
}
