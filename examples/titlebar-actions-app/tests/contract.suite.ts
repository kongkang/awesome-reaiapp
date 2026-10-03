import { defineContractSuite } from "@reai/app-test/v1";

export default defineContractSuite({
  appDirectory: "..",
  hostApi: "1.2.0",
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
      name: "Host 标题栏信封到达后展示 clicked 状态",
      async run({ host }) {
        const main = await host.openSurface("main");
        if (!main.root) throw new Error("DOM 环境不可用");
        await host.sendIntent(main.surfaceMountId, {
          source: "host.titlebarAction",
          actionId: "mark-clicked",
          deliveryId: "contract-delivery",
          payload: { type: "mark-clicked" },
        });
        const status = main.root.querySelector<HTMLElement>("[data-titlebar-demo-status]");
        if (status?.dataset.titlebarDemoStatus !== "clicked") {
          throw new Error("标题栏 intent 没有更新示例 Surface 状态");
        }
      },
    },
  ],
});
