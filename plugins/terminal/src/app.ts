import { createTerminalMessages } from "./terminal-i18n";
import {
  AppError,
  defineApp,
  type HostTitlebarActionIntent,
  type TerminalSessionEvent,
} from "@reai/app-sdk/v1";
import { mountTerminalWorkspace, type TerminalWorkspace } from "./terminal-workspace";
import { mountTerminalSettings, type TerminalSettingsView } from "./terminal-settings";
import { TerminalPreferencesStore } from "./terminal-preferences";
import "./terminal.css";
import "./terminal-settings.css";

interface TerminalAppView {
  openSettings(): void;
  navigateRoot(): void;
}

export default defineApp({
  async activate(ctx) {
    const messages = createTerminalMessages(ctx.locale);
    let workspace: TerminalWorkspace | undefined;
    let activeView: TerminalAppView | undefined;
    const preferences = new TerminalPreferencesStore(ctx.storage.private("terminal-preferences"));
    await preferences.load().catch(() => undefined);
    ctx.terminal.onEvent((event: TerminalSessionEvent) => workspace?.accept(event));

    ctx.commands.register("com.reai.terminal.back-to-root", async () => {
      if (!activeView) throw new AppError({
        code: "com.reai.terminal/NO_ACTIVE_VIEW",
        userMessage: messages.t("noView"),
        retryable: true,
      });
      activeView.navigateRoot();
      return {};
    });

    ctx.surfaces.register("main", async (surface) => {
      let settings: TerminalSettingsView | undefined;
      try {
        surface.root.innerHTML = '<div class="terminal-view-host" data-terminal-view="root"></div><div class="terminal-view-host" data-terminal-view="settings" hidden></div>';
        const rootView = surface.root.querySelector<HTMLElement>('[data-terminal-view="root"]')!;
        const settingsView = surface.root.querySelector<HTMLElement>('[data-terminal-view="settings"]')!;
        workspace = await mountTerminalWorkspace(rootView, ctx.terminal, preferences, messages);
        settings = mountTerminalSettings(settingsView, preferences, messages);
        const view: TerminalAppView = {
          openSettings() {
            rootView.hidden = true;
            settingsView.hidden = false;
            surface.reportNav?.({ key: "settings", label: messages.t("common.settings") });
          },
          navigateRoot() {
            settingsView.hidden = true;
            rootView.hidden = false;
            surface.reportNav?.(null);
            workspace?.refresh();
          },
        };
        activeView = view;
        const applyTitlebarIntent = (raw: unknown) => {
          const intent = raw as Partial<HostTitlebarActionIntent<{ type?: unknown }>> | null;
          if (intent?.source !== "host.titlebarAction") return;
          if (intent.actionId === "restart" && intent.payload?.type === "restart-active") {
            void workspace?.restartActive();
          } else if (intent.actionId === "stop" && intent.payload?.type === "stop-active") {
            void workspace?.stopActive();
          } else if (intent.actionId === "settings" && intent.payload?.type === "open-settings") {
            view.openSettings();
          }
        };
        applyTitlebarIntent(surface.initialIntent);
        const stopIntent = surface.onIntent(applyTitlebarIntent);
        const stopLocale = messages.subscribe(() => {
          if (!settingsView.hidden) surface.reportNav?.({ key: "settings", label: messages.t("common.settings") });
        });
        surface.ready();
        return async () => {
          stopIntent();
          stopLocale();
          if (activeView === view) activeView = undefined;
          settings?.dispose();
          settings = undefined;
          const current = workspace;
          workspace = undefined;
          await current?.dispose();
        };
      } catch (cause) {
        surface.fail(new AppError({
          code: "com.reai.terminal/MOUNT_FAILED",
          userMessage: messages.t("mountFailed"),
          retryable: true,
          cause,
        }));
        return () => surface.root.replaceChildren();
      }
    });
  },
});
