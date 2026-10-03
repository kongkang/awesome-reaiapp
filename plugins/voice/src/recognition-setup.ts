import type { CloudModelOption, VoiceInputSettings } from "@reai/app-sdk/v1";
import { DEFAULT_MODEL_ID, type VoiceFeatureSettings } from "./data";
import { preferredCloudOption, cloudSelectionBillingPolicy } from "./cloud-selection";

export type RecognitionEngine = "local" | "cloud";
export class RecognitionSetupRollbackError extends Error {
  constructor(readonly original: unknown, readonly rollbackErrors: unknown[]) {
    super("VOICE_SETUP_ROLLBACK_FAILED", { cause: original });
  }
}
export interface RecognitionSetupPorts {
  configure(settings: VoiceInputSettings): Promise<unknown>;
  startDownload(modelId: string): Promise<unknown>;
  saveSettings(settings: VoiceInputSettings): Promise<void>;
  saveFeatures(settings: VoiceFeatureSettings): Promise<void>;
  confirm(engine: RecognitionEngine): Promise<void>;
}

/** Only user-selected settings change. Download starts in Host and outlives the view. */
export async function chooseRecognitionEngine(
  engine: RecognitionEngine,
  previous: VoiceInputSettings,
  features: VoiceFeatureSettings,
  cloudModels: readonly CloudModelOption[],
  ports: RecognitionSetupPorts,
) {
  const cloud = preferredCloudOption(cloudModels, features.cloudModelId, features.cloudModelBillingPolicy);
  if (engine === "cloud" && !cloud) throw new Error("VOICE_SETUP_CLOUD_UNAVAILABLE");
  const settings = { ...previous, engine, modelId: DEFAULT_MODEL_ID };
  const nextFeatures = engine === "cloud" ? { ...features, cloudModelId: cloud!.id, cloudModelBillingPolicy: cloudSelectionBillingPolicy(cloud!, features.cloudModelId, features.cloudModelBillingPolicy) } : features;
  if (engine === "local") await ports.startDownload(DEFAULT_MODEL_ID);
  try {
    await ports.configure(settings);
    await ports.saveSettings(settings);
    await ports.saveFeatures(nextFeatures);
    // Last write: failures cannot mark an incomplete choice as finished.
    await ports.confirm(engine);
  } catch (error) {
    const rollbackErrors: unknown[] = [];
    // Attempt every restore even if Host or one storage write is unavailable.
    for (const restore of [() => ports.configure(previous), () => ports.saveSettings(previous), () => ports.saveFeatures(features)]) {
      try { await restore(); } catch (cause) { rollbackErrors.push(cause); }
    }
    if (rollbackErrors.length) throw new RecognitionSetupRollbackError(error, rollbackErrors);
    throw error;
  }
  return { settings, featureSettings: nextFeatures };
}
