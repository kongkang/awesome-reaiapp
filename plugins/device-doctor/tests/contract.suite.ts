import { defineContractSuite } from "@reai/app-test/v1";

/**
 * 合同套件：验插件本体在 Mock Host 上符合平台规范。
 * 真正的「拉起 pi → 调工具 → 出答案」链路由 Host 侧 Rust 测试与
 * driver-v2-verify 的探针覆盖；这里只锁接口形状。
 */
export default defineContractSuite({
  appDirectory: "..",
  hostApi: "1.3.0",
  expect: {
    surfaces: ["main"],
    commands: [],
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
