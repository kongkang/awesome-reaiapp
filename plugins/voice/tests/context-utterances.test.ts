import { describe, expect, test } from "bun:test";
import type { VoiceRecordingSegment, VoiceRecordingSentence } from "@reai/app-sdk/v1";
import * as display from "../src/context-display";
import * as speech from "../src/voice-utterance";

const base = new Date(2026, 8, 11, 12).getTime();
const item = (sentences: VoiceRecordingSentence[], overrides: Partial<VoiceRecordingSegment> = {}): VoiceRecordingSegment => ({
  id: "r", wallStartMs: base, durationMs: 300000, transport: "usb", transcriptStatus: "complete",
  transcriptText: sentences.map(s => s.text).join("\n"), sentences, ...overrides,
});
const sentence = (text: string, startMs: number, endMs = startMs + 500) => ({ text, startMs, endMs });
const project = (source: VoiceRecordingSegment) => display.projectContextUtterances(source);

describe("现场发言显示投影", () => {
  test("连续句片合并一条，保持所有原始片段、时间和原文", () => {
    const source = item([sentence("我们先", 0, 600), sentence("把发布节奏", 650, 1100), sentence("定下来。", 1200, 1900)]);
    const before = JSON.stringify(source);
    Object.freeze(source); source.sentences!.forEach(Object.freeze); Object.freeze(source.sentences);
    const blocks = project(source);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ text: "我们先把发布节奏定下来。", startMs: base, endMs: base + 1900, filler: false, indices: [0, 1, 2] });
    expect(blocks[0]!.sentences).toEqual(source.sentences!);
    expect(JSON.stringify(source)).toBe(before);
  });
  test("1500毫秒停顿包含边界；1501分开，英文数字保留词间空格", () => {
    expect(project(item([sentence("hello", 0), sentence("world", 2000)]))[0]!.text).toBe("hello world");
    expect(project(item([sentence("1", 0), sentence("2", 2000)]))[0]!.text).toBe("1 2");
    expect(project(item([sentence("first", 0), sentence("next", 2001)]))).toHaveLength(2);
    expect(project(item([sentence("旧", 0), sentence("记录", 500)], { transcriptStatus: null }))).toHaveLength(1);
  });
  test("倒序、重叠、非法时间、跨日不合并；负偏移保留", () => {
    for (const next of [100, -100, NaN]) expect(project(item([sentence("第一", 0), sentence("第二", next)]))).toHaveLength(2);
    const midnight = new Date(2026, 8, 12).getTime();
    expect(project(item([sentence("第一", 0), sentence("第二", 500)], { wallStartMs: midnight - 500 }))).toHaveLength(2);
    expect(project(item([sentence("过去", -1000), sentence("现在", -500)]))[0]!.startMs).toBe(base - 1000);
    expect(project(item([sentence("无效", NaN)]))[0]!.startMs).toBeUndefined();
  });
  test("重复填充词折叠；短确认保留；混合内容只压缩连续多片填充", () => {
    for (const text of ["嗯", "嗯嗯", "嗯哼", "mhm", "mm", "ok", "好", "对"]) expect(project(item([sentence(text, 0)]))[0]!.filler).toBeFalse();
    expect(project(item([sentence("嗯", 0), sentence("嗯", 500), sentence("呃", 1000)]))[0]!.filler).toBeTrue();
    expect(project(item([sentence("我们先", 0), sentence("嗯", 500), sentence("定下来", 1000)]))[0]!.text).toBe("我们先嗯定下来");
    const mixed = project(item([sentence("我们先", 0), sentence("嗯", 500), sentence("呃", 1000), sentence("定下来", 1500)]))[0]!;
    expect(mixed.text).toBe("我们先嗯…定下来");
    expect(mixed.sentences.map(s => s.text)).toEqual(["我们先", "嗯", "呃", "定下来"]);
  });
  test("SDK pending/disabled不整理，不把未完成标点认作空内容", () => {
    for (const transcriptStatus of ["pending", "disabled"] as const) {
      const source = item([sentence("嗯", 0), sentence("呃", 500)], { transcriptStatus });
      expect(project(source)).toHaveLength(2); expect(project(source).some(b => b.filler)).toBeFalse();
      expect(display.isEmptyContextRecording(item([sentence("。", 0)], { transcriptStatus }))).toBeFalse();
    }
  });
});

test("翻译过滤保守确认和实义短字，仅跳过空白标点及纯填充", () => {
  for (const text of ["嗯。", " 嗯嗯！ ", "嗯哼", "mhm", "MM", "ok", "好", "对", "不", "I", "0", "mum", "ohm", "嗯，明天开会"]) expect(speech.shouldTranslateUtterance(text), text).toBeTrue();
  for (const text of ["", " \n\t", "。。。?!", "\u200b", "嗯嗯嗯", "嗯…嗯…", "嗯，嗯", "嗯\n嗯", "呃…嗯…呃…", "uh um"]) expect(speech.shouldTranslateUtterance(text), text).toBeFalse();
});


test("英文标点及填充省略号边界保留可读空格，中文片段直接衔接", () => {
  for (const [fragments, expected] of [
    [["We ship today.", "Then test."], "We ship today. Then test."],
    [["OK,", "let's go"], "OK, let's go"],
    [["um", "uh", "Hello"], "um… Hello"],
    [["Hello!", '\"Next\"'], 'Hello! \"Next\"'],
    [["好。", "OK"], "好。OK"],
    [["我们先", "把发布节奏"], "我们先把发布节奏"],
  ] as const) expect(display.contextUtteranceText(fragments)).toBe(expected);
});

test("长发言保留全部2000条原片，遇到外部重叠不误合并", () => {
  const source = item(Array.from({ length: 2000 }, (_, index) => sentence("测试", index * 100, index * 100 + 90)));
  const blocks = project(source);
  expect(blocks).toHaveLength(1);
  expect(blocks[0]!.indices).toEqual(Array.from({ length: 2000 }, (_, index) => index));
  expect(blocks[0]!.sentences).toEqual(source.sentences!);
  expect(blocks[0]!.text).toBe("测试".repeat(2000));
  expect(project(item([sentence("第一", 0), sentence("第二", 500), sentence("第三", 1000), sentence("重叠", 250, 750)])).map(block => block.indices)).toEqual([[0], [1], [2], [3]]);
});
