import { t, setLocale } from "./i18n";
import { defineApp, type HostTitlebarActionIntent } from "@reai/app-sdk/v1";
import { mountDshObserverView, type DshObserverView } from "./dsh-observer-view";
import "./dsh-observer.css";

type RefreshIntent = HostTitlebarActionIntent<{ type: "refresh" }>;
type SettingsIntent = HostTitlebarActionIntent<{ type: "open-settings" }>;
const isRefreshIntent = (value: unknown): value is RefreshIntent => {
  if (!value || typeof value !== "object") return false;
  const intent = value as { source?: unknown; actionId?: unknown; payload?: { type?: unknown } };
  return intent.source === "host.titlebarAction" && intent.actionId === "refresh" &&
    intent.payload?.type === "refresh";
};

const isSettingsIntent = (value: unknown): value is SettingsIntent => {
  if (!value || typeof value !== "object") return false;
  const intent = value as { source?: unknown; actionId?: unknown; payload?: { type?: unknown } };
  return intent.source === "host.titlebarAction" && intent.actionId === "settings" &&
    intent.payload?.type === "open-settings";
};

export default defineApp({
  async activate(ctx) {
    setLocale(ctx.locale?.getSnapshot().locale ?? "zh");
    let activeView: DshObserverView | undefined;
    ctx.commands.register("com.reai.dsh-agent.back-to-root", async () => {
      if (!activeView) throw new Error(t("ui.m002"));
      activeView.navigateRoot();
      return {};
    });

    ctx.surfaces.register("main", async (surface) => {
      let view: DshObserverView | undefined;
      let stopped = false;
      let refreshGeneration = 0;
      let currentPage: "main" | "settings" = "main";
      let saveChain: Promise<unknown> = Promise.resolve();

      const refreshSnapshot = async (): Promise<void> => {
        const generation = ++refreshGeneration;
        const snapshot = await ctx.dshObserver.snapshot();
        if (!stopped && generation === refreshGeneration) view?.update(snapshot);
      };

      const refresh = async (): Promise<void> => {
        if (currentPage === "settings") {
          await Promise.all([refreshSnapshot(), view?.refreshSettings()]);
          return;
        }
        await refreshSnapshot();
      };

      const updateSettings = (modelAlias: string) => {
        const pending = saveChain.then(() => ctx.dshObserver.updateSettings(modelAlias));
        saveChain = pending.catch(() => undefined);
        return pending;
      };

      try {
        const snapshot = await ctx.dshObserver.snapshot();
        if (stopped) return;
        setLocale(ctx.locale?.getSnapshot().locale ?? "zh");
        view = mountDshObserverView(surface.root, snapshot, {
          refresh,
          sessionDetail: (sessionId) => ctx.dshObserver.sessionDetail(sessionId),
          historyPage: (sessionId, cursor, limit) =>
            ctx.dshObserver.historyPage(sessionId, cursor, limit),
          settings: () => ctx.dshObserver.settings(),
          updateSettings,
          onNavigate: (page) => {
            currentPage = page;
            surface.reportNav?.(page === "settings" ? { key: "settings", label: t("common.settings") } : null);
          },
        });
        activeView = view;
        surface.reportNav?.(null);
        if (isSettingsIntent(surface.initialIntent)) {
          void view.showSettings().catch((error) => view?.showError(error));
        }
        surface.ready();
      } catch (error) {
        surface.fail(error);
        return;
      }

      if (isRefreshIntent(surface.initialIntent)) {
        void refresh().catch((error) => view?.showError(error));
      }
      const stopLocale = ctx.locale?.onChange(({ locale }) => {
        if (!setLocale(locale)) return;
        view?.refreshLocale();
        if (currentPage === "settings") surface.reportNav?.({ key: "settings", label: t("common.settings") });
      });

      const stopIntent = surface.onIntent((intent) => {
        if (isRefreshIntent(intent)) void refresh().catch((error) => view?.showError(error));
        if (isSettingsIntent(intent)) void view?.showSettings().catch((error) => view?.showError(error));
      });

      let poll: number | undefined;
      const syncPolling = (): void => {
        if (poll !== undefined) window.clearInterval(poll);
        poll = undefined;
        if (document.visibilityState !== "visible") return;
        poll = window.setInterval(() => {
          if (currentPage === "main") void refreshSnapshot().catch((error) => view?.showError(error));
        }, 2_000);
      };
      document.addEventListener("visibilitychange", syncPolling);
      syncPolling();

      return () => {
        stopped = true;
        ++refreshGeneration;
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
