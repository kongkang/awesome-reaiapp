import { defineContractSuite } from "@reai/app-test/v1";

export default defineContractSuite({
  appDirectory: "..",
  hostApi: "1.1.0",
  expect: {
    surfaces: ["main"],
    commands: ["com.example.minimal.ping"],
    readySurfaces: ["main"],
    forbiddenNetworkRequests: "all",
    storageNamespace: "com.example.minimal",
    noResourcesAfterUnmount: true,
  },
  scenarios: [
    {
      name: "ping 成功并写入私有存储",
      async run({ host }) {
        const settlement = await host.invokeCommand("com.example.minimal.ping");
        if (!settlement.ok) throw new Error("ping 应当成功");
        if (!host.storageKeys().includes("com.example.minimal/notes/last-ping")) {
          throw new Error(`存储键不对：${host.storageKeys().join(", ")}`);
        }
      },
    },
  ],
});
