import { defineContractSuite } from "@reai/app-test/v1";

/**
 * 合同套件：覆盖 装→启用→卸载 的基础路径。
 *
 * 许愿墙无 commands（v1 不绑硬件键），唯一 surface 是 main。
 * `/api/home` 由 Mock Host 截获并返回确定性响应；合同套件不得绕过 Host 发真实网络请求。
 */
export default defineContractSuite({
  appDirectory: "..",
  hostApi: "1.1.0",
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
