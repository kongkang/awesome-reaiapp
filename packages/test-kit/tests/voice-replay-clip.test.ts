import { describe, expect, test } from "bun:test";
import { RequestMethod } from "@reai/app-sdk/v1";
import { MockHost } from "../src/v1/index";

const manifest = {
  appId: "com.reai.voice",
  requires: { hostCapabilities: ["voice.input@1", "voice.recordings@1"] },
  permissions: [{ id: "voice.input@1", purpose: "语音输入" }],
};

describe("voice.toggle 回听片段 Mock Host（Host API 1.22 三个方向都落盘）", () => {
  test("输入法与语音命令都返回 replayClip，并标 replayClipStatus", async () => {
    const host = new MockHost({ manifest, loadApp: async () => ({ default: {} }) });
    for (const mode of ["input", "command"] as const) {
      await host.bridge.request(RequestMethod.VoiceToggle, { mode });
      const result = (await host.bridge.request(RequestMethod.VoiceToggle, { mode })) as {
        mode: string;
        replayClip?: { id: string; durationMs: number };
        replayClipStatus?: string;
      };
      expect(result.mode).toBe(mode);
      expect(result.replayClip?.id).toMatch(/^mock-replay-/);
      expect(result.replayClipStatus).toBe("saved");
    }
  });

  test("命令录音按 id 可取，但不进可恢复列表（含 includeSettledRetries）", async () => {
    const host = new MockHost({ manifest, loadApp: async () => ({ default: {} }) });
    const session = (recordingId: string, mode: "input" | "command") => ({
      recordingId,
      sessionId: `session-${recordingId}`,
      mode,
      source: "System",
      requestedStartMs: 1,
      requestedEndMs: 2,
      effectiveStartMs: 1,
      effectiveEndMs: 2,
      stopReason: "user_cancel" as const,
      transcriptionStatus: "failed" as const,
    });
    host.setRecoverableVoiceInputSessions([session("r-input", "input"), session("r-command", "command")]);
    for (const includeSettledRetries of [false, true]) {
      const page = (await host.bridge.request(RequestMethod.VoiceRecoverableInputSessionsList, {
        includeSettledRetries,
      })) as { items: { recordingId: string }[]; total: number };
      expect(page.total).toBe(1);
      expect(page.items.map((item) => item.recordingId)).toEqual(["r-input"]);
    }
    const command = (await host.bridge.request(RequestMethod.VoiceInputSessionGet, {
      recordingId: "r-command",
    })) as { mode: string } | null;
    expect(command?.mode).toBe("command");
  });
});
