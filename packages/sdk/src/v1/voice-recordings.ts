/** `voice.recordings@1` —— 官方 Voice 插件的持久录音窄口。 */

export interface VoiceRecordingSegment {
  id: string;
  wallStartMs: number;
  durationMs: number;
  transport: string;
  transcriptText?: string | null;
  transcribedAtMs?: number | null;
  /**
   * 段级转写状态。`pending` 的段可能还没有文本——它们照常进列表（积压 / 失败
   * 的条目需要「重新转写」入口），界面按「待转写」画而不是当作不存在。
   * 旧 Host 没有这个字段。
   */
  transcriptStatus?: "pending" | "complete" | "disabled" | null;
  /**
   * 句级时间戳（R12）：每句相对 `wallStartMs` 的起止毫秒；墙钟 = `wallStartMs + startMs`。
   * 跨段边界的分片起点可能为负——那是真实时间，照常折算。旧数据没有句级信息时
   * 为 null / 缺省，界面按整段 `transcriptText` 降级，不内插编造。
   */
  sentences?: VoiceRecordingSentence[] | null;
  /** 由 agent 给出的这一段总结（R11）。没生成过为 null / 缺省。 */
  summary?: VoiceRecordingSummary | null;
}

export interface VoiceRecordingSentence {
  text: string;
  startMs: number;
  endMs: number;
}

export interface VoiceRecordingSummary {
  /** 要点清单（Host 已卡 ≤ 8 条、每条 ≤ 200 字）。 */
  points: string[];
  /** 生成时刻（墙钟毫秒）。 */
  generatedAtMs: number;
  /** 生成它的 Dsh 会话；「重新总结」复用它。回退到云端一次性生成时为 null。 */
  dshSessionId: string | null;
}

export interface VoiceRecordingSummaryInput {
  points: string[];
  /** 缺省由 Host 取当前时刻。 */
  generatedAtMs?: number;
  dshSessionId?: string | null;
  /** 总结所依据的转写版本；Host 只在段仍是这个版本时写入，null 表示旧段尚无时间戳。 */
  basedOnTranscribedAtMs?: number | null;
}

export interface VoiceRecordingPage {
  items: VoiceRecordingSegment[];
  total: number;
  page: number;
  perPage: number;
}

export interface VoiceRecordingPlaybackGrant {
  pickupToken: string;
  mimeType: "audio/wav";
  sizeBytes: number;
}

export type VoiceInputStopReason =
  | "finished"
  | "user_cancel"
  | "capture_limit"
  | "source_unavailable";

export type VoiceInputTranscriptionStatus =
  | "not_requested"
  | "pending"
  | "complete"
  | "failed";

/** Host API 1.19: selection frozen for this attempt. Names are display snapshots only. */
export interface SavedInputSelection {
  /** Frozen with the recording; retries retain the original free-only billing intent. */
  billingPolicy?: "free-only";
  engine: "local" | "cloud";
  modelId: string;
  modelName?: string | null;
  language: string;
  punctEnabled: boolean;
}

export interface SavedInputRequest {
  recordingId: string;
  /** A UUID, reused only when retrying delivery of the identical request. */
  attemptId: string;
  expectedRevision: number;
  selection: SavedInputSelection;
}

export interface SavedInputReceipt {
  recordingId: string;
  attemptId: string;
  revision: number;
  state: "pending" | "complete" | "failed" | "cancelled" | "no_speech";
  selection: SavedInputSelection;
  transcript?: string | null;
  errorCode?: string | null;
  startedAtMs: number;
  finishedAtMs?: number | null;
}

/** 已保存、尚可重新转写的一次 Voice Input 录音。 */
export interface RecoverableVoiceInputSession {
  recordingId: string;
  sessionId: string;
  /**
   * 可恢复列表只返回 `input`。Host API 1.22 起语音命令（翻译 / Agent）的录音
   * 也落盘，按 id 调 `getInputSession` 时可能取到 `command`。
   */
  mode: "input" | "command";
  source: string;
  /** Capture-time recognition intent, independent of success. Absent for legacy recordings. */
  requestedEngine?: "local" | "cloud" | null;
  requestedStartMs: number;
  requestedEndMs: number;
  effectiveStartMs: number;
  effectiveEndMs: number;
  stopReason: VoiceInputStopReason;
  transcriptionStatus: VoiceInputTranscriptionStatus;
  transcript?: string | null;
  /** Host API 1.19. Missing on an older Host. */
  revision?: number;
  attempt?: SavedInputReceipt | null;
}

export interface RecoverableVoiceInputSessionPage {
  items: RecoverableVoiceInputSession[];
  total: number;
  page: number;
  perPage: number;
}

/** 本地语音记录保留时长：全天有效记录与按键语音回听共用。 */
export type VoiceReplayRetention = "4h" | "24h" | "7d" | "30d";

/**
 * 「录音缓存」现状。
 *
 * `retainedSinceMs` 是**还留着**的最早那段回听片段的起始墙钟（一段都没有时为 null）。
 * 无论过期清理还是空间不够的淘汰，都从最旧的开始，所以「比它更早的都已经没了」
 * 恒成立——详情页据此判断某一条历史的录音还在不在，不需要逐条去问 Host。
 */
export interface VoiceReplayCacheStatus {
  retention: VoiceReplayRetention;
  clipCount: number;
  usedBytes: number;
  retainedSinceMs: number | null;
}

export interface VoiceRecordingsClient {
  list(options?: { page?: number; perPage?: number }): Promise<VoiceRecordingPage>;
  authorizePlayback(recordingId: string): Promise<VoiceRecordingPlaybackGrant>;
  delete(recordingId: string): Promise<boolean>;
  /**
   * 写入 / 覆盖一段的 agent 总结，Host 持久化进录音索引。返回更新后的段；
   * 返回 `null` = 这段已经不在了，或总结期间又补进了新转写；调用方刷新后静默收尾。
   */
  setSummary(
    recordingId: string,
    summary: VoiceRecordingSummaryInput,
  ): Promise<VoiceRecordingSegment | null>;
  /** 读「录音缓存」占用；Host 会先按当前保留时长清一遍过期片段再报数。 */
  replayCacheStatus(): Promise<VoiceReplayCacheStatus>;
  /** 改保留时长。最短 4 小时；改小会当场清掉超出范围的本地语音记录。 */
  setReplayRetention(retention: VoiceReplayRetention): Promise<VoiceReplayCacheStatus>;
  /** 立刻清空录音缓存：只删声音，转写文本一条不动。 */
  clearReplayCache(): Promise<VoiceReplayCacheStatus>;
  /** 列出按 Esc/中断保存、但尚未成功转写的 Input 录音；语音命令的录音不在其中。 */
  listRecoverableInputSessions(options?: {
    page?: number;
    perPage?: number;
    /** Also recover committed retry receipts after plugin KV write failure; never rerun ASR. */
    includeSettledRetries?: boolean;
  }): Promise<RecoverableVoiceInputSessionPage>;
  /** Host API 1.19; null means the owned recording no longer exists. */
  getInputSession(recordingId: string): Promise<RecoverableVoiceInputSession | null>;
  /** ASR of the saved effective PCM. Does not capture audio or inject text. */
  transcribeSavedInput(input: SavedInputRequest): Promise<SavedInputReceipt>;
  /** Logical cancellation; upstream processing/billing may continue. */
  cancelSavedInput(input: { recordingId: string; attemptId: string }): Promise<{
    receipt: SavedInputReceipt | null;
    upstreamStopped: false;
  }>;
  /** 用 Host 本地模型重新转写，只更新历史，不写回旧焦点。 */
  transcribeInputSession(recordingId: string): Promise<{ transcript: string }>;
  /** 云端转写链路回写 Host 会话状态；不改变最初的停止原因。 */
  setInputSessionTranscription(
    recordingId: string,
    status: "complete" | "failed",
    transcript?: string,
  ): Promise<void>;
  /**
   * 把这段常驻时间线录音的转写范围重新入队，交 Host 本地引擎后台重跑
   * （缺陷3：转写缺失 / 失败 / 积压中的历史条目手动补转写）。只改索引状态、
   * 不同步等识别结果；返回重新入队的转写范围条数。段不存在会以
   * `VOICE_RECORDING_NOT_FOUND` 拒绝。
   */
  retranscribeSegment(recordingId: string): Promise<{ requeued: number }>;
}
