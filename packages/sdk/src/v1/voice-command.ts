/** `voice.command@1` —— 官方 Voice 插件调用已配置 Workflow 的专用窄口。 */
export interface VoiceCommandStatus { configured: boolean; loggedIn: boolean }
export interface VoiceCommandResult {
  runId: string;
  status: "completed";
  reply: string;
  durationMs: number;
}
export interface VoiceCommandClient {
  getStatus(options?: { signal?: AbortSignal }): Promise<VoiceCommandStatus>;
  /** 提交新的 Workflow URL 或清空配置；Host 不会返回已保存 URL。 */
  configure(workflowUrl: string | null): Promise<VoiceCommandStatus>;
  /**
   * 跑一次语音命令。
   *
   * `commandId` 是**命令类型**（转文本 / 翻译 / Agent 提问）。它由按键绑定携带的
   * 静态入参决定，插件只负责透传——「哪颗键跑哪种命令」是键位设置的事，
   * 插件既不声明也不读取那层映射。
   */
  run(
    input: { text: string; commandId?: string },
    options?: { signal?: AbortSignal },
  ): Promise<VoiceCommandResult>;
  /**
   * 上报一条角落任务的最新状态。Host 负责显示在哪、什么时候撤下。
   *
   * 阶段文案与步数由插件按**声明的映射**算好——Host 不认识业务词汇，也不会
   * 按耗时替你猜进度。
   */
  presentTask(snapshot: VoiceTaskSnapshot): Promise<void>;
  /**
   * 撤下一条任务。
   *
   * ⚠️ **完成不是撤下的理由**：跑完的结果要一直留到用户真的看过。
   * 唯一该调它的时机是用户打开了会话或明确收起。
   */
  dismissTask(taskId: string): Promise<void>;
  /** 弹出计划面板，停在那里等一个**真实的确认动作**。 */
  presentPlan(input: { runId: string; plan: unknown }): Promise<void>;
  /** 弹出答案面板。 */
  presentAnswer(input: {
    runId: string;
    title: string;
    text: string;
    originalText: string;
    /** 统一结果状态；缺省兼容旧插件，Host 按 succeeded 呈现。 */
    status?: "succeeded" | "failed";
    /**
     * Host API 1.22（同版本并入）：`status: "failed"` 时的结构化错误码，面板失败区显示并随
     * 「复制诊断」复制；规则同 `delivery.presentTakeback` 的 `errorCode`（不合规以 `BRIDGE_BAD_PARAMS` 拒绝）。
     * 面板上的插件版本与 App 版本由 Host 按 appId 注入，插件无需也无法自报。旧 Host 忽略本字段。
     */
    errorCode?: string;
    /**
     * Host API 1.22（同版本并入）：诊断用的原始原因（≤ 500 字）。Host 视为不可信的自由文本：
     * 原文不进面板、不进复制诊断，面板失败区只显示字数。旧 Host 忽略本字段。
     */
    detail?: string;
    /** 按设计稿逐段呈现的 label/text 正文；缺省时由 Host 从旧 text 字段回退。 */
    sections?: { label: string; text: string }[];
    /** 写回只是结果的交付副作用，不再决定结果用什么载体。 */
    delivery?: { state: "committed" | "rejected"; message: string };
    /** 失败或空结果可显式撤掉 Copy；缺省保持旧插件可复制。 */
    canCopy?: boolean;
    /** 历史未落盘时没有可靠的会话落点；缺省保持旧插件可继续。 */
    canContinue?: boolean;
    citations?: { id: string; title: string; url?: string }[];
    /** 命令类型徽章（面板头部短标签，Host 只透传不造词）；缺省时面板不渲染徽章。 */
    badge?: string;
    /**
     * Host API 1.22：迟到结果框——已转入后台胶囊的任务完成后再弹的只读结果。
     * 被动显示（不抢键盘，用户点击后才成为键盘焦点）；Voice 正在录音 / 识别时按先后
     * 排队，面板被占着时也排队；**不收中央浮层**。用户关闭（或点「继续」）即算看过：
     * Host 按 `runId` 撤掉同一会话的后台胶囊行、Tab 层待办与通知未读，因此 `runId`
     * 必须是该后台任务的 `taskId`，且应先上报终态帧再调用。旧 Host 忽略本字段，按即时
     * 结果面板呈现。
     */
    deferred?: boolean;
  }): Promise<void>;
}

/** 角落任务卡的一帧状态。字段与 Host 侧一一对应，改名会让界面静默显示空白。 */
export interface VoiceTaskSnapshot {
  taskId: string;
  title: string;
  state: "running" | "succeeded" | "failed";
  stageLabel: string;
  planSteps: string[];
  stepIndex: number;
  startedAt: number;
  unread: boolean;
  /**
   * 运行中的任务正在等用户拍板（启用插件 / 越界确认）。Host 据此在胶囊显示等待态，
   * 主窗口不在眼前时发一次系统提醒；终态帧忽略本字段。旧 Host 忽略、缺席即不在等。
   */
  waiting?: boolean;
}
