/**
 * 纯数据工具：文件类型识别与逐行比较。
 *
 * 不依赖 DOM、不依赖编辑器引擎，视图层（ui.ts）与状态层（main.ts）共用；
 * 单测直接测这里，保证「N 处变更」徽标口径稳定。
 */

/** 文件的语言标签：出现在列表 meta、头部路径行与状态栏的 <strong> 里。 */
export function fileLanguage(path: string): string {
  if (/\.(md|mdx|markdown)$/i.test(path)) return "Markdown";
  if (/\.jsonc?$/i.test(path)) return "JSON";
  if (/\.tsx$/i.test(path)) return "TSX";
  if (/\.ts$/i.test(path)) return "TypeScript";
  if (/\.jsx$/i.test(path)) return "JSX";
  if (/\.[cm]?js$/i.test(path)) return "JavaScript";
  if (/\.html?$/i.test(path)) return "HTML";
  if (/\.css$/i.test(path)) return "CSS";
  if (/\.ya?ml$/i.test(path)) return "YAML";
  if (/\.(sh|zsh|bash)$/i.test(path)) return "Shell";
  if (/\.toml$/i.test(path)) return "TOML";
  if (/\.rs$/i.test(path)) return "Rust";
  if (/\.py$/i.test(path)) return "Python";
  return "文本";
}

export const isMarkdownPath = (path: string): boolean => /\.(md|mdx|markdown)$/i.test(path);

export type LineDiffOp = { type: "mut" | "add" | "del"; text: string };

/** LCS 的行数上限。真实文本 Broker 上限 256 KB，但防御性再卡一道内存。 */
const MAX_DIFF_LINES = 2500;

/**
 * 逐行比较两份内容，返回按顺序拼接即可还原 next 的操作序列。
 * 超出上限返回 undefined——调用方应回退为「大量改动」而不是硬算 O(n·m)。
 */
export function diffLineOps(base: string, next: string): LineDiffOp[] | undefined {
  const a = base.split("\n");
  const b = next.split("\n");
  if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES) return undefined;
  // 全表 LCS：Int32Array 一张，避免二维数组开销。
  const width = b.length + 1;
  const table = new Int32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    const aLine = a[i]!;
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i * width + j] =
        aLine === b[j]
          ? table[(i + 1) * width + j + 1]! + 1
          : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
    }
  }
  const ops: LineDiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ type: "mut", text: b[j]! });
      i += 1;
      j += 1;
    } else if (table[(i + 1) * width + j]! >= table[i * width + j + 1]!) {
      ops.push({ type: "del", text: a[i]! });
      i += 1;
    } else {
      ops.push({ type: "add", text: b[j]! });
      j += 1;
    }
  }
  while (i < a.length) {
    ops.push({ type: "del", text: a[i++]! });
  }
  while (j < b.length) {
    ops.push({ type: "add", text: b[j++]! });
  }
  return ops;
}

/** 「N 处变更」的 N：增删行的总数（与设计稿逐行口径一致）。 */
export function countChangedLines(ops: LineDiffOp[] | undefined): number | null {
  if (!ops) return null;
  let count = 0;
  for (const op of ops) if (op.type !== "mut") count += 1;
  return count;
}

/** 变更行在 next（b 侧）里的行号（0 起），供「上一处/下一处」跳转。 */
export function changedLineNumbersOnNext(ops: LineDiffOp[] | undefined): number[] {
  if (!ops) return [];
  const lines: number[] = [];
  let index = 0;
  for (const op of ops) {
    if (op.type === "add") lines.push(index);
    if (op.type !== "del") index += 1;
  }
  return lines;
}

/** 把字节数压成列表 meta 里的人话；超过阈值给 KB。 */
export function humanSize(size: number | undefined): string {
  if (size === undefined) return "";
  if (size < 1024) return `${size} B`;
  return `${(size / 1024).toFixed(size < 1024 * 10 ? 1 : 0)} KB`;
}
