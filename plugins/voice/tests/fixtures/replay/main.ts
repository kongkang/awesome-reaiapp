import { mountVoiceView, type VoiceViewActions } from "../../../src/voice-view";
import { createDefaultVoiceViewState } from "../../../src/data";

// Browser-only fixture. Real media decoding/playback; no Host, cloud or microphone calls.
const NativeAudio = window.Audio;
const media: HTMLAudioElement[] = [];
window.Audio = function (src?: string) {
  const audio = new NativeAudio(src);
  audio.muted = true;
  media.push(audio);
  const report = () => {
    document.querySelector("#media-facts")!.textContent = JSON.stringify(media.map((item) => ({
      duration: Number.isFinite(item.duration) ? item.duration : null,
      currentTime: item.currentTime,
      paused: item.paused,
      readyState: item.readyState,
      error: item.error?.code ?? null,
    })));
  };
  for (const event of ["loadedmetadata", "timeupdate", "seeked", "play", "pause", "ended", "error"]) {
    audio.addEventListener(event, report);
  }
  return audio;
} as unknown as typeof Audio;

const start = Date.now() - 60_000;
const state = createDefaultVoiceViewState({
  history: [1, 2].map((id) => ({
    id: `sample-${id}`, transcript: `公开语音样本 ${id} · 播放器验证`, language: "en-US",
    source: "system", inserted: false, durationMs: 768_000,
    createdAt: new Date(start).toISOString(), recordingId: `sample-${id}`,
    recordingWallStartMs: start, recordingDurationMs: 768_000,
  })),
  replayCache: { retention: "24h", clipCount: 2, usedBytes: 217600, retainedSinceMs: start },
});
const actions = new Proxy({
  onLoadReplayAudio: async () => {
    const response = await fetch("/speech.wav");
    if (!response.ok) throw new Error("Fixture audio unavailable");
    return await response.blob();
  },
}, { get: (target, name) => Reflect.get(target, name) ?? (() => undefined) }) as unknown as VoiceViewActions;
const view = mountVoiceView(document.querySelector("#app")!, state, actions);
document.querySelector("#back")!.addEventListener("click", () => view.navigateRoot());
document.querySelector("#refresh")!.addEventListener("click", () => view.update({ ...state }));
document.querySelector("#expire")!.addEventListener("click", () => view.update({
  ...state, replayCache: { ...state.replayCache!, retainedSinceMs: start + 1 },
}));
// Exercise periodic Host-style renders while the user holds focus/uses the range.
let refreshing = false;
document.querySelector("#poll")!.addEventListener("click", () => { refreshing = !refreshing; });
setInterval(() => { if (refreshing) view.update({ ...state }); }, 1000);
window.addEventListener("beforeunload", () => view.dispose());
