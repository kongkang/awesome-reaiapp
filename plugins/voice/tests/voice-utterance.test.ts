/**
 * 空话判定（2026-09-29 真机反馈）：Agent / 翻译命令拿到「没说话」「只有标点 / 语气词」「只剩一个字」
 * 的识别结果时不发请求。这里只测纯函数；命令路径（命中时不建会话、不调云端）见
 * voice-empty-utterance-command.test.ts。
 */
import { expect, test } from "bun:test";
import { classifyUtterance } from "../src/voice-utterance";

test.each([
  ["空串", ""],
  ["只有空白", "  \n\t "],
  ["一个中文句号", "。"],
  ["一串句号", "。。。"],
  ["语气词加句号", "嗯。"],
  ["连续语气词", "嗯嗯，啊……"],
  ["英文语气词", "Hmm, uh... um."],
  ["中英混合语气词", "嗯 uh 呃？"],
  ["全角标点与符号", "！？，、；：“”‘’（）《》【】…—～"],
  ["零宽字符", "​‍"],
  // 审查补充（Codex 第 1 轮）：常见语气词变体与组合。
  ["噢噢", "噢噢"],
  ["呃噢", "呃，噢。"],
  ["嗯哼", "嗯哼"],
  ["哎呀", "哎呀……"],
  ["喔唉嘿", "喔、唉、嘿"],
  ["拖长的英文语气词", "Ummm... ehm, hmmm, mhm, errr, ahh, ohh"],
  ["mm 与 mmhmm", "mm, mmm... mmhmm"],
])("无内容：%s", (_label, text) => {
  expect(classifyUtterance(text)).toBe("empty");
});

test.each([
  ["单个字母", "a"],
  ["单个汉字", "好"],
  ["单个数字", "1"],
  ["单字加标点空白", " 好。 "],
  ["全角字母", "Ａ"],
  // 按「看到的一个字」计，不按编码单元：İ 小写后是 i + 组合点，q́ 是 q + 组合重音。
  ["带组合符号的单字母 İ", "İ"],
  ["带组合重音的单字母", "q́"],
  ["分解写法的 é", "é"],
])("只剩一个字：%s", (_label, text) => {
  expect(classifyUtterance(text)).toBe("trivial");
});

test.each([
  ["两个字", "好的"],
  ["英文 ok", "ok"],
  ["正常句子", "帮我把明天上午的会议改到下午三点。"],
  ["英文句子", "What's the weather like today?"],
  // 语气词只在整句全是语气词时才算空：句中出现不删，「额度」不能被当成语气词「额」吃掉。
  ["含语气词字的正常词", "额度"],
  ["语气词开头的句子", "嗯，帮我查一下天气"],
  ["数字", "42"],
  ["语气词后跟实词", "噢，好的"],
  ["像语气词的英文单词", "hummus"],
  ["嗯哼之后有内容", "嗯哼 open mail"],
  // 审查补充（Codex 第 2 轮）：语气词片段拼得出来的正常英文词不能判空。
  ["mum", "Mum."],
  ["ohm", "ohm"],
  ["mummer", "mummer"],
  ["error", "error"],
  ["emmer", "emmer"],
])("有内容：%s", (_label, text) => {
  expect(classifyUtterance(text)).toBe("substantive");
});

test("长串重复输入不卡：判定是线性的（审查实测旧正则 40 个 m 加 x 约 1.3 秒）", () => {
  const inputs = ["m".repeat(40) + "x", "mhm".repeat(200) + "x", "hm".repeat(500) + "q", "嗯".repeat(2000) + "好的"];
  const started = performance.now();
  for (const text of inputs) expect(classifyUtterance(text)).toBe("substantive");
  expect(performance.now() - started).toBeLessThan(50);
});
