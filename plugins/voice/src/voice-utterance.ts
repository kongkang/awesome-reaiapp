/**
 * 识别结果有没有「真内容」（2026-09-29 真机反馈）：Agent 命令拿到没说话、只有标点或语气词、
 * 或只剩一个字的结果时，不值得为它建会话、调模型。纯函数，不碰任何状态。
 *
 * 规则：
 * - 去掉空白、全部中英文标点与符号（含零宽等不可见字符）后什么都不剩 → `empty`。
 * - 剩下的每一段都是常见语气词（嗯、啊、呃、哦、噢、额、唔、诶、哎、哼、hmm、uh、um、em…）→ `empty`。
 *   语气词只在**整句全是语气词**时才算空：句中出现不删——「额度」里的「额」不是语气词。
 * - 只剩 1 个字（按看到的字计：一个汉字、字母或数字，连同它的组合符号）→ `trivial`；其余 → `substantive`。
 *
 * 转文本（输入法）不用这里的 `trivial`：一个字照写，只有完全为空才不写（调用方自己判断）。
 *
 * 全程线性扫描，不用带嵌套重复的正则，长串重复输入也不会卡住插件线程。
 */
export type UtteranceContent = "empty" | "trivial" | "substantive";

/** 分段用：标点、符号、分隔符、控制与格式字符（零宽空格等）、空白。 */
const SEPARATORS = /[\p{P}\p{S}\p{Z}\p{C}\s]+/u;

/** 单字语气词。 */
const CJK_FILLERS = new Set(Array.from("嗯啊呃哦噢喔额唔诶欸呣哎唉哼嘿呀"));

/**
 * 英文语气词，按「连续相同字母折叠成一个」之后的写法：hmmm → hm，ummm → um，errr → er，ahh → ah。
 * 同一段里可以连写（如 uhm、mhm、ummhmm）。
 * 不收裸 `m`：它能和别的片段拼出正常单词（mum = m + um，ohm = oh + m）；`er` 同理（emmer = em + er）。
 * 这两个只在单独成段时认（mm、mmm、err）。
 */
const LATIN_FILLERS = ["hm", "uh", "uhm", "um", "em", "eh", "ehm", "ah", "oh", "mhm"];
const STANDALONE_LATIN_FILLERS = new Set(["m", "er"]);

/** 连续相同的字折叠成一个（「嗯嗯嗯」→「嗯」，「hmmm」→「hm」）。 */
function collapseRuns(chars: readonly string[]): string[] {
  const out: string[] = [];
  for (const char of chars) if (out[out.length - 1] !== char) out.push(char);
  return out;
}

/** 这一段能否完整切成若干语气词。动态规划，O(段长 × 词表长)。 */
function isFillerSegment(segment: string): boolean {
  const chars = collapseRuns(Array.from(segment));
  if (STANDALONE_LATIN_FILLERS.has(chars.join(""))) return true;
  const reachable = new Array<boolean>(chars.length + 1).fill(false);
  reachable[0] = true;
  for (let index = 0; index < chars.length; index += 1) {
    if (!reachable[index]) continue;
    if (CJK_FILLERS.has(chars[index]!)) reachable[index + 1] = true;
    for (const word of LATIN_FILLERS) {
      const end = index + word.length;
      if (end > chars.length || reachable[end]) continue;
      let matches = true;
      for (let offset = 0; offset < word.length; offset += 1) {
        if (chars[index + offset] !== word[offset]) { matches = false; break; }
      }
      if (matches) reachable[end] = true;
    }
  }
  return reachable[chars.length]!;
}

type GraphemeSegmenter = { segment(input: string): Iterable<unknown> };
const graphemes: GraphemeSegmenter | undefined = (() => {
  const Segmenter = (Intl as unknown as { Segmenter?: new (locale?: string, options?: { granularity: "grapheme" }) => GraphemeSegmenter }).Segmenter;
  return Segmenter ? new Segmenter(undefined, { granularity: "grapheme" }) : undefined;
})();

/** 数「看到的字」，至多数到 2（只需要分出 0 / 1 / 更多）。 */
function visibleCharsUpTo2(text: string): number {
  let count = 0;
  for (const _ of graphemes ? graphemes.segment(text) : Array.from(text)) if (++count >= 2) break;
  return count;
}

export function classifyUtterance(text: string): UtteranceContent {
  const segments = text.normalize("NFKC").toLowerCase().split(SEPARATORS).filter(Boolean);
  if (segments.length === 0 || segments.every(isFillerSegment)) return "empty";
  return visibleCharsUpTo2(segments.join("")) <= 1 ? "trivial" : "substantive";
}

/** Conservative short acknowledgements; internal punctuation/newlines are significant. */
export function isConfirmationUtterance(text: string): boolean {
  const normalized = text.normalize("NFKC").toLowerCase().replace(/^[\p{P}\p{Z}\s]+|[\p{P}\p{Z}\s]+$/gu, "");
  return ["嗯", "嗯嗯", "嗯哼", "mhm", "mm"].includes(normalized);
}

/** Includes repeated acknowledgements, before applying the conservative exception. */
export function isPureFillerUtterance(text: string): boolean {
  const segments = text.normalize("NFKC").toLowerCase().split(SEPARATORS).filter(Boolean);
  return segments.length > 0 && segments.every(isFillerSegment);
}

/** Translation accepts useful single characters and short confirmations, unlike Agent. */
export function shouldTranslateUtterance(text: string): boolean {
  return isConfirmationUtterance(text) || classifyUtterance(text) !== "empty";
}
