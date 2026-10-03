/** Host 所有的平台任务。插件只能读归一化状态与提交白名单意图。 */

export type SystemTaskTarget =
  | "firmware-upgrade"
  | "software-update"
  | "permission-settings"
  /** 设备 › 键位映射子页（导航型 target）。 */
  | "keymap"
  /** 账户页登录行（导航型 target）。 */
  | "account-login"
  /** 设置页语音命令卡（导航型 target）。 */
  | "voice-command-settings"
  /** Host 设置页音频时间线卡。 */
  | "audio-timeline-settings"
  /** 来源插件自己的已安装详情权限区；appId 由 Host 会话注入。 */
  | "app-permissions"
  /** 来源插件自己的已安装详情运行组件区；appId 由 Host 会话注入。 */
  | "app-managed-resources"
  /**
   * 设置 › 插件 Agent 配置（锁定到来源插件）。target 已进合同；Host 落点接线
   * 前 `open` 会以 `SYSTEM_TASK_NAVIGATION_BLOCKED` 诚实失败。
   */
  | "agent-config";

export type SystemTaskConfigSource = "remote" | "last-known-good" | "unavailable";

export interface SystemTaskVersionStatus {
  firmware: {
    currentVersion?: string | null;
    latestVersion?: string | null;
    updateAvailable: boolean;
    connected: boolean;
    connectionType?: "usb" | "ble" | null;
  };
  app: {
    currentVersion: string;
    latestVersion?: string | null;
    updateAvailable: boolean;
    installable: boolean;
    blockedReason?:
      | "development-build"
      | "product-line-mismatch"
      | "unsupported-platform"
      | null;
  };
  checkedAt?: string | null;
  source: SystemTaskConfigSource;
}

export interface SystemTaskOpenOptions {
  target: SystemTaskTarget;
  returnIntent?: unknown;
}

export interface SystemTaskOpenResult {
  taskId: string;
  accepted: true;
}

export interface SystemTaskClient {
  getVersionStatus(options?: { refresh?: boolean }): Promise<SystemTaskVersionStatus>;
  open(options: SystemTaskOpenOptions): Promise<SystemTaskOpenResult>;
}

export interface SystemTaskReturnIntent {
  type: "system-task.return";
  taskId: string;
  target: SystemTaskTarget;
  outcome: "succeeded" | "failed" | "cancelled";
  payload?: unknown;
}

export function isSystemTaskReturnIntent(value: unknown): value is SystemTaskReturnIntent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const intent = value as Record<string, unknown>;
  return (
    intent["type"] === "system-task.return" &&
    typeof intent["taskId"] === "string" &&
    [
      "firmware-upgrade",
      "software-update",
      "permission-settings",
      "keymap",
      "account-login",
      "voice-command-settings",
      "audio-timeline-settings",
      "app-permissions",
      "app-managed-resources",
      "agent-config",
    ].includes(
      String(intent["target"]),
    ) &&
    ["succeeded", "failed", "cancelled"].includes(String(intent["outcome"]))
  );
}
