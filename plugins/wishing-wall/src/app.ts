import { AppError, defineApp, type AppContext } from "@reai/app-sdk/v1";
import { mountWishingWallView } from "./wishing-wall-view";
import "./wishing-wall.css";

/**
 * AI许愿墙 —— 桌面端保存本地草稿、只读浏览公开愿望，扫码到手机端发布。
 *
 * on-demand 激活：侧栏点进来才 mount。无 commands（v1 不绑硬件键）。
 * 网络只经 Host Broker GET `/api/home`；不读取 ReAI 身份，也不上传桌面端草稿。
 */
export default defineApp({
  async activate(ctx: AppContext) {
    ctx.surfaces.register("main", async (surface) => {
      let view: ReturnType<typeof mountWishingWallView> | undefined;
      try {
        view = mountWishingWallView(surface.root, ctx);
        surface.ready();
      } catch (cause) {
        surface.fail(
          new AppError({
            code: "com.reai.wishing-wall/SURFACE_INIT_FAILED",
            userMessage: "无法打开 AI许愿墙",
            retryable: true,
            cause,
          }),
        );
        return;
      }
      return () => view?.dispose();
    });
  },

  async deactivate() {},
});
