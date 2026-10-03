/** Modern owns validation and orchestration; frozen CLI primitives remain immutable. */
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { APP_MANIFEST_NAME, BUILD_MANIFEST_NAME, BuildError, collectPackagedFiles, type BuildResult, type BuildManifestV1 } from "@reai/app-cli";
import { validateManifest } from "./gateway";
import { validateLocaleDirectory } from "./resources";
import { validateSkinDefinition } from "./skin";
import { safeChild, assertSafeTree } from "./paths";
import type { SourceReviewEvidence } from "./source-review-evidence";

export async function buildApp(appDirectory: string, requireI18n = true, sourceReview?: SourceReviewEvidence): Promise<BuildResult> {
  const root = realpathSync(resolve(appDirectory));
  const manifestPath = join(root, APP_MANIFEST_NAME);
  assertSafeTree(root, APP_MANIFEST_NAME);
  if (!existsSync(manifestPath)) {
    throw new BuildError(`${manifestPath} 不存在`);
  }

  const originalManifest = readFileSync(manifestPath);
  const manifest = JSON.parse(originalManifest.toString("utf8")) as Record<string, unknown>;
  const findings = [...validateManifest(manifest, sourceReview, root), ...validateLocaleDirectory(root, manifest, requireI18n)];
  if (findings.length > 0) {
    throw new BuildError("Manifest 校验未通过，构建中止", findings);
  }
  for (const path of [BUILD_MANIFEST_NAME, "dist", "assets", "skin"]) assertSafeTree(root, path);

  const isSkin = manifest["packageType"] === "skin";
  let entry: string | undefined;
  let skinEntry: string | undefined;
  if (isSkin) {
    skinEntry = String((manifest["skin"] as Record<string, unknown>)["entry"]);
    assertSafeTree(root, "dist");
    assertSafeTree(root, skinEntry);
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
    const outDir = safeChild(root, dirname(entry));
    if (dirname(entry).split("/")[0] !== "dist") throw new BuildError("Build output must be inside dist");
    assertSafeTree(root, dirname(entry));
    if (source === outDir || source.startsWith(outDir + sep)) throw new BuildError("Build output overlaps source");
    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(outDir, { recursive: true });
    await bundle(source, outDir, root);
  }

  if (!readFileSync(manifestPath).equals(originalManifest)) throw new BuildError("Manifest changed during build");
  const finalFindings = [...validateManifest(manifest, sourceReview, root), ...validateLocaleDirectory(root, manifest, requireI18n)];
  if (finalFindings.length) throw new BuildError("Post-build validation failed", finalFindings);
  for (const path of [APP_MANIFEST_NAME, "dist", "assets", "skin"]) assertSafeTree(root, path);
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
  assertSafeTree(root, BUILD_MANIFEST_NAME);
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
  const source = safeChild(root, configured);
  assertSafeTree(root, configured);
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
