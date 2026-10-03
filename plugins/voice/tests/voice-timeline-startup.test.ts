import { expect, test } from "bun:test";
import { createDefaultVoiceViewState, shouldPollVoiceStatus, voiceSourceStatusPatch, voiceAvailabilityChanged } from "../src/data";
import type { AudioTimelineStatus } from "@reai/app-sdk/v1";

const timeline: AudioTimelineStatus = {
  state: "unavailable", unavailableReason: "route_reconciling", route: null,
  hotRingDurationMs: 0, cacheDurationMs: 0, cacheHealth: "healthy",
  continuousRecordingEnabled: true, recordingState: "running", sttBacklog: 0,
  hostLocalDropFrames: 0,
};

test("Board readiness cannot stop reconciliation of a timeline that is still starting", () => {
  const view = createDefaultVoiceViewState({ sourceReady: true, timeline });
  // This is the actual Host contract: device readiness and timeline lease readiness
  // are independent facts. The next Host read can already report running.
  expect(shouldPollVoiceStatus(view)).toBeTrue();
  const recovered = { ...view, ...voiceSourceStatusPatch({
    phase: "idle", source: "board", modelId: "sensevoice-small-int8", sourceReady: true,
    timeline: { ...timeline, state: "running", route: "usb_vendor_hid", unavailableReason: undefined },
  }) };
  expect(recovered.timeline?.state).toBe("running");
});

test("timeline control changes refresh the view, growing audio buffers do not rebuild editors", () => {
  const current = createDefaultVoiceViewState({ sourceReady: true, timeline });
  const status = { phase: "idle" as const, source: "board" as const, modelId: "sensevoice-small-int8", sourceReady: true, timeline };
  expect(voiceAvailabilityChanged(current, status)).toBeFalse();
  expect(voiceAvailabilityChanged(current, { ...status, timeline: { ...timeline, hotRingDurationMs: 1000 } })).toBeFalse();
  expect(voiceAvailabilityChanged(current, { ...status, timeline: { ...timeline, state: "running" } })).toBeTrue();
});
