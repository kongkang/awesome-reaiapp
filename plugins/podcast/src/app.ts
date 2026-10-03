/**
 * AI Podcast —— 插件入口。
 *
 * 走标准插件接入：defineApp + ctx.surfaces.register。宿主打开 surface "main" 时
 * 把 mountPodcastView 渲染进 surface.root，调 surface.ready() 宣告就绪。
 *
 * 语言：activate 先读 Host locale 快照再注册 surface（先设语言后渲染首屏），
 * 并订阅 onChange 同步模块词典；每个视图独立订阅渲染时机，销毁时自行释放。
 * 老宿主没有 ctx.locale 时按历史默认中文。
 *
 * 纯静态演示：数据写死（data.ts），不真播音频、不连后端。后续补功能时把
 * mountPodcastView 换成真实播放逻辑即可，接入方式不变。
 */
import { defineApp, type HostTitlebarActionIntent } from "@reai/app-sdk/v1";
import { mountPodcastView, type PodcastView } from "./podcast-view";
import { setPodcastLocale, t } from "./podcast-i18n";
import "./podcast.css";

let stopLocaleListener: (() => void) | undefined;

function isHistoryIntent(
  value: unknown,
): value is HostTitlebarActionIntent<{ type: "toggle-history" }> {
  if (!value || typeof value !== "object") return false;
  const intent = value as {
    source?: unknown;
    actionId?: unknown;
    payload?: { type?: unknown };
  };
  return intent.source === "host.titlebarAction"
    && intent.actionId === "history"
    && intent.payload?.type === "toggle-history";
}

export default defineApp({
  async activate(ctx) {
    stopLocaleListener?.();
    setPodcastLocale(ctx.locale?.getSnapshot().locale ?? "zh");
    stopLocaleListener = ctx.locale?.onChange(({ locale }) => setPodcastLocale(locale));
    ctx.surfaces.register("main", async (surface) => {
      let view: PodcastView | undefined;
      const applyIntent = (intent: unknown) => {
        if (isHistoryIntent(intent)) view?.toggleHistory(true);
      };
      const stopIntent = surface.onIntent(applyIntent);
      try {
        view = mountPodcastView(surface.root);
        applyIntent(surface.initialIntent);
        surface.ready();
      } catch (cause) {
        stopIntent();
        view?.dispose();
        surface.fail(new Error(t("view.startupFailed"), { cause }));
        return;
      }
      return () => {
        stopIntent();
        view?.dispose();
      };
    });
  },
  async deactivate() {
    stopLocaleListener?.();
    stopLocaleListener = undefined;
  },
});
