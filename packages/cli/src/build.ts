/**
 * `reai-app build` —— 把 App 源码编译成包内可加载的 ESM，并产出 Build Manifest。
 *
 * Build Manifest 是**包内资源的白名单**：Host 的 `PackageResourceResolver` 只服务清单
 * 里列出的文件，且要求 size / sha256 对得上。没有它，包里多出来的任何文件都能被
 * 请求到——不是安全问题（首版只装官方包），而是「构建产物里混进了不该有的东西」
 * 这类事故会一路走到用户机器上才被发现。
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { validateManifest, type Finding } from "./validate";
import { validateSkinDefinition } from "./skin";

/** Build Manifest v1：包内资源白名单。 */
export interface BuildManifestV1 {
  buildManifestVersion: 1;
  appId: string;
  version: string;
  /** 普通 App 组件入口；Skin 包缺席。 */
  entry?: string;
  /** Skin v1 定义入口；普通 App 缺席。 */
  skinEntry?: string;
  /**
   * 需要随入口一起加载的样式表，相对包根。
   *
   * App 里写 `import "./x.css"` 时打包器会把样式抽成独立文件——JS 里就没有它了。
   * Host 生成 bootstrap 页面时必须照这份清单把它们 link 上，否则 App 起来是能起来，
   * 但一点样式都没有，看着像坏了。
   */
  styles: string[];
  files: BuildManifestEntry[];
}

export interface BuildManifestEntry {
  /** 相对包根的路径，一律用 `/` 分隔。 */
  path: string;
  size: number;
  sha256: string;
  mime: string;
}

export const BUILD_MANIFEST_NAME = "build-manifest.json";
export const APP_MANIFEST_NAME = "app.manifest.json";

export interface BuildResult {
  appDirectory: string;
  manifest: Record<string, unknown>;
  buildManifest: BuildManifestV1;
}

export class BuildError extends Error {
  readonly findings: Finding[];
  constructor(message: string, findings: Finding[] = []) {
    super(message);
    this.name = "BuildError";
    this.findings = findings;
  }
}

/** 打包进 `.reaiapp` 的目录。其余目录（`src/`、`node_modules/`…）不进包。 */
const PACKAGED_DIRECTORIES = ["dist", "assets", "skin"];

/**
 * 构建一个 App。
 *
 * 每次都是**全量重建**：先清空 `dist/` 再编译。不做增量、不比 mtime——mtime 在
 * CI、容器和 git checkout 之间根本不可靠，「看起来是新的所以跳过」会让人拿着旧产物
 * 打包，而这种错误在包里看不出来。
 */
export async function buildApp(appDirectory: string): Promise<BuildResult> {
  const root = resolve(appDirectory);
  const manifestPath = join(root, APP_MANIFEST_NAME);
  if (!existsSync(manifestPath)) {
    throw new BuildError(`${manifestPath} 不存在`);
  }

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
  const findings = validateManifest(manifest);
  if (findings.length > 0) {
    throw new BuildError("Manifest 校验未通过，构建中止", findings);
  }

  const isSkin = manifest["packageType"] === "skin";
  let entry: string | undefined;
  let skinEntry: string | undefined;
  if (isSkin) {
    skinEntry = String((manifest["skin"] as Record<string, unknown>)["entry"]);
    rmSync(join(root, "dist"), { recursive: true, force: true });
    if (!existsSync(join(root, skinEntry))) {
      throw new BuildError(`Skin 定义入口 ${skinEntry} 不存在`);
    }
    const skinBytes = readFileSync(join(root, skinEntry));
    if (skinBytes.byteLength > 128 * 1024) {
      throw new BuildError("Skin 定义超过 128 KiB");
    }
    let skinDefinition: unknown;
    try {
      skinDefinition = JSON.parse(skinBytes.toString("utf8"));
    } catch (error) {
      throw new BuildError(`Skin 定义不是合法 JSON：${String(error)}`);
    }
    const skinFindings = validateSkinDefinition(skinDefinition);
    if (skinFindings.length > 0) {
      throw new BuildError("Skin 定义校验未通过，构建中止", skinFindings);
    }
  } else {
    const component = firstComponent(manifest);
    entry = String(component["entry"]);
    const source = resolveSourceEntry(root);
    const outDir = join(root, dirname(entry));
    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(outDir, { recursive: true });
    await bundle(source, outDir, root);
  }

  const files = collectPackagedFiles(root);
  const outPrefix = entry ? `${dirname(entry)}/` : "";
  const styles = isSkin ? [] : files
    .filter((f) => f.path.startsWith(outPrefix) && f.path.endsWith(".css"))
    .map((f) => f.path);

  const buildManifest: BuildManifestV1 = {
    buildManifestVersion: 1,
    appId: String(manifest["appId"]),
    version: String(manifest["version"]),
    ...(entry ? { entry } : {}),
    ...(skinEntry ? { skinEntry } : {}),
    styles,
    files,
  };
  writeFileSync(
    join(root, BUILD_MANIFEST_NAME),
    `${JSON.stringify(buildManifest, null, 2)}\n`,
    "utf8",
  );

  if (entry && !files.some((f) => f.path === entry)) {
    throw new BuildError(`构建产物里没有入口 ${entry}；请检查 reaiApp.entry 配置`);
  }
  if (skinEntry && !files.some((f) => f.path === skinEntry)) {
    throw new BuildError(`构建产物里没有 Skin 定义 ${skinEntry}`);
  }

  return { appDirectory: root, manifest, buildManifest };
}

/**
 * 在**子进程**里打包。
 *
 * 不用进程内的 `Bun.build`，有两个实打实的理由：
 *
 * 1. 打包器与运行时共用一套模块缓存。当同一个进程既 `import` 了 `@reai/app-sdk`
 *    （比如紧接着要跑合同测试），又要把它打进 App 产物里，第二次打包就会在读取
 *    SDK 源文件时失败。子进程从根上避开这类互相污染。
 * 2. 子进程的工作目录就是 App 目录，依赖解析与 App 开发者本地跑出来的完全一致——
 *    不会出现「我们的工具链能构建、你的机器不行」。
 *
 * 命名规则里不带 hash：包内路径要能被 Manifest 的 `entry` 稳定引用。样式与入口分开
 * 命名，否则 `import "./x.css"` 抽出来的样式会和入口抢同一个输出名。
 *
 * 不 minify：包体不大，而可读的产物让「装到用户机器上的到底是什么」这个问题随时可查。
 */
async function bundle(source: string, outDir: string, cwd: string): Promise<void> {
  const proc = Bun.spawn(
    [
      process.execPath,
      "build",
      source,
      "--outdir",
      outDir,
      "--target",
      "browser",
      "--format",
      "esm",
      "--entry-naming",
      "[name].[ext]",
      "--chunk-naming",
      "[name]-[hash].[ext]",
      "--asset-naming",
      "[name].[ext]",
      // SDK 运行时**由 Host 提供**，不进插件包。Host 的 bootstrap 用 import map 把这个
      // 裸标识符指向自己那份。让每个插件各自打包一份的话，一个半年前发布的插件会带着
      // 半年前的运行时跑在今天的 Host 上，而两边的协议早就不一样了。
      "--external",
      "@reai/app-sdk/v1",
    ],
    { cwd, stdout: "pipe", stderr: "pipe" },
  );

  const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  if (exitCode !== 0) {
    throw new BuildError(`编译失败：\n${stderr.trim()}`);
  }
}

/** 源码入口：`package.json` 的 `reaiApp.entry`，默认 `src/app.ts`。 */
function resolveSourceEntry(root: string): string {
  const packageJsonPath = join(root, "package.json");
  let configured = "src/app.ts";
  if (existsSync(packageJsonPath)) {
    const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8")) as Record<string, unknown>;
    const reaiApp = pkg["reaiApp"];
    if (reaiApp && typeof reaiApp === "object" && "entry" in reaiApp) {
      configured = String((reaiApp as Record<string, unknown>)["entry"]);
    }
  }
  const source = join(root, configured);
  if (!existsSync(source)) {
    throw new BuildError(`源码入口 ${configured} 不存在（可在 package.json 的 reaiApp.entry 指定）`);
  }
  return source;
}

function firstComponent(manifest: Record<string, unknown>): Record<string, unknown> {
  const runtime = manifest["runtime"] as Record<string, unknown> | undefined;
  const components = (runtime?.["components"] ?? []) as Record<string, unknown>[];
  const first = components[0];
  if (!first) throw new BuildError("Manifest 没有声明 runtime.components");
  return first;
}

/** 收集进包的文件，路径统一为相对包根的 `/` 形式，且按字典序排好。 */
export function collectPackagedFiles(root: string): BuildManifestEntry[] {
  const files: BuildManifestEntry[] = [];

  const visit = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        visit(full);
        continue;
      }
      const path = relative(root, full).split("\\").join("/");
      const bytes = readFileSync(full);
      files.push({
        path,
        size: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        mime: mimeFor(path),
      });
    }
  };

  const manifestPath = join(root, APP_MANIFEST_NAME);
  const manifestBytes = readFileSync(manifestPath);
  files.push({
    path: APP_MANIFEST_NAME,
    size: manifestBytes.byteLength,
    sha256: createHash("sha256").update(manifestBytes).digest("hex"),
    mime: "application/json",
  });

  for (const dir of PACKAGED_DIRECTORIES) {
    const full = join(root, dir);
    if (existsSync(full) && statSync(full).isDirectory()) visit(full);
  }

  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * 按扩展名给 MIME。
 *
 * **清单说了算**，不做内容嗅探：嗅探的结果会随实现变化，而 Host 是按清单里的 MIME
 * 发响应头的——两次打包出不同的 MIME，等于同样的包在不同机器上行为不同。
 */
export function mimeFor(path: string): string {
  const table: Record<string, string> = {
    ".js": "text/javascript",
    ".mjs": "text/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".html": "text/html",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".woff2": "font/woff2",
  };
  return table[extname(path).toLowerCase()] ?? "application/octet-stream";
}
