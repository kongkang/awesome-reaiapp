import { defineContractSuite } from "@reai/app-test/v1";

/**
 * 合同套件（最小骨架）：覆盖 装→启用→卸载 的基础路径跑通。
 *
 * 真实协议链路（连 app-server / 审批往返）由 C2 真管道契约测试覆盖
 * （driver-v2/src-tauri/tests/codex_pipeline.rs，#[ignore]），这里只验插件本体
 * 在 Mock Host 上符合平台规范。
 */
export default defineContractSuite({
  appDirectory: "..",
  hostApi: "1.19.0",
  expect: {
    surfaces: ["main"],
    commands: [
      "com.reai.codex-link.new-task",
      "com.reai.codex-link.approve",
      "com.reai.codex-link.deny",
    ],
    intents: [],
    readySurfaces: ["main"],
    forbiddenNetworkRequests: "all",
    noResourcesAfterUnmount: true,
  },
  scenarios: [
    {
      name: "main surface 能挂载并 ready",
      async run({ host, expect }) {
        const main = await host.openSurface("main");
        expect(main).toBeOpen();
      },
    },
  ],
});
