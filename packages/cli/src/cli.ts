#!/usr/bin/env bun
/**
 * `reai-app` 命令行。
 *
 * 四个子命令对应 App 开发的四个节点：
 *
 * - `validate` —— 我的 Manifest Host 会不会收？（离线、秒级、与 Host 同一套规则）
 * - `build`    —— 编译成包内可加载的 ESM，并产出资源白名单
 * - `contract-test` —— 我声明的东西真的实现了吗？
 * - `pack`     —— 产出可复现的 `.reaiapp`
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildApp, BuildError } from "./build";
import { runContractTest, ContractTestError } from "./contract-test";
import { packApp, PackError } from "./pack";
import { validateManifestFile } from "./validate";
import { APP_MANIFEST_NAME } from "./build";
import { join, resolve } from "node:path";

const USAGE = `用法：
  reai-app validate <appDir>
  reai-app build <appDir>
  reai-app contract-test <appDir> [--host-api <版本>] [--suite <文件>]
  reai-app pack <appDir> --out <输出.reaiapp>
  reai-app --help | --version
`;

function cliVersion(): string {
  const pkg = JSON.parse(
    readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
  ) as { version: string };
  return pkg.version;
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;

  // --help/--version 是正常出口（exit 0）。以前它们落进 default 分支按「未知命令」
  // 返回 2——CI 脚本里一句 `reai-app --help` 探活就会误报失败。
  if (command === undefined || command === "--help" || command === "-h" || command === "help") {
    console.log(USAGE);
    return command === undefined ? 2 : 0;
  }
  if (command === "--version" || command === "-V" || command === "version") {
    console.log(cliVersion());
    return 0;
  }
  const positional = rest.filter((a) => !a.startsWith("--"));
  const appDir = positional[0] ?? ".";
  const flag = (name: string): string | undefined => {
    const index = rest.indexOf(`--${name}`);
    return index >= 0 ? rest[index + 1] : undefined;
  };

  switch (command) {
    case "validate": {
      const findings = validateManifestFile(join(resolve(appDir), APP_MANIFEST_NAME));
      if (findings.length === 0) {
        console.log("✓ Manifest 通过校验");
        return 0;
      }
      console.error(`✗ ${findings.length} 处问题：`);
      for (const f of findings) console.error(`  [${f.code}] ${f.pointer}: ${f.detail}`);
      return 1;
    }

    case "build": {
      const result = await buildApp(appDir);
      console.log(
        `✓ 构建完成：${result.buildManifest.files.length} 个文件，入口 ${result.buildManifest.entry ?? result.buildManifest.skinEntry}`,
      );
      return 0;
    }

    case "contract-test": {
      const options: Parameters<typeof runContractTest>[0] = { appDirectory: appDir };
      const hostApi = flag("host-api");
      if (hostApi) options.hostApi = hostApi;
      const suite = flag("suite");
      if (suite) options.suitePath = suite;

      const result = await runContractTest(options);
      for (const check of result.checks) {
        const mark = check.ok ? "✓" : "✗";
        console.log(`${mark} ${check.name}${check.detail ? ` —— ${check.detail}` : ""}`);
      }
      return result.passed ? 0 : 1;
    }

    case "pack": {
      const out = flag("out");
      if (!out) {
        console.error("pack 需要 --out <输出.reaiapp>");
        return 2;
      }
      const result = await packApp(appDir, out);
      console.log(
        `✓ 已打包 ${result.outputPath}\n  条目 ${result.entryCount} 个 / ${result.bytes} 字节\n  archiveDigest ${result.archiveDigest}`,
      );
      return 0;
    }

    default:
      console.error(USAGE);
      return 2;
  }
}

const exitCode = await main(process.argv.slice(2)).catch((error: unknown) => {
  if (error instanceof BuildError) {
    console.error(`✗ ${error.message}`);
    for (const f of error.findings) console.error(`  [${f.code}] ${f.pointer}: ${f.detail}`);
    return 1;
  }
  if (error instanceof PackError || error instanceof ContractTestError) {
    console.error(`✗ ${error.message}`);
    return 1;
  }
  console.error(error);
  return 1;
});

process.exit(exitCode);
