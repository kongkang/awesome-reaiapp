/**
 * `reai-app contract-test` —— 跑 App 自己的合同套件。
 *
 * 跑的是**真实 App 代码**接在 Mock Host 上，不是 mock 掉 App 再断言 mock。
 * 所以「Manifest 声明了但 activate 没注册」这类错在这里就会暴露，不用等到装进 Host。
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { MockHost, type ContractResult, type ContractSuite } from "@reai/app-test/v1";
import { APP_MANIFEST_NAME } from "./build";

/**
 * 声明的 hostApi 是否满足命令行要求的版本。
 *
 * 按**段**比，不比字符串前缀：`"1.10.0".startsWith("1.1")` 是 true——于是要求 1.1 时，
 * 一个声明 1.10 的套件会被判成相容。版本号里 10 不是 1 的延伸，这类误判在 CI 上
 * 表现为「明明不兼容却全绿」，是最难发现的那一类。
 */
export function hostApiMatches(declared: string, wanted: string): boolean {
  const d = declared.split(".");
  const w = wanted.split(".");
  return w.length <= d.length && w.every((seg, i) => seg === d[i]);
}

export class ContractTestError extends Error {}

export interface ContractTestOptions {
  appDirectory: string;
  /** 合同套件文件，默认 `<appDirectory>/tests/contract.suite.ts`。 */
  suitePath?: string;
  /** 期望的 Host API 版本；与套件声明不符时直接失败。 */
  hostApi?: string;
}

export async function runContractTest(options: ContractTestOptions): Promise<ContractResult> {
  const root = resolve(options.appDirectory);
  const suitePath = options.suitePath
    ? resolve(options.suitePath)
    : join(root, "tests", "contract.suite.ts");

  if (!existsSync(suitePath)) {
    throw new ContractTestError(`合同套件 ${suitePath} 不存在`);
  }

  const module = (await import(suitePath)) as { default?: ContractSuite };
  const suite = module.default;
  if (!suite || typeof suite.run !== "function") {
    throw new ContractTestError("合同套件必须 export default defineContractSuite({...})");
  }

  if (options.hostApi && !hostApiMatches(suite.config.hostApi, options.hostApi)) {
    throw new ContractTestError(
      `套件声明的 hostApi 是 ${suite.config.hostApi}，与命令行要求的 ${options.hostApi} 不符`,
    );
  }

  const manifestPath = join(root, APP_MANIFEST_NAME);
  if (!existsSync(manifestPath)) {
    throw new ContractTestError(`${manifestPath} 不存在`);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

  const entry = entryPath(manifest);
  const entryFile = join(root, entry);
  if (!existsSync(entryFile)) {
    throw new ContractTestError(`入口 ${entry} 不存在；请先 reai-app build`);
  }

  const hasDom = await ensureDom();

  return suite.run({
    manifest,
    hasDom,
    createHost: () =>
      new MockHost({
        manifest,
        loadApp: () => import(`${entryFile}?t=${Math.random()}`) as Promise<{ default: unknown }>,
        ...(hasDom
          ? { createRoot: () => globalThis.document.createElement("div") }
          : {}),
      }),
  });
}

/**
 * 保证有 DOM 可用。
 *
 * 绝大多数 App 的 Surface 一上来就碰 `surface.root`。没有 DOM 的话，合同测试只能报
 * 「扩展遇到未处理的错误」——开发者看到这句话什么也做不了。所以 CLI 自己准备 DOM，
 * 而不是把这个条件转嫁给每个 App 作者。
 *
 * 装不上就如实返回 `false`：`toHaveFocus` 这类断言会明确说「需要 DOM」，
 * 而不是悄悄通过。
 */
async function ensureDom(): Promise<boolean> {
  if (typeof (globalThis as { document?: unknown }).document !== "undefined") return true;
  try {
    const { GlobalRegistrator } = await import("@happy-dom/global-registrator");
    GlobalRegistrator.register();
    return typeof (globalThis as { document?: unknown }).document !== "undefined";
  } catch {
    return false;
  }
}

function entryPath(manifest: unknown): string {
  const runtime = (manifest as Record<string, unknown>)["runtime"] as
    | Record<string, unknown>
    | undefined;
  const components = (runtime?.["components"] ?? []) as Record<string, unknown>[];
  const entry = components[0]?.["entry"];
  if (typeof entry !== "string") {
    throw new ContractTestError("Manifest 的第一个组件没有声明 entry");
  }
  return entry;
}
