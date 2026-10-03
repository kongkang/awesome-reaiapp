import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const docsPrefix = "docs/";
const changelogPath = `${docsPrefix}CHANGELOG.md`;

function git(args, options = {}) {
  try {
    return execFileSync("git", args, {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      ...options,
    }).trim();
  } catch {
    return "";
  }
}

function eventBaseSha() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath || !existsSync(eventPath)) return undefined;

  try {
    const event = JSON.parse(readFileSync(eventPath, "utf8"));
    const base = event.pull_request?.base?.sha ?? event.before;
    return typeof base === "string" && !/^0+$/.test(base) ? base : undefined;
  } catch {
    return undefined;
  }
}

function resolveBase() {
  const candidates = [
    process.env.CHANGELOG_BASE_REF,
    eventBaseSha(),
    process.env.GITHUB_BASE_REF
      ? `origin/${process.env.GITHUB_BASE_REF}`
      : undefined,
    "origin/main",
    "HEAD^",
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      execFileSync("git", ["cat-file", "-e", `${candidate}^{commit}`], {
        cwd: repoRoot,
        stdio: "ignore",
      });
      return git(["merge-base", candidate, "HEAD"]) || candidate;
    } catch {
      // 浅克隆或首次提交可能没有这个候选，继续尝试下一项。
    }
  }

  return undefined;
}

function lines(output) {
  return output ? output.split("\n").filter(Boolean) : [];
}

function hasAddedNonEmptyLine(diff) {
  return diff
    .split("\n")
    .some((line) => line.startsWith("+") && !line.startsWith("+++") && line.slice(1).trim());
}

function changelogHasNewContent(base) {
  const absolutePath = join(repoRoot, changelogPath);
  if (!existsSync(absolutePath)) return false;
  const currentLines = readFileSync(absolutePath, "utf8").split("\n");
  if (!currentLines.some((line) => line.trim())) return false;

  const diffs = [];
  if (base) {
    diffs.push(
      git(["diff", "--unified=0", "--no-color", `${base}...HEAD`, "--", changelogPath]),
    );
  }
  diffs.push(
    git(["diff", "--unified=0", "--no-color", "--", changelogPath]),
    git(["diff", "--cached", "--unified=0", "--no-color", "--", changelogPath]),
  );

  if (diffs.some(hasAddedNonEmptyLine)) return true;

  // 新建且尚未跟踪的日志没有 git diff；此时直接要求文件包含非空内容。
  const isUntracked = lines(
    git(["ls-files", "--others", "--exclude-standard", "--", changelogPath]),
  ).includes(changelogPath);
  return isUntracked;
}

const changedFiles = new Set();
const base = resolveBase();

if (base) {
  for (const path of lines(git(["diff", "--name-only", `${base}...HEAD`]))) {
    changedFiles.add(path);
  }
}

for (const args of [
  ["diff", "--name-only"],
  ["diff", "--name-only", "--cached"],
  ["ls-files", "--others", "--exclude-standard"],
]) {
  for (const path of lines(git(args))) changedFiles.add(path);
}

const specChanges = [...changedFiles]
  // Markdown 与仓库跟踪的 HTML 导出都属于会发布的规范；二者任一变化都必须记日志。
  .filter((path) => path.startsWith(docsPrefix) && path !== changelogPath)
  .sort();

if (specChanges.length > 0 && !changelogHasNewContent(base)) {
  console.error("❌ 规范已更新，但 docs/CHANGELOG.md 没有追加有效内容：");
  for (const path of specChanges) console.error(`   ${path}`);
  console.error("   每次规范变更必须在同一提交或 PR 追加更新日志。");
  process.exit(1);
}

if (specChanges.length > 0) {
  console.log(`✅ 更新日志门禁通过：${specChanges.length} 个规范文件 + CHANGELOG.md`);
} else {
  console.log("✅ 本次没有规范正文变更，无需新增更新日志条目");
}
