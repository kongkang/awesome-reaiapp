import { defineContractSuite } from "@reai/app-test/v1";

/**
 * 合同套件跑的是**真实 App 代码**接在 Mock Host 上。
 *
 * B6-27：页内「+」撤除后，「新增项目」的唯一入口是 Host titlebar 动作
 * （manifest titlebarActions：add-project）。场景投递真实 Host 信封
 * （host.titlebarAction）验证打开插件内选文件夹浮层。
 */
export default defineContractSuite({
  appDirectory: "..",
  hostApi: "1.4.0",
  expect: {
    surfaces: ["main"],
    readySurfaces: ["main"],
    forbiddenNetworkRequests: "all",
    noResourcesAfterUnmount: true,
  },
  scenarios: [
    {
      name: "Host 标题栏动作打开「把文件夹加成项目」浮层",
      async run({ host }) {
        const main = await host.openSurface("main");
        if (!main.root) throw new Error("DOM 环境不可用");
        await host.sendIntent(main.surfaceMountId, {
          source: "host.titlebarAction",
          actionId: "add-project",
          deliveryId: "contract-add-project",
          payload: { type: "add-project" },
        });
        if (!main.root.querySelector(".task-folder-picker.is-open")) {
          throw new Error("新增项目标题栏动作没有打开选文件夹浮层");
        }
      },
    },
  ],
});
