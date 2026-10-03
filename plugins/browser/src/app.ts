/**
 * 浏览器插件 —— `browser.engine@1` 的授权消费者。
 *
 * 分工（与固件升级同一条边界）：远程内容的 child WebView 只有 Host 能建，
 * 插件 Surface 本身仍是 incognito + origin 锁死的隔离面。这里的职责是
 * 产品入口与操作面：主页快捷方式、当前标签一览、打开半屏抽屉；
 * Agent（pi 工具桥）与插件共用 Host 引擎的同一套操作。
 *
 * 界面语言跟随 Host（只读 `ctx.locale`），先设语言再挂载首屏；切换时只
 * 原位更新文字，不重建 Surface、不发任何 `browser.*` 业务请求。
 */
import { AppError, defineApp } from "@reai/app-sdk/v1";
import { browserCall } from "./browser-bridge";
import { setBrowserLocale, t } from "./browser-i18n";
import {
  applyBrowserHomeLocale,
  mountBrowserHome,
  refreshBrowserHome,
  type BrowserStateSummary,
} from "./browser-view";
import "./browser.css";

export default defineApp({
  async activate(ctx) {
    ctx.commands.register("com.reai.browser.open", async () => {
      // 语义只是「请求 Host 滑出抽屉」；真正开不开由 Host 的呈现层决定。
      await browserCall("browser.panel.open", {});
      return { status: "ok" as const };
    });

    ctx.surfaces.register("main", async (surface) => {
      const root = surface.root;
      try {
        // 先取 Host 语言快照再挂载，避免首屏先中文后闪换。
        setBrowserLocale(ctx.locale?.getSnapshot().locale ?? "zh");
        root.innerHTML = "";
        const home = mountBrowserHome(root, {
          onOpenDrawer: () => void browserCall("browser.panel.open", {}),
          onNewTab: (url) => void refreshStateAfterAction(url),
          onRefresh: () => void refreshState(),
          onSelectTab: (tabId) => {
            // 点「当前标签」里的一行，意图就是「看这个页面」：选中之外还要请
            // Host 展开右栏（panel.open 只是请求，开不开仍由 Host 呈现层决定）。
            void browserCall("browser.tab.select", { tabId }).catch(() => undefined);
            void browserCall("browser.panel.open", {})
              .catch(() => undefined)
              .then(() => refreshState());
          },
          onCloseTab: (tabId) =>
            void browserCall("browser.tab.close", { tabId })
              .catch(() => undefined)
              .then(() => refreshState()),
        });
        async function refreshState() {
          try {
            const state = await browserCall<BrowserStateSummary | null>("browser.state", {});
            refreshBrowserHome(home, state ?? null);
          } catch (cause) {
            // 受控错误只翻译本插件的标题；引擎原始诊断作为详情原样保留。
            refreshBrowserHome(home, null, String(cause));
          }
        }
        async function refreshStateAfterAction(url?: string) {
          try {
            await browserCall("browser.tab.new", url ? { url } : {});
          } catch {
            // 新标签失败也要刷新一次——主页展示的是引擎的事实，不是本地的期望。
          }
          await refreshState();
        }
        await refreshState();
        // Host 推的「引擎状态变了」轻通知：右栏/Agent 关了标签、换了页面，
        // 主页的「当前标签」列表要即时跟上，不再等用户手动点刷新。
        const stopStateNotify = surface.onIntent((raw) => {
          if (!raw || typeof raw !== "object") return;
          const intent = raw as { source?: unknown; type?: unknown };
          if (intent.source === "host.browser" && intent.type === "state-changed") {
            void refreshState();
          }
        });
        // onChange 会立即回放当前快照；applyBrowserHomeLocale 必须可重复调用，
        // 且只改文字，不触发任何 browser.* 业务调用。
        const stopLocale = ctx.locale?.onChange(({ locale }) => {
          setBrowserLocale(locale);
          applyBrowserHomeLocale(home);
        });
        surface.ready();
        return () => {
          stopLocale?.();
          stopStateNotify();
          root.replaceChildren();
        };
      } catch (cause) {
        surface.fail(
          new AppError({
            code: "com.reai.browser/HOME_MOUNT_FAILED",
            userMessage: t("errors.homeMountFailed"),
            retryable: true,
            cause,
          }),
        );
        // fail 之后 cleanup 仍要返回，保证 unmount 不留残余。
        return () => root.replaceChildren();
      }
    });
  },
});
