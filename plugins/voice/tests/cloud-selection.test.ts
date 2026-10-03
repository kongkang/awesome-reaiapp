import { expect, test } from "bun:test";
import { assertFreeOnlyCloudExecution, preferredCloudOption, trustedFreeDefault, selectedCloudOption, validCloudOptionId } from "../src/cloud-selection";
import { sanitizeVoiceFeatureSettings } from "../src/data";

test("cloud option IDs match Host boundaries without normalizing saved choices", () => {
  for (const id of ["", "transcribe-default", "transcribe-", "transcribe--free", "transcribe-Free", "transcribe-free\n", "transcribe-free\r\n", " transcribe-free ", `transcribe-${"a".repeat(54)}`]) {
    expect(validCloudOptionId(id)).toBeFalse();
    expect(sanitizeVoiceFeatureSettings({ cloudModelId: id }).cloudModelId).toBe(id);
  }
  expect(validCloudOptionId("transcribe-free")).toBeTrue();
  expect(validCloudOptionId(`transcribe-${"a".repeat(53)}`)).toBeTrue();
  expect(selectedCloudOption([{ id: "transcribe-paid", kind: "transcribe", label: "Paid" }], "transcribe-free")).toBeUndefined();
});

test("free default trust requires explicit metadata and enabled legal transcription ID", () => {
  const candidate = { id: "transcribe-free", kind: "transcribe" as const, label: "Free", isDefault: true, billingPolicy: "free" as const };
  expect(trustedFreeDefault(candidate)).toBeTrue();
  for (const model of [
    { ...candidate, isDefault: false }, { ...candidate, billingPolicy: "metered" },
    { ...candidate, billingPolicy: undefined }, { ...candidate, enabled: false },
    { ...candidate, id: "transcribe-default" }, { ...candidate, kind: "chat" },
  ]) expect(trustedFreeDefault(model as never)).toBeFalse();
  expect(preferredCloudOption([{ id: "transcribe-paid", kind: "transcribe", label: "Free default" }], "")).toBeUndefined();
  expect(preferredCloudOption([candidate, { id: "transcribe-paid", kind: "transcribe", label: "Paid" }], "transcribe-paid")?.id).toBe("transcribe-paid");
});

test("free-only guard rejects an old SDK even when Host supplies free metadata", async () => {
  let reads = 0;
  const client = { listModels: async () => { reads++; return [{ id: "transcribe-free", kind: "transcribe" as const, label: "Free", billingPolicy: "free" as const }]; } };
  await expect(assertFreeOnlyCloudExecution(client, "transcribe-free", "free-only")).rejects.toThrow("HOST_API_INCOMPATIBLE");
  expect(reads).toBe(0);
});

test("free-only guard always reads fresh billing and never requires an existing free choice to remain default", async () => {
  let reads = 0;
  let billingPolicy: "free" | "metered" = "free";
  const client = { freeOnlyTranscriptionSupported: true as const, listModels: async () => {
    reads++; return [{ id: "transcribe-free", kind: "transcribe" as const, label: "Free", isDefault: false, billingPolicy }];
  } };
  await assertFreeOnlyCloudExecution(client, "transcribe-free", "free-only");
  billingPolicy = "metered";
  await expect(assertFreeOnlyCloudExecution(client, "transcribe-free", "free-only")).rejects.toThrow("CLOUD_MODEL_SELECTION_REQUIRED");
  expect(reads).toBe(2);
  await assertFreeOnlyCloudExecution(client, "transcribe-paid"); expect(reads).toBe(2);
});
