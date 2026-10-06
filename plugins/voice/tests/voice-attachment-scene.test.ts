import { expect, test } from "bun:test";
import { attachmentFormatsForVoiceCommand, pendingVoiceRequestHasFileAttachments, requireVoiceTaskAttachmentScene, voiceSceneAllowsAttachments } from "../src/voice-attachment-scene";
import { VOICE_AGENT_FEATURES } from "../src/agent-features";

test("the four declared Agent scenes have a command-only attachment whitelist", () => {
  expect(VOICE_AGENT_FEATURES.map(feature => feature.id)).toEqual(["command", "translation", "polish", "summary"]);
  for (const feature of VOICE_AGENT_FEATURES) expect(voiceSceneAllowsAttachments(feature.id)).toBe(feature.id === "command");
  expect(voiceSceneAllowsAttachments(undefined)).toBeFalse();
});
test("non-task command routes short-circuit before any model capability lookup", () => {
  for (const command of ["voice.command.translate", "voice.command.transcribe", "polish", "summary", undefined]) {
    expect(attachmentFormatsForVoiceCommand(command, () => { throw new Error("cache failure must not block plain translation"); })).toEqual([]);
    expect(() => requireVoiceTaskAttachmentScene(command)).toThrow("VOICE_ATTACHMENT_SCENE_UNSUPPORTED");
  }
  expect(attachmentFormatsForVoiceCommand("voice.command.agent", () => ["text"])).toEqual(["text"]);
});
test("recovery detects canonical file payload even if historical cards were lost", () => {
  expect(pendingVoiceRequestHasFileAttachments('question\n{"attachments":[{"name":"synthetic.txt","mimeType":"text/plain","content":"SYNTHETIC_MARKER"}]}')).toBeTrue();
  expect(pendingVoiceRequestHasFileAttachments('question\n{"attachments":[]}')).toBeFalse();
  expect(pendingVoiceRequestHasFileAttachments("translate this plain text")).toBeFalse();
  expect(pendingVoiceRequestHasFileAttachments("<script>throw 'must not execute'</script>")).toBeFalse();
});
