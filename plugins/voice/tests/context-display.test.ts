import { describe, expect, test } from "bun:test";
import type { VoiceRecordingSegment } from "@reai/app-sdk/v1";
import { contextCharacterCount, contextTime, isEmptyContextText, isEmptyContextRecording, projectContextSentences } from "../src/context-display";
const base = new Date(2026, 8, 11, 12).getTime();
const item = (sentences: VoiceRecordingSegment["sentences"], overrides: Partial<VoiceRecordingSegment> = {}): VoiceRecordingSegment => ({id:"r",wallStartMs:base,durationMs:300000,transport:"usb",transcriptText:".\n。",sentences,...overrides});
describe("Context display-only projection", () => {
  test("narrow punctuation whitelist preserves brief speech and ambiguous symbols", () => {
    for (const text of ["", " \t\n", ".", "，。 、；:：…"]) expect(isEmptyContextText(text)).toBeTrue();
    for (const text of ["好。", "嗯", "OK.", "I", "0", "123", "3.14", "?", "！", "-", "—", "()", "©", "🙂", "...a", "\u200b"]) expect(isEmptyContextText(text)).toBeFalse();
    expect(contextCharacterCount("下午三点开会。 \n")).toBe(6);
    expect(contextCharacterCount("A 12，𠀀!\n")).toBe(4);
    expect(contextCharacterCount(" .？！\n")).toBe(0);
  });
  test("touching empty sentences fold without changing any original data", () => {
    const source=item([{text:" . ",startMs:1,endMs:1001},{text:"。",startMs:1001,endMs:2001},{text:"好",startMs:2001,endMs:3001}]);
    const before=JSON.stringify(source);
    Object.freeze(source); source.sentences!.forEach(Object.freeze); Object.freeze(source.sentences);
    const blocks=projectContextSentences(source);
    expect(blocks.map(b=>b.indices)).toEqual([[0,1],[2]]);
    expect(blocks[0]!.startMs).toBe(base+1);expect(blocks[0]!.endMs).toBe(base+2001);
    expect(blocks[0]!.sentences[0]!.text).toBe(" . ");expect(JSON.stringify(source)).toBe(before);
  });
  test("gaps, overlap, backwards order and cross-day boundaries never join", () => {
    for(const [a,b] of [[1000,1001],[1000,999],[2000,1000]]) {
      expect(projectContextSentences(item([{text:".",startMs:0,endMs:a},{text:".",startMs:b,endMs:b+1000}]))).toHaveLength(2);
    }
    const midnight=new Date(2026,8,12).getTime();
    expect(projectContextSentences(item([{text:".",startMs:0,endMs:1000},{text:".",startMs:1000,endMs:2000}],{wallStartMs:midnight-1000}))).toHaveLength(2);
  });
  test("meaningful or invalid overlapping sentence prevents merging", () => {
    const source=item([{text:".",startMs:0,endMs:1000},{text:".",startMs:1000,endMs:2000},{text:"保留",startMs:500,endMs:1500}]);
    expect(projectContextSentences(source)).toHaveLength(3);
    source.sentences![2]!.startMs=NaN;expect(projectContextSentences(source)).toHaveLength(3);
  });
  test("invalid timestamps never acquire ranges; negatives may be real", () => {
    for(const value of [NaN,Infinity,0.5,Number.MAX_SAFE_INTEGER]) {
      const b=projectContextSentences(item([{text:".",startMs:0,endMs:1000}],{wallStartMs:value}))[0]!;
      expect(b.startMs).toBeUndefined();
    }
    expect(projectContextSentences(item([{text:".",startMs:-1000,endMs:0}]))[0]!.startMs).toBe(base-1000);
    expect(contextTime(base+123,true)).toEndWith(".123");expect(contextTime(base+123)).toBe("12:00:00");
  });
  test("unfinished and ambiguous records are never categorized empty", () => {
    for(const transcriptionStatus of ["pending","failed","not_requested"]) {
      const source={...item([{text:".",startMs:0,endMs:1000}]),transcriptionStatus};
      expect(isEmptyContextRecording(source)).toBeFalse();expect(projectContextSentences(source)[0]!.empty).toBeFalse();
    }
    expect(isEmptyContextRecording(item([{text:"有效",startMs:0,endMs:1}]))).toBeFalse();
    expect(isEmptyContextRecording(item(null,{transcriptText:null}))).toBeFalse();
  });
});
