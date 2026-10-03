/** `tts.local@1` —— 官方本地 TTS 插件的 Host 托管窄口。 */

export type LocalTtsModelId = "audio8-0.1b-int8" | "audio8-0.6b-int4";
export type LocalTtsModelState = "missing" | "downloading" | "ready" | "failed";
export type LocalTtsRecordingPhase = "idle" | "recording";
export type LocalTtsTaskPhase = "idle" | "registering" | "synthesizing";

export interface LocalTtsHardwareInfo {
  platform: string;
  architecture: string;
  memoryBytes: number;
  logicalCpuCount: number;
  supported: boolean;
}

export interface LocalTtsRecommendation {
  modelId: LocalTtsModelId;
  reason: string;
}

export interface LocalTtsModelInfo {
  id: LocalTtsModelId;
  name: string;
  description: string;
  sizeBytes: number;
  state: LocalTtsModelState;
  downloadedBytes?: number;
  licenseUrl: string;
  baseModelLicenseUrl: string;
  error?: string;
}

export interface LocalTtsVoiceInfo {
  id: string;
  name: string;
  modelId: LocalTtsModelId;
  createdAt: string;
}

export interface LocalTtsStatus {
  runtimeAvailable: boolean;
  hardware: LocalTtsHardwareInfo;
  recommendation: LocalTtsRecommendation;
  models: LocalTtsModelInfo[];
  voices: LocalTtsVoiceInfo[];
  recording: {
    phase: LocalTtsRecordingPhase;
    sampleId?: string;
    durationMs?: number;
    level?: number;
    lastError?: { code: string; userMessage: string };
  };
  task: { phase: LocalTtsTaskPhase };
  microphonePermission: "granted" | "denied" | "not_determined" | "unavailable";
  defaultVoice?: LocalTtsDefaultVoice;
}

export interface LocalTtsDefaultVoice {
  modelId: LocalTtsModelId;
  voiceId: string;
}

export interface LocalTtsRecognitionResult {
  sampleId: string;
  recognizedText: string;
  expectedText: string;
  matched: boolean;
  cer: number;
  errorCode?: "TTS_RECOGNITION_MISMATCH";
}

export interface LocalTtsPlaybackGrant {
  pickupToken: string;
  mimeType: "audio/wav";
  sizeBytes: number;
}

export interface LocalTtsSynthesisResult extends LocalTtsPlaybackGrant {
  durationMs: number;
}

export interface LocalTtsClient {
  getStatus(): Promise<LocalTtsStatus>;
  requestMicrophonePermission(): Promise<LocalTtsStatus["microphonePermission"]>;
  startRecording(): Promise<{ sampleId: string }>;
  stopRecording(): Promise<{ sampleId: string; durationMs: number; quality: { peak: number; rms: number; activeFrameRatio: number } }>;
  cancelRecording(): Promise<void>;
  authorizeSamplePlayback(sampleId: string): Promise<LocalTtsPlaybackGrant>;
  prepareRecognition(): Promise<unknown>;
  confirmRecognition(sampleId: string, transcript: string): Promise<LocalTtsRecognitionResult>;
  downloadModel(modelId: LocalTtsModelId): Promise<LocalTtsModelInfo>;
  cancelModelDownload(modelId: LocalTtsModelId): Promise<void>;
  deleteModel(modelId: LocalTtsModelId): Promise<void>;
  registerVoice(input: {
    modelId: LocalTtsModelId;
    sampleId: string;
    name: string;
    transcript: string;
  }): Promise<LocalTtsVoiceInfo>;
  deleteVoice(modelId: LocalTtsModelId, voiceId: string): Promise<void>;
  getDefaultVoice(): Promise<LocalTtsDefaultVoice | undefined>;
  setDefaultVoice(input: LocalTtsDefaultVoice): Promise<LocalTtsDefaultVoice>;
  synthesize(input: {
    modelId: LocalTtsModelId;
    voiceId: string;
    text: string;
  }): Promise<LocalTtsSynthesisResult>;
  cancel(): Promise<void>;
}
