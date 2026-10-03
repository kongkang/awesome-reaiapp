import { defineContractSuite } from "@reai/app-test/v1";

/**
 * 合同套件跑的是**真实 App 代码**接在 Mock Host 上。
 *
 * `expect` 里写的是「我声明了什么、必须真的做到什么」；`scenarios` 里写的是具体流程。
 * 每个场景拿到的 `host` 已经安装并启用过了，直接开始你的流程即可。
 */
export default defineContractSuite({
  appDirectory: "..",
  hostApi: "1.2.0",
  expect: {
    surfaces: ["main"],
    commands: [
      "com.example.todo.new",
      "com.example.todo.assistant.open",
      "com.example.todo.assistant.talk",
    ],
    intents: ["new-task", "open-assistant", "talk-to-assistant"],
    readySurfaces: ["main"],
    forbiddenNetworkRequests: "all",
    storageNamespace: "com.example.todo",
    noResourcesAfterUnmount: true,
  },
  scenarios: [
    {
      name: "New Command 打开 main 并投递新建意图",
      async run({ host, expect }) {
        await host.invokeCommand("com.example.todo.new");

        // Command 里调的是 ctx.surfaces.open()，那只是**向 Host 提出请求**；
        // 真正的挂载由 Host 决定何时发生。这里扮演 Host 完成这一步。
        const request = host.surfaceOpenRequests.at(-1);
        const main = await host.openSurface("main", request?.intent);

        expect(main).toBeOpen();
        expect(main).toHaveReceivedIntent({ type: "new-task" });
      },
    },
    {
      name: "Open Assistant Command 打开 App 级日程助理",
      async run({ host, expect }) {
        await host.invokeCommand("com.example.todo.assistant.open", { conversationKey: "app" });
        const request = host.surfaceOpenRequests.at(-1);
        const main = await host.openSurface("main", request?.intent);
        expect(main).toBeOpen();
        expect(main).toHaveReceivedIntent({ type: "open-assistant", conversationKey: "app" });
      },
    },
    {
      name: "Talk Assistant Command 投递任务会话与聆听意图",
      async run({ host, expect }) {
        await host.invokeCommand("com.example.todo.assistant.talk", { conversationKey: "task:demo" });
        const request = host.surfaceOpenRequests.at(-1);
        const main = await host.openSurface("main", request?.intent);
        expect(main).toBeOpen();
        expect(main).toHaveReceivedIntent({ type: "talk-to-assistant", conversationKey: "task:demo" });
      },
    },
    {
      name: "Host 标题栏动作打开新建日程与日程助理",
      async run({ host }) {
        const main = await host.openSurface("main");
        if (!main.root) throw new Error("DOM 环境不可用");
        await host.sendIntent(main.surfaceMountId, {
          source: "host.titlebarAction",
          actionId: "new-task",
          deliveryId: "contract-new-task",
          payload: { type: "new-task" },
        });
        if (!main.root.querySelector(".todo-compose-card")) {
          throw new Error("新建日程标题栏动作没有打开输入卡");
        }
        main.root.querySelector<HTMLButtonElement>(".todo-compose-scrim")?.click();
        await host.sendIntent(main.surfaceMountId, {
          source: "host.titlebarAction",
          actionId: "assistant",
          deliveryId: "contract-assistant",
          payload: { type: "open-assistant" },
        });
        if (!main.root.querySelector(".todo-agent-drawer")) {
          throw new Error("日程助理标题栏动作没有打开助理");
        }
      },
    },
  ],
});
