/** 工具链测试用的最小 App。刻意不碰 DOM，好让协议级断言在无 DOM 环境也能跑。 */

import { defineApp } from "@reai/app-sdk/v1";

export default defineApp({
  async activate(ctx) {
    const notes = ctx.storage.private("notes");

    ctx.commands.register("com.example.minimal.ping", async () => {
      await notes.set("last-ping", "ok");
      return { status: "ok" };
    });

    ctx.surfaces.register("main", (surface) => {
      surface.ready();
      return () => undefined;
    });
  },
});
