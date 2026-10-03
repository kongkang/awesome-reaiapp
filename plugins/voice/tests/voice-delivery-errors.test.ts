import { afterAll, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { MockHost } from "@reai/app-test/v1";
import type { AppContext } from "@reai/app-sdk/v1";
import manifest from "../app.manifest.json";
import { COMMAND_HISTORY_KEY, DEFAULT_SETTINGS, DEFAULT_VOICE_FEATURE_SETTINGS, POLISH_LIGHT_DEFAULT_MIGRATION_KEY, type VoiceCommandHistoryItem, type VoiceHistoryItem } from "../src/data";
import { setVoiceLocale } from "../src/voice-i18n";

let ownsDom = false;
beforeAll(() => {
  if (typeof document === "undefined") { GlobalRegistrator.register(); ownsDom = true; }
});
afterAll(() => { if (ownsDom) GlobalRegistrator.unregister(); });

async function until(check: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 2500;
  while (!check() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  expect(check(), message).toBeTrue();
}

type Failure = {
  name: string;
  reason?: string;
  error?: { code: string; message: string };
  permission?: "system" | "plugin";
  unavailable?: boolean;
};
const failures: Failure[] = [
  { name: "一般写入故障", reason: "insert_failed" },
  { name: "真实 AX 权限缺失", reason: "accessibility_permission_required", permission: "system" },
  { name: "旧 Host 或 owner 拒绝不能推断权限", reason: "denied" },
  { name: "未知的未来失败原因", reason: "future_failure" },
  ...["VOICE_DELIVER_NOT_GRANTED", "com.reai.voice/VOICE_DELIVER_NOT_GRANTED"].map(code => ({
    name: code, error: { code, message: "Delivery capability was not admitted" }, unavailable: true,
  })),
  ...["VOICE_DELIVER_PERMISSION_REQUIRED", "VOICE_DELIVER_PERMISSION_DENIED"].flatMap(code => [
    { name: code, error: { code, message: "Delivery capability was rejected" }, permission: "plugin" as const },
    { name: `namespaced ${code}`, error: { code: `com.reai.voice/${code}`, message: "Delivery capability was rejected" }, permission: "plugin" as const },
  ]),
  { name: "错误文案含权限码但实际为传输错误", error: { code: "TRANSPORT_UNAVAILABLE", message: "Do not trust this text: VOICE_DELIVER_PERMISSION_DENIED" } },
  { name: "云端权限码不是插件写入权限", error: { code: "AI_PERMISSION_DENIED", message: "Unrelated capability failed" } },
];

for (const route of ["dictation", "translation"] as const) {
  for (const failure of failures) {
    test(`${route}: ${failure.name} 保留正文、正确说明原因且只投递一次`, async () => {
      document.body.replaceChildren();
      setVoiceLocale("zh");
      let context: AppContext | undefined;
      const host = new MockHost({
        manifest: structuredClone(manifest) as never,
        loadApp: async () => {
          const { default: app } = await import("../src/app");
          return { default: { ...app, async activate(ctx: AppContext) {
            context = ctx;
            const store = ctx.storage.private("voice-state");
            const engine = route === "dictation" ? "cloud" : "local";
            await store.set("recognition-engine-choice-v1", engine);
            await store.set("settings", { ...DEFAULT_SETTINGS, engine, polish: "raw" });
            await store.set(POLISH_LIGHT_DEFAULT_MIGRATION_KEY, 1);
            // MockHost 的 Agent 默认回中文：翻译目标设成简体中文，否则会被译文校验判成「不是目标语言」。
            await store.set("voice-feature-settings-v1", { ...DEFAULT_VOICE_FEATURE_SETTINGS, cloudModelId: "transcribe-free", translationTarget: "zh-CN" });
            return app.activate(ctx);
          } } };
        },
        createRoot: () => { const root = document.createElement("div"); document.body.append(root); return root; },
      });
      // Exercise the real SDK -> MockHost request path, changing only its response.
      // A future result is deliberately injected at the wire boundary, not added to the SDK union.
      const transport = host as unknown as { handleRequest(method: string, params: Record<string, unknown>): Promise<unknown> };
      const original = transport.handleRequest.bind(host);
      let injected = false;
      transport.handleRequest = async (method, params) => {
        const result = await original(method, params);
        if (method !== "voice.deliver.commit" || injected) return result;
        injected = true;
        if (failure.error) throw failure.error;
        return { committed: false, reason: failure.reason };
      };
      await host.installAndEnable();
      try {
        const surface = await host.openSurface("main");
        const event = route === "dictation" ? "com.reai.voice.toggle-input" : "com.reai.voice.command.translate";
        expect((await host.invokeCommand(event)).ok).toBeTrue();
        expect((await host.invokeCommand(event)).ok).toBeTrue();
        const commits = () => host.cloudRequests.filter(request => request.method === "voice.deliver.commit");
        await until(() => commits().length === 1, "Exactly one final delivery is attempted");
        let message = "";
        if (route === "dictation") {
          const historyKey = "com.reai.voice/voice-state/history";
          await until(() => host.storageKeys().includes(historyKey), "The transcript is retained after failed delivery");
          const history = await context!.storage.private("voice-state").get<VoiceHistoryItem[]>("history");
          expect(history).toHaveLength(1);
          expect(history![0]!.transcript).toBe("测试云端转写");
          expect(history![0]!.inserted).toBeFalse();
          await until(() => !!surface.root!.querySelector(".task-item"), "The retained result is visible");
          surface.root!.querySelector<HTMLButtonElement>(".task-item")!.click();
          message = surface.root!.querySelector(".inline-warning")?.textContent ?? "";
          expect(message.length).toBeGreaterThan(0);
        } else {
          // 翻译写回失败：不弹结果框，只弹一张 Host 取回卡，内容是译文（2026-09-27 定稿）；
          // 标题标明「翻译好了」（2.14.3-rc.6），且没有任何「已写入」类成功文案。
          const takebacks = () => host.cloudRequests.filter(request => request.method === "voice.deliver.present-takeback");
          await until(() => takebacks().length === 1, "The failed translation write-back presents one takeback card");
          const card = takebacks()[0]!.params as { title: string; reason: string; text: string };
          expect(card.title).toBe("翻译好了，但没能写入");
          expect(`${card.title}${card.reason}`).not.toContain("已写入");
          expect(card.text).toBe("这是测试 Agent 回复");
          message = card.reason;
          expect(host.voiceCommandRequests.some(request => request.method === "voice.command.present-answer")).toBeFalse();
          const history = await context!.storage.private("voice-state").get<VoiceCommandHistoryItem[]>(COMMAND_HISTORY_KEY);
          expect(history).toHaveLength(1);
          expect(history![0]!.reply).toBe("这是测试 Agent 回复");
          expect(history![0]!.transcript).toBe("测试语音命令");
          expect(history![0]!.status).toBe("completed");
        }
        if (failure.permission === "system") {
          expect(message).toContain("辅助功能");
          expect(message).not.toContain("已安装扩展");
        } else if (failure.permission === "plugin") {
          expect(message).toContain("已安装扩展");
          expect(message).not.toContain("辅助功能");
        } else {
          expect(message).not.toContain("权限");
          expect(message).not.toContain("VOICE_DELIVER_PERMISSION");
          expect(message).not.toContain("TRANSPORT_UNAVAILABLE");
          if (failure.unavailable && route === "translation") {
            // 取回卡带登记过的真实码（2.14.3-rc.6：不再抹成类别码），文案仍按「不可用」说明。
            expect(message).toEndWith(`（${failure.error!.code}）`);
          } else {
            expect(message).not.toContain("VOICE_DELIVER");
          }
          if (failure.unavailable) {
            expect(message).toContain("插件状态或更新");
          }
        }
        await new Promise(resolve => setTimeout(resolve, 20));
        expect(commits()).toHaveLength(1);
        if (route === "dictation" && failure.permission === "plugin") {
          const blocked = await host.invokeCommand(event);
          expect(blocked.ok).toBeFalse();
          expect(blocked.ok ? undefined : blocked.error.code).toBe("com.reai.voice/VOICE_DELIVER_PERMISSION_REQUIRED");
          expect(commits()).toHaveLength(1);
        }
        if (route === "dictation" && failure.permission !== "plugin") {
          const next = await host.invokeCommand(event);
          expect(next.ok, "A general failure must not falsely lock further recordings behind plugin permissions").toBeTrue();
          expect(next.ok ? next.output : next.error).toMatchObject({ phase: "listening" });
          // This is a new explicit user recording, not an automatic delivery retry.
          await host.invokeCommand(event);
          await until(() => commits().length === 2, "The explicit new recording completes");
          await new Promise(resolve => setTimeout(resolve, 10));
        }
      } finally {
        try {
          // The test runner shares app.ts's module; use the normal settings reset
          // so a deliberately denied capability does not leak to the next install.
          const settingsSurface = await host.openSurface("main");
          await host.invokeCommand("com.reai.voice.open-settings");
          for (const label of ["轻度", "原样"]) {
            const button = Array.from(settingsSurface.root!.querySelectorAll<HTMLButtonElement>(".settings-seg button"))
              .find(candidate => candidate.textContent === label);
            button?.click();
            await until(() => Array.from(settingsSurface.root!.querySelectorAll<HTMLButtonElement>(".settings-seg button"))
              .some(candidate => candidate.textContent === label && candidate.getAttribute("aria-checked") === "true"), "Reset only the test plugin's permission latch");
          }
        } finally {
          await host.disable();
          transport.handleRequest = original;
        }
      }
    });
  }
}
