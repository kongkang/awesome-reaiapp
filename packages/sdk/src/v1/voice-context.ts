/**
 * `voice.context@1` —— 润色上下文的宿主采集窄口。
 *
 * ## 这条口子只报事实
 *
 * Host 采不到的、不该采的，一律**如实说明原因**，不静默返回空。原因是插件要拿它
 * 做两件事：决定这次要不要带上下文，以及在设置页告诉用户「为什么这一档现在是灰的」。
 * 把「没权限」和「这次没要」压成同一个空值，第二件事就永远做不对。
 *
 * ## 你拿不到的东西
 *
 * 窗口标题、文件路径与应用名字。截图只有调用方显式传
 * `includeWindowScreenshot: true`、屏幕录制已授权且窗口未命中排除护栏时才返回，
 * 并已由 Host 缩放、压缩和限长。编辑器类应用还必须先读到通过凭据护栏的焦点文字；
 * 没有辅助功能权限、焦点控件没有文字或文字疑似凭据时，截图同样 fail-closed 不返回。
 *
 * ## 屏幕录制权限只读不申请
 *
 * `screenRecording` 是**只读**状态。Host 这条通道没有 request 对应物：截图源要按
 * 权限「路由」，而不是趁用户说话时弹一个他没预期的授权窗。
 */

/**
 * 前台应用的粗分类。只用于语气与格式提示，不含任何身份信息。
 *
 * `terminal` 单列一档不是为了给模型多一个提示，而是因为终端里的窗口文字
 * **一律不采**——那整屏文本上面很可能就有刚 export 的 token 或连接串。
 */
export type VoiceContextAppCategory =
  | "editor"
  | "chat"
  | "email"
  | "browser"
  | "terminal"
  | "other";

/**
 * 窗口文字这一项的真实结果。
 *
 * - `captured` —— 真读到了。
 * - `not_requested` —— 插件这次没要（用户关掉了这一档）。Host 也不会去读。
 * - `accessibility_denied` —— 缺辅助功能权限。**Host 没有在这里请求**，只是报告。
 * - `unavailable` —— 有权限，但焦点控件没有可读文本，或当前平台不支持。
 * - `app_excluded` —— 前台应用在不采集名单里（终端、密码管理器）。**有权限也不读**。
 */
export type VoiceContextWindowTextStatus =
  | "captured"
  | "not_requested"
  | "accessibility_denied"
  | "unavailable"
  | "app_excluded";

/**
 * 屏幕录制权限的只读状态。
 *
 * 只有两档：对截图源来说「从没问过」和「拒绝过」的下一步动作完全一样（都不采），
 * 分三档只会多一条走不通的分支。
 */
export type VoiceContextScreenRecordingState = "granted" | "denied";

/** Host 当次采集、当次消费的有界焦点窗口截图。不会落盘。 */
export interface VoiceContextImage {
  mime: "image/jpeg";
  dataBase64: string;
  width: number;
  height: number;
}

export interface VoiceContextCapture {
  /** F01 Host 登录代际派生的不透明值；不是账号身份或登录 secret。 */
  sessionEpoch?: string;
  windowScreenshotStatus?: "captured" | "not_requested" | "consent_required" | "permission_denied" | "context_changed" | "unavailable";
  appCategory?: VoiceContextAppCategory;
  /** 焦点控件里的选中文本或文本值，UTF-8 有界截断。缺席时看 `windowTextStatus`。 */
  windowText?: string;
  windowTextStatus: VoiceContextWindowTextStatus;
  screenRecording: VoiceContextScreenRecordingState;
  /** 显式请求、权限已授予且前台窗口未命中排除护栏时才出现。 */
  windowScreenshot?: VoiceContextImage;
}

export interface VoiceContextClient {
  /**
   * 采一次上下文。
   *
   * `includeWindowText` 默认 **false**：没显式要，Host 一个字都不读。这条默认值
   * 是刻意的——「顺手采了但没用上」和「采了」在隐私上没有区别。
   */
  capture(options?: {
    includeWindowText?: boolean;
    includeWindowScreenshot?: boolean;
    /** 原 Voice session；Host 只取此会话绑定的窗口上下文。 */
    sessionId?: string;
    /** 截图明确同意绑定的原登录代际；缺失/不匹配时 Host 不读取屏幕。 */
    consentEpoch?: string;
  }): Promise<VoiceContextCapture>;
}
