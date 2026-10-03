/**
 * 把 docs/ 的 markdown 同步进本站的 src/，并在同步时改写那些
 * 「在仓库里有效、搬到站上就失效」的链接。
 *
 * 为什么要复制而不是直接把 srcDir 指过去：Vite 解析依赖时从 md 文件所在目录
 * 向上找 node_modules，而 docs/ 那边一路到仓库根都没有，会以
 * "failed to resolve vue/server-renderer" 构建失败。复制进站点目录即可正常解析，
 * 同时 docs/ 保持纯 markdown、不被 node_modules 污染。
 *
 * 为什么在这里改写链接而不是改文档源：文档里指向 driver-v2/ 样例、schema 与
 * design/ 设计稿的链接，在编辑器和仓库里点得开，只有发布到站上才是死链（那些文件
 * 在私有仓，没跟着发布）。改源文件等于为了网站牺牲仓库内的阅读体验，所以改写只发生
 * 在同步产物里，事实源 docs/ 一个字不动。
 *
 * src/ 是构建产物（已 gitignore），每次构建重建。
 */
import { access, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, "..", "..", "docs");
const DEST = join(here, "..", "src");

/**
 * 站上打不开、需要降级成纯文本的链接前缀。
 *
 * 这些目标都在私有仓里，公开站不可能解析。降级后保留文字与仓库内路径，读者知道
 * 去哪找，也不会点出一个 404。
 */
const UNPUBLISHED = [
  { prefix: "../../scripts/", repoPath: (t) => t.slice("../../".length) },
  { prefix: "../../.agents/", repoPath: (t) => t.slice("../../".length) },
  { prefix: "../../driver-v2/", repoPath: (t) => t.slice("../../".length) },
  { prefix: "../../design/", repoPath: (t) => t.slice("../../".length) },
  { prefix: "../../plans/", repoPath: (t) => t.slice("../../".length) },
  { prefix: "../../docs/", repoPath: (t) => t.slice("../../".length) },
  { prefix: "../../plugins/", repoPath: (t) => t.slice("../../".length) },
  { prefix: "../", repoPath: (t) => t.slice("../".length) },
];

/** `[文字](目标)`，目标不含空格与右括号 */
const MD_LINK = /\[([^\]]+)\]\(([^)\s]+)\)/g;

/**
 * 把链接降级成纯文本：`[样例代码](../../driver-v2/x)` → 样例代码（仓库内 `driver-v2/x`）
 */
function degrade(text, repoPath) {
  return `${text}（仓库内 \`${repoPath}\`）`;
}

/**
 * 处理指向同名 .html 的「交互版」链接。
 *
 * 这些链接在仓库里指向独立导出的 HTML 版本，但站上同名 markdown 恰好编译成同名
 * .html，点过去等于原地打转——不报错、不死链，比 404 更让人困惑。站本身就是交互版，
 * 所以整条去掉。
 *
 * 两种出现形态：独占一行（连行一起删）、跟在分隔符后面（只删链接与分隔符）。
 */
function stripSelfReferencingHtmlLinks(markdown, mdBasenames) {
  const isSelfRef = (target) => {
    const m = /^\.\/(.+)\.html$/.exec(target);
    return m !== null && mdBasenames.has(`${m[1]}.md`);
  };

  let inCodeFence = false;

  return markdown
    .split("\n")
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        inCodeFence = !inCodeFence;
        return line;
      }
      if (inCodeFence) return line; // 围栏内是示例代码，不碰
      if (!/\]\(\.\/[^)\s]+\.html\)/.test(line)) return line;

      // 先尝试连同前面的分隔符一起删（`A · [交互版](./x.html)` → `A`）
      let out = line.replace(
        new RegExp(String.raw`\s*[·|]\s*\[([^\]]+)\]\(([^)\s]+)\)`, "g"),
        (whole, _text, target) => (isSelfRef(target) ? "" : whole),
      );
      out = out.replace(MD_LINK, (whole, _text, target) => (isSelfRef(target) ? "" : whole));

      // 删干净后只剩引用符号与「交互版：」这类引导词，说明整行就是为它存在的
      const residue = out.replace(/[>\s·|]/g, "");
      return residue === "" || /^交互版[:：]?$/.test(residue) ? null : out;
    })
    .filter((line) => line !== null)
    .join("\n");
}

/**
 * 改写一篇文档里的仓库相对链接。
 *
 * 未被规则覆盖的相对链接会被收集起来，由调用方中断构建——宁可发布失败，也不让新增
 * 的死链无声上站。
 */
function rewriteLinks(markdown, mdBasenames) {
  const unknown = [];
  let inCodeFence = false;

  const rewritten = stripSelfReferencingHtmlLinks(markdown, mdBasenames)
    .split("\n")
    .map((line) => {
      // 代码围栏里的内容是示例，不是导航。里面的 `[x](../y)` 一样会被下面的规则命中，
      // 改写它等于把别人的示例代码悄悄改成一句中文——而「未覆盖就中断构建」那道网
      // 拦不住这种情况，因为它是被规则命中、不是漏网。
      if (/^\s*(```|~~~)/.test(line)) {
        inCodeFence = !inCodeFence;
        return line;
      }
      if (inCodeFence) return line;

      return line.replace(MD_LINK, (whole, text, target) => {
        // rewrites 改变了网站文件名；同步阶段统一，保证客户端导航也使用正确路径。
        const renamed = /^(?:\.\/)?(README|CHANGELOG)\.md(#.*)?$/.exec(target);
        if (renamed) {
          // Markdown 路由不含 base；VitePress 在渲染时补 /docs/。
          const route = renamed[1] === "README" ? "/" : "/changelog";
          return `[${text}](${route}${renamed[2] ?? ""})`;
        }
        // 外链、锚点、站内 markdown 互链都原样保留
        if (/^(https?:|mailto:|#)/.test(target)) return whole;
        if (/^\.\/[^/]+\.md(#.*)?$/.test(target)) return whole;
        if (!target.startsWith("../") && !target.startsWith("/")) return whole;

        const rule = UNPUBLISHED.find((r) => target.startsWith(r.prefix));
        if (rule) return degrade(text, rule.repoPath(target));

        unknown.push(target);
        return whole;
      });
    })
    .join("\n");

  return { rewritten, unknown };
}

/**
 * 同步时会把仓库私有目标降级成纯文本，但降级前仍要确认源文档真的指向一个存在的目标。
 * 否则站点虽然能构建，GitHub 上的开发者文档却会留下一个被掩盖的 404。
 */
async function findMissingRepositoryLinks(markdown, sourcePath) {
  const missing = [];
  let inCodeFence = false;

  for (const line of markdown.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      inCodeFence = !inCodeFence;
      continue;
    }
    if (inCodeFence) continue;

    for (const match of line.matchAll(MD_LINK)) {
      const target = match[2];
      if (!target.startsWith("../")) continue;
      const path = decodeURIComponent(target.split(/[?#]/, 1)[0]);
      try {
        await access(resolve(dirname(sourcePath), path));
      } catch {
        missing.push(target);
      }
    }
  }

  return missing;
}

await rm(DEST, { recursive: true, force: true });
await mkdir(DEST, { recursive: true });

const entries = await readdir(SRC, { withFileTypes: true });
// Repository operations guides do not belong to the plugin documentation site.
const repositoryGuides = new Set(["deployment-status.md", "worktree-workflow.md"]);
const docs = entries.filter((e) => e.isFile() && e.name.endsWith(".md") && !repositoryGuides.has(e.name));
const mdBasenames = new Set(docs.map((d) => d.name));

const problems = [];
let degraded = 0;

for (const doc of docs) {
  const sourcePath = join(SRC, doc.name);
  const original = await readFile(sourcePath, "utf8");
  const { rewritten, unknown } = rewriteLinks(original, mdBasenames);
  const missing = await findMissingRepositoryLinks(original, sourcePath);

  for (const target of unknown) problems.push(`${doc.name} → ${target}`);
  for (const target of missing) problems.push(`${doc.name} → ${target}（目标不存在）`);
  if (rewritten !== original) degraded++;

  await writeFile(join(DEST, doc.name), rewritten);
}

if (problems.length > 0) {
  console.error("❌ 发现未被改写规则覆盖的仓库相对链接，发布到站上会变成死链：");
  for (const p of problems) console.error(`   ${p}`);
  console.error("   要么给 UNPUBLISHED 补规则，要么把被引用的文件一并公开托管。");
  process.exit(1);
}

// English reading guides use explicit site routes; VitePress validates their links.
const englishSource=join(SRC,'en');
await mkdir(join(DEST,'en'),{recursive:true});
for(const entry of await readdir(englishSource,{withFileTypes:true})) {
  if(entry.isFile() && entry.name.endsWith('.md')) await writeFile(join(DEST,'en',entry.name),await readFile(join(englishSource,entry.name),'utf8'));
}
console.log(`已同步 ${docs.length} 篇文档（${degraded} 篇改写了站上打不开的链接）`);
