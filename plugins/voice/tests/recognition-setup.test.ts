import { expect, test } from "bun:test";
import { chooseRecognitionEngine, RecognitionSetupRollbackError, type RecognitionSetupPorts } from "../src/recognition-setup";
import { DEFAULT_SETTINGS, DEFAULT_VOICE_FEATURE_SETTINGS, VoiceStateRepository } from "../src/data";
import type { KeyValueStore } from "@reai/app-sdk/v1";

function harness(fail?: string) {
  const calls: string[] = [];
  const storage = new Map<string, unknown>();
  const repository = new VoiceStateRepository({
    get: async (key: string) => storage.get(key),
    set: async (key: string, value: unknown) => { storage.set(key, value); },
  } as KeyValueStore);
  let failed = false;
  const op = (name: string) => { calls.push(name); if (name === fail && !failed) { failed = true; throw Error(name); } };
  const ports: RecognitionSetupPorts = {
    configure: async settings => op(`configure:${settings.engine}`),
    startDownload: async id => op(`download:${id}`),
    saveSettings: async settings => { op(`save:${settings.engine}`); await repository.saveSettings(settings); },
    saveFeatures: async features => { op(`features:${features.cloudModelId}`); await repository.saveFeatureSettings(features); },
    confirm: async engine => { op(`confirm:${engine}`); await repository.confirmRecognitionEngine(engine); },
  };
  return { calls, ports, repository };
}

test("pending setup survives restart and incidental settings writes; existing preferences are preserved", async () => {
  const h = harness();
  expect((await h.repository.load()).recognitionSetupPending).toBeTrue();
  await h.repository.saveSettings(DEFAULT_SETTINGS);
  expect((await h.repository.load()).recognitionSetupPending).toBeTrue();
  await h.repository.confirmRecognitionEngine("local");
  expect((await h.repository.load()).recognitionSetupPending).toBeFalse();
  const existing = harness();
  await existing.repository.saveSettings(DEFAULT_SETTINGS);
  expect((await existing.repository.load()).recognitionSetupPending).toBeFalse();
});

test("local selection starts a Host background download and survives repository reload", async () => {
  const h = harness();
  await chooseRecognitionEngine("local", DEFAULT_SETTINGS, DEFAULT_VOICE_FEATURE_SETTINGS, [], h.ports);
  expect(h.calls[0]).toBe("download:sensevoice-small-int8");
  expect((await h.repository.load()).recognitionEngineChoice).toBe("local");
  expect((await h.repository.load()).settings?.engine).toBe("local");
});

test("cloud selection persists an available model and never downloads or transcribes", async () => {
  const h = harness();
  await chooseRecognitionEngine("cloud", DEFAULT_SETTINGS, DEFAULT_VOICE_FEATURE_SETTINGS,
    [{ id: "transcribe-available", kind: "transcribe", label: "Available model", isDefault: true, billingPolicy: "free" as const }], h.ports);
  const restored = await h.repository.load();
  expect(restored.settings?.engine).toBe("cloud");
  expect(restored.featureSettings.cloudModelId).toBe("transcribe-available");
  expect(restored.recognitionEngineChoice).toBe("cloud");
  expect(h.calls.some(call => call.startsWith("download:"))).toBeFalse();
});

test("missing cloud configuration cannot be reported as successful setup", async () => {
  const h = harness();
  await expect(chooseRecognitionEngine("cloud", DEFAULT_SETTINGS, DEFAULT_VOICE_FEATURE_SETTINGS, [], h.ports))
    .rejects.toThrow("VOICE_SETUP_CLOUD_UNAVAILABLE");
  expect(h.calls).toEqual([]);
});

test.each(["transcribe-removed", " transcribe-available "])("explicit saved option %s must not silently fall back to another tier", async cloudModelId => {
  const h = harness();
  await expect(chooseRecognitionEngine("cloud", DEFAULT_SETTINGS, { ...DEFAULT_VOICE_FEATURE_SETTINGS, cloudModelId },
    [{ id: "transcribe-available", kind: "transcribe", label: "Paid tier" }], h.ports))
    .rejects.toThrow();
  expect(h.calls).toEqual([]);
});

test("failed rollback preserves the original error and attempts all remaining restores", async () => {
  const calls: string[] = [];
  let configureCalls = 0;
  const ports: RecognitionSetupPorts = {
    configure: async () => { if (++configureCalls > 1) throw Error("restore-host"); },
    startDownload: async () => {},
    saveSettings: async settings => { calls.push(settings.engine); throw Error(settings.engine === "cloud" ? "original-save" : "restore-settings"); },
    saveFeatures: async () => { calls.push("restore-features"); },
    confirm: async () => { throw Error("must not confirm"); },
  };
  try {
    await chooseRecognitionEngine("cloud", DEFAULT_SETTINGS, DEFAULT_VOICE_FEATURE_SETTINGS,
      [{ id: "transcribe-available", kind: "transcribe", label: "Available", isDefault: true, billingPolicy: "free" as const }], ports);
    throw Error("expected setup failure");
  } catch (cause) {
    expect(cause).toBeInstanceOf(RecognitionSetupRollbackError);
    const failure = cause as RecognitionSetupRollbackError;
    expect((failure.original as Error).message).toBe("original-save");
    expect(failure.rollbackErrors.map(error => (error as Error).message)).toEqual(["restore-host", "restore-settings"]);
    expect(calls).toEqual(["cloud", "local", "restore-features"]);
  }
});

for (const step of ["configure:cloud", "save:cloud", "features:transcribe-available", "confirm:cloud"]) {
  test(`setup failure at ${step} restores settings and does not confirm completion`, async () => {
    const h = harness(step);
    await expect(chooseRecognitionEngine("cloud", DEFAULT_SETTINGS, DEFAULT_VOICE_FEATURE_SETTINGS,
      [{ id: "transcribe-available", kind: "transcribe", label: "Available", isDefault: true, billingPolicy: "free" as const }], h.ports)).rejects.toThrow(step);
    const restored = await h.repository.load();
    expect(restored.recognitionEngineChoice).toBeUndefined();
    expect(restored.settings?.engine).toBe("local");
    expect(restored.featureSettings).toEqual(DEFAULT_VOICE_FEATURE_SETTINGS);
  });
}


test("fresh setup never replaces a previously concrete missing cloud choice", async () => {
  const h = harness();
  await expect(chooseRecognitionEngine("cloud", DEFAULT_SETTINGS,
    { ...DEFAULT_VOICE_FEATURE_SETTINGS, cloudModelId: "transcribe-removed" },
    [{ id: "transcribe-paid", kind: "transcribe", label: "Paid" }], h.ports))
    .rejects.toThrow("VOICE_SETUP_CLOUD_UNAVAILABLE");
  expect(h.calls).toEqual([]);
});

for (const cloudModelId of ["", "transcribe-default", "bad", "transcribe-removed"]) {
  test(`trusted free default replaces ${cloudModelId || "empty"} without selecting first paid`, async () => {
    const h = harness();
    const models = [
      { id: "transcribe-paid", kind: "transcribe" as const, label: "Free misleading label" },
      { id: "transcribe-free", kind: "transcribe" as const, label: "Default", isDefault: true, billingPolicy: "free" as const },
    ];
    const result = await chooseRecognitionEngine("cloud", DEFAULT_SETTINGS,
      { ...DEFAULT_VOICE_FEATURE_SETTINGS, cloudModelId }, models, h.ports);
    expect(result.featureSettings.cloudModelId).toBe("transcribe-free");
  });
}

for (const billingPolicy of ["free", "metered"] as const) {
  test(`current-account default ${billingPolicy} is a normal billed choice rather than a permanent free-only intent`, async () => {
    const h = harness();
    const model = { id: "transcribe-account", kind: "transcribe" as const, label: "Current default", isDefault: true,
      pricingContext: "current-account" as const, billingPolicy };
    const result = await chooseRecognitionEngine("cloud", DEFAULT_SETTINGS, DEFAULT_VOICE_FEATURE_SETTINGS, [model], h.ports);
    expect(result.featureSettings.cloudModelId).toBe("transcribe-account");
    expect(result.featureSettings.cloudModelBillingPolicy).toBeUndefined();
  });
}
