# Voice real-media player fixture

Uses the production `mountVoiceView` and native browser `Audio` with a local WAV. Host data/actions are fixture inputs; this proves browser playback/seek behavior, not Host authorization, cloud ASR, physical audio output or a signed App. Media is muted and no microphone is accessed. Deliberately mismatched 12:48 history metadata must be replaced by the WAV's actual 3.4-second duration.

Sample: `Lab41-SRI-VOiCES-src-sp0307-ch127535-sg0042.wav`, VOiCES by Lab41 and SRI International; source speech derived from LibriSpeech. [Dataset authors' README and CC BY 4.0 grant](https://iqtlabs.github.io/voices/Lab41-SRI-VOiCES_README/), [license](https://creativecommons.org/licenses/by/4.0/), [PyTorch official tutorial identifying this sample](https://docs.pytorch.org/audio/2.6.0/tutorials/audio_io_tutorial.html). No audio edits or conversion were made. Retrieved 2026-09-12.

- Download: <https://download.pytorch.org/torchaudio/tutorial-assets/Lab41-SRI-VOiCES-src-sp0307-ch127535-sg0042.wav>
- SHA-256: `c65fcd726d6b08c82c1e5dc7558f863cd8d483e3ed2f4a7bcf271dc1865ada14`
- Format: WAV PCM signed 16-bit little-endian, mono, 16,000 Hz, 54,400 samples, 3.4 seconds, 108,844 bytes.
- The audio stays under ignored `.artifacts`; download it using the documented URL, verify SHA before use. It is not part of the plugin package.

From the Voice plugin directory:

```sh
bun tests/fixtures/replay/server.ts --audio ../../../.artifacts/a02-player/speech.wav
```

Open the printed loopback URL. Open sample 1; verify true duration, play/pause, click/drag position, arrow/Home/End keys, paused seek, natural end/replay, periodic refresh focus, return/open sample 2, and expiry. The facts beneath the product view read native media state and are test instrumentation only. Capture evidence under `.artifacts/a02-player`.
