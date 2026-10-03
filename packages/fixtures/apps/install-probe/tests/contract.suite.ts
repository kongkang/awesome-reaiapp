import { defineContractSuite } from "@reai/app-test/v1";

export default defineContractSuite({
  appDirectory: "..",
  hostApi: "1.1.0",
  expect: {
    surfaces: ["main"],
    commands: ["com.reai.install-probe.open"],
    readySurfaces: ["main"],
    forbiddenNetworkRequests: "all",
    storageNamespace: "com.reai.install-probe",
    noResourcesAfterUnmount: true,
  },
  scenarios: [
    {
      name: "open command 写入私有存储并打开 Surface",
      async run({ host }) {
        const settlement = await host.invokeCommand("com.reai.install-probe.open");
        if (!settlement.ok) throw new Error("install probe command 应当成功");
        if (!host.storageKeys().includes("com.reai.install-probe/probe/last-command")) {
          throw new Error(`存储键不对：${host.storageKeys().join(", ")}`);
        }
      },
    },
  ],
});
