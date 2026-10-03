import { defineContractSuite } from "@reai/app-test/v1";
async function until(condition: () => boolean) {
  const end = Date.now() + 1500;
  while (!condition()) { if (Date.now() > end) throw new Error("State did not settle"); await new Promise(resolve => setTimeout(resolve, 10)); }
}
export default defineContractSuite({
  appDirectory: "..", hostApi: "1.20.0",
  expect: { surfaces: ["main"], commands: ["com.reai.code-worker.back-to-root"], intents: [], readySurfaces: ["main"], forbiddenNetworkRequests: "all", storageNamespace: "com.reai.code-worker", noResourcesAfterUnmount: true },
  scenarios: [{
    name: "real plugin lifecycle, local preferences, packaged Skill and Host locale",
    async run({ host }) {
      host.serviceHandler = () => ({ demands: [] });
      const main = await host.openSurface("main"), root = main.root!;
      await until(() => Boolean(root.querySelector(".cw-stats")));
      const click = (selector: string) => { const button = root.querySelector<HTMLButtonElement>(selector); if (!button) throw new Error(`Missing ${selector}`); button.click(); };
      click('[data-tab="roles"]'); click('[data-limit="worker"]');
      const input = root.querySelector<HTMLInputElement>('input[name="limit"]')!; input.value = "12";
      root.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await until(() => Boolean(root.querySelector<HTMLElement>(".cw-overlay")?.hidden));
      if (!host.storageKeys().some(k => k.includes("tasks") && k.endsWith("state"))) throw new Error("Defaults were not persisted through SDK");
      click('[data-tab="skill"]');
      const skill = root.querySelector<HTMLTextAreaElement>("[data-skill-full]")!;
      if (!skill.value.includes("# AI 代码编排") || skill.value.length < 8000) throw new Error("Complete packaged Skill is missing");
      host.setLocale("en");
      if (!root.textContent?.includes("Use Skill") || root.querySelector("[data-skill-full]") !== skill) throw new Error("Locale did not preserve Skill control");
      const command = await host.invokeCommand("com.reai.code-worker.back-to-root");
      if (!command.ok || main.navReports.at(-1) !== null) throw new Error("Host back navigation failed");
      await host.unmountSurface(main.surfaceMountId);
      const remounted = await host.openSurface("main");
      await until(() => Boolean(remounted.root?.querySelector(".cw-stats")));
      remounted.root!.querySelector<HTMLButtonElement>('[data-tab="roles"]')!.click();
      if (!remounted.root?.textContent?.includes("/ 12 running")) throw new Error("Saved defaults were lost after remount");
    },
  }],
});
