import { t, setLocale } from "./i18n";
import {
  defineApp,
  type HostTitlebarActionIntent,
  type PiManagementSettings,
  type PiManagementSnapshot,
} from "@reai/app-sdk/v1";

import { mountPiAgentView, type PiAgentView } from "./pi-agent-view";
import "./pi-agent.css";

const isSettingsIntent = (value: unknown): value is HostTitlebarActionIntent<{ type: "open-settings" }> => {
  if (!value || typeof value !== "object") return false;
  const intent = value as { source?: unknown; actionId?: unknown; payload?: { type?: unknown } };
  return intent.source === "host.titlebarAction" &&
    intent.actionId === "settings" && intent.payload?.type === "open-settings";
};

export default defineApp({
  async activate(ctx) {
    setLocale(ctx.locale?.getSnapshot().locale ?? "zh");
    let activeView: PiAgentView | undefined;
    ctx.commands.register("com.reai.pi-agent.back-to-root", async () => {
      if (!activeView) throw new Error(t("ui.m002"));
      activeView.navigateRoot();
      return {};
    });

    ctx.surfaces.register("main", async (surface) => {
      let view: PiAgentView | undefined;
      let stopped = false;
      let currentPage: "main" | "settings" = "main";
      let saveChain = Promise.resolve();
      let refreshVersion = 0;

      const load = async (): Promise<void> => {
        const version = ++refreshVersion;
        const [snapshot, models] = await Promise.all([
          ctx.piManagement.snapshot(),
          ctx.piManagement.models(),
        ]);
        if (!stopped && version === refreshVersion) view?.update(snapshot, models);
      };

      const save = async (settings: PiManagementSettings): Promise<void> => {
        const pending = saveChain.then(async () => {
          ++refreshVersion;
          await ctx.piManagement.updateSettings(settings);
          await load();
        });
        saveChain = pending.catch(() => undefined);
        await pending;
      };

      try {
        const [snapshot, models] = await Promise.all([
          ctx.piManagement.snapshot(),
          ctx.piManagement.models(),
        ]);
        if (snapshot.sessions[0]) {
          try {
            Object.assign(snapshot.sessions[0], await ctx.piManagement.session(snapshot.sessions[0].sessionId));
          } catch {
            // 摘要返回后会话可能恰好被 one-shot 清理；列表仍应能打开，下一次刷新会收敛。
          }
        }
        setLocale(ctx.locale?.getSnapshot().locale ?? "zh");
        view = mountPiAgentView(surface.root, snapshot, models, {
          onRefresh: load,
          onSelect: (sessionId) => ctx.piManagement.session(sessionId),
          onSaveSettings: save,
          onNavigate: (page) => {
            currentPage = page;
            if (typeof surface.reportNav === "function") {
              surface.reportNav(page === "settings" ? { key: "settings", label: t("common.settings") } : null);
            }
          },
        });
        activeView = view;
        if (isSettingsIntent(surface.initialIntent)) view.showSettings();
        else if (typeof surface.reportNav === "function") surface.reportNav(null);
        surface.ready();
      } catch (error) {
        surface.fail(error);
        return;
      }

      const stopLocale = ctx.locale?.onChange(({ locale }) => {
        if (!setLocale(locale)) return;
        view?.refreshLocale();
        if (currentPage === "settings") surface.reportNav?.({ key: "settings", label: t("common.settings") });
      });

      const stopIntent = surface.onIntent((intent) => {
        if (isSettingsIntent(intent)) view?.showSettings();
      });
      let poll: number | undefined;
      const syncPolling = (): void => {
        if (poll !== undefined) window.clearInterval(poll);
        poll = undefined;
        if (document.visibilityState !== "visible") return;
        poll = window.setInterval(() => {
          // 设置页也轮询：登录状态/模型档位在页面打开期间会变化（登录、登出、
          // 档位目录刷新），不能等导航回来才更新 chip 与禁用门禁。
          if (currentPage === "main" || currentPage === "settings") {
            void load().catch((error) => view?.showError(error));
          }
        }, 2_000);
      };
      document.addEventListener("visibilitychange", syncPolling);
      syncPolling();

      return () => {
        stopped = true;
        if (poll !== undefined) window.clearInterval(poll);
        document.removeEventListener("visibilitychange", syncPolling);
        stopLocale?.();
        stopIntent();
        if (activeView === view) activeView = undefined;
        view?.destroy();
      };
    });
  },
});
