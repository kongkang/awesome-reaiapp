import { defineContractSuite } from "@reai/app-test/v1";

export default defineContractSuite({
  appDirectory: "..",
  hostApi: "1.16.0",
  expect: {
    surfaces: ["main"], commands: [], intents: [], readySurfaces: ["main"],
    forbiddenNetworkRequests: "all", noResourcesAfterUnmount: true,
  },
  scenarios: [{
    name: "locale updates preserve DOM and action state across background and future mounts",
    async run({ host }) {
      host.setLocale("en");
      const main = await host.openSurface("main");
      const status = main.root?.querySelector<HTMLElement>("[data-titlebar-demo-status]");
      if (!status?.textContent?.includes("Waiting")) throw new Error("Initial English snapshot not rendered");
      await host.sendIntent(main.surfaceMountId, {
        source: "host.titlebarAction", actionId: "mark-clicked", deliveryId: "locale-action",
        payload: { type: "mark-clicked" },
      });
      if (status.dataset.titlebarDemoStatus !== "clicked") throw new Error("Action state missing");
      host.setLocale("zh");
      if (!status.textContent?.includes("已送达")) throw new Error("Live Chinese update missing");
      host.setLocale("en");
      if (!status.textContent?.includes("received")) throw new Error("Action state lost on language change");
      if (main.root?.querySelector("[data-titlebar-demo-status]") !== status) throw new Error("Language switch replaced DOM");
      await host.unmountSurface(main.surfaceMountId);
      const detachedText = status.textContent;
      host.setLocale("zh");
      if (status.textContent !== detachedText) throw new Error("Unmounted surface still receives locale updates");
      const later = await host.openSurface("main");
      if (!later.root?.textContent?.includes("等待标题栏动作")) throw new Error("New mount missed current locale");
    },
  }],
});
