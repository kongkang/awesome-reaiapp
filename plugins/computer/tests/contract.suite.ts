import { defineContractSuite } from "@reai/app-test/v1";

/**
 * 合同套件跑的是**真实 App 代码**接在 Mock Host 上。
 *
 * `expect.commands` 已断言 `com.reai.computer.stop` 的声明与注册一致；
 * Computer Use 引擎（computer.* bridge 方法）与 VLM 出站（http.fetch）在
 * Mock Host 里不存在——挂载路径对引擎调用全部容错降级（状态显示错误提示
 * 而不是白屏），真实引擎链路由 Host 侧测试与人工验收覆盖。
 */
export default defineContractSuite({
  appDirectory: "..",
  hostApi: "1.5.0",
  expect: {
    surfaces: ["main"],
    commands: ["com.reai.computer.stop"],
    intents: [],
    readySurfaces: ["main"],
    forbiddenNetworkRequests: "all",
    storageNamespace: "com.reai.computer",
    noResourcesAfterUnmount: true,
  },
  scenarios: [
    {
      name: "主页挂载后 ready（引擎不可用时降级为提示，不白屏）",
      async run({ host, expect }) {
        const main = await host.openSurface("main");
        expect(main).toBeOpen();
      },
    },
  ],
});
