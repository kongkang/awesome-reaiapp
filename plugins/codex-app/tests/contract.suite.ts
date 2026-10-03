import type { RequestMethod } from "@reai/app-sdk/v1";
import { defineContractSuite, type MockHost } from "@reai/app-test/v1";

const pause = () => new Promise<void>(resolve => setTimeout(resolve, 0));
async function waitUntil(condition: () => boolean): Promise<void> {
  const until = Date.now() + 1000;
  while (!condition()) {
    if (Date.now() > until) throw new Error("Fixture did not settle");
    await pause();
  }
}

/** Explicit local protocol fixtures; never launch a runtime or make paid requests. */
function installFixture(host: MockHost, logged = true): string[] {
  const calls: string[] = [];
  const original = host.bridge.request;
  host.bridge.request = async <T>(method: RequestMethod, params: unknown, options?: { signal?: AbortSignal }): Promise<T> => {
    calls.push(method);
    let value: unknown;
    switch (method) {
      case "codex.tasks.account.read": value = { account: logged ? { type: "chatgpt", planType: "plus" } : null }; break;
      case "codex.tasks.thread.list": value = { data: [{ id: "h06-task", cwd: "/fixture/用户目录", name: "用户任务标题", updatedAt: 1700000000, status: "idle" }] }; break;
      case "codex.tasks.thread.read": value = { thread: { turns: [{ status: "completed", items: [{ type: "userMessage", content: [{ type: "text", text: "用户原始内容" }] }] }] } }; break;
      case "codex.tasks.events.drain": value = { events: [], malformedCount: 0 }; break;
      case "codex.tasks.runtime.status": value = { running: true, profile: "owned-isolated", runtimeVersion: "fixture", installState: "managed" }; break;
      case "codex.tasks.models.list": value = { data: [{ id: "fixture-model", displayName: "Fixture model", isDefault: true, supportedReasoningEfforts: [] }] }; break;
      case "codex.tasks.skills.list": value = { data: [] }; break;
      case "codex.tasks.account.rate-limits": value = { rateLimits: {} }; break;
      case "codex.tasks.account.usage": value = {}; break;
      case "codex.tasks.account.login.start": throw new Error("Explicit fixture login failure");
      case "codex.tasks.conversation.opened": value = undefined; break;
      default: return original<T>(method, params, options);
    }
    return value as T;
  };
  return calls;
}

export default defineContractSuite({
  appDirectory: "..",
  hostApi: "1.19.0",
  expect: {
    surfaces: ["main"],
    readySurfaces: ["main"],
    forbiddenNetworkRequests: "all",
    noResourcesAfterUnmount: true,
  },
  scenarios: [
    {
      name: "English cold start, background locale change, reopening, and cleanup preserve state without requests",
      async run({ host }) {
        const calls = installFixture(host);
        host.setLocale("en");
        const surface = await host.openSurface("main"); const root = surface.root!; document.body.append(root);
        await waitUntil(() => root.textContent?.includes("用户原始内容") === true);
        await pause();
        const input = root.querySelector<HTMLTextAreaElement>("#cxaInput")!;
        if (input.placeholder !== "Continue the work, or describe what to change…") throw new Error("Cold start was not English");
        input.value = "保留草稿"; input.focus(); input.setSelectionRange(1, 3);
        if (document.activeElement !== input) throw new Error("Fixture input is not focusable");
        const before = calls.length;
        const visibility = Object.getOwnPropertyDescriptor(document, "visibilityState");
        Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
        try {
          host.setLocale("zh"); await pause();
          if (String(input.placeholder) !== "继续交代工作，或指出要修改的地方…") throw new Error("Hidden surface stayed English");
          if (root.querySelector("#cxaInput") !== input || input.value !== "保留草稿") throw new Error("Locale replaced input or draft");
          if (document.activeElement !== input || input.selectionStart !== 1 || input.selectionEnd !== 3) throw new Error("Locale lost selection");
          if (calls.length !== before) throw new Error("Locale issued a business request");
        } finally {
          if (visibility) Object.defineProperty(document, "visibilityState", visibility);
          else delete (document as unknown as Record<string, unknown>).visibilityState;
        }
        await host.unmountSurface(surface.surfaceMountId); root.remove();
        const afterUnmount = calls.length;
        host.setLocale("en"); await pause();
        if (root.childNodes.length !== 0 || calls.length !== afterUnmount) throw new Error("Unmount left locale resources active");
        const reopened = await host.openSurface("main");
        if (reopened.root!.querySelector<HTMLTextAreaElement>("#cxaInput")!.placeholder !== "Continue the work, or describe what to change…") throw new Error("Reopened surface used old locale");
        await host.unmountSurface(reopened.surfaceMountId);
      },
    },
    {
      name: "Existing login failure and navigation update without repeating sign-in or polling",
      async run({ host }) {
        const calls = installFixture(host, false);
        const surface = await host.openSurface("main", { type: "open-settings" }); const root = surface.root!; document.body.append(root);
        await waitUntil(() => root.textContent?.includes("尚未登录") === true);
        const login = Array.from(root.querySelectorAll<HTMLButtonElement>("#cxaSettingsBody button")).find(button => button.textContent === "登录");
        if (!login) throw new Error("No fixture login button");
        login.click();
        await waitUntil(() => root.textContent?.includes("登录没有启动，请重试。") === true);
        await pause(); const before = calls.length;
        host.setLocale("en"); await pause();
        if (!root.textContent?.includes("Sign-in did not start. Please retry.")) throw new Error("Existing login failure stayed Chinese");
        if (surface.navReports.at(-1)?.label !== "Settings") throw new Error("Navigation did not update");
        if (calls.length !== before) throw new Error("Locale repeated login or a read request");
        await host.unmountSurface(surface.surfaceMountId); root.remove();
      },
    },
  ],
});
