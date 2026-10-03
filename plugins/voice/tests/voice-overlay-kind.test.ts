import {expect,test} from "bun:test";
import {BUILTIN_VOICE_COMMANDS} from "../src/voice-ai-contract";
import {commandOverlayKind} from "../src/voice-overlay-kind";
test("命令身份直接决定胶囊类型，不依赖文案或触发来源",()=>{
 expect(commandOverlayKind(BUILTIN_VOICE_COMMANDS.transcribe)).toBe("input");
 expect(commandOverlayKind(BUILTIN_VOICE_COMMANDS.translate)).toBe("translate");
 expect(commandOverlayKind(BUILTIN_VOICE_COMMANDS.agent)).toBe("task");
});
