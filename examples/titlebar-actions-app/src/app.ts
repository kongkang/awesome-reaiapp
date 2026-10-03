import "./app.css";
import { createMessages } from "./i18n";
import { defineApp, type HostTitlebarActionIntent } from "@reai/app-sdk/v1";

type DemoPayload = { type: "mark-clicked" };
type DemoIntent = HostTitlebarActionIntent<DemoPayload>;

function isDemoIntent(value: unknown): value is DemoIntent {
  if (!value || typeof value !== "object") return false;
  const intent = value as {
    source?: unknown;
    actionId?: unknown;
    payload?: { type?: unknown };
  };
  return intent.source === "host.titlebarAction"
    && intent.actionId === "mark-clicked"
    && intent.payload?.type === "mark-clicked";
}

export default defineApp({
  async activate(ctx) {
    ctx.surfaces.register<DemoIntent>("main", async (surface) => {
      const document = surface.root.ownerDocument;
      const frame = document.createElement("section");
      frame.className = "plugin-main-frame";
      const page = document.createElement("main");
      page.className = "main-body";
      page.style.cssText = [
        "min-height:0",
        "box-sizing:border-box",
        "padding:12px 40px 40px",
        "font-family:system-ui,sans-serif",
        "color:#25243a",
        "background:linear-gradient(145deg,#fbfbff,#f2f1ff)",
      ].join(";");

      // 面包屑已经显示插件名，正文首容器不再自画与 App 名重复的大标题
      // （plugin-design-system-v1 §4.5/§4.6）。
      const help = document.createElement("p");

      const status = document.createElement("strong");
      status.dataset.titlebarDemoStatus = "idle";
      const messages = createMessages(ctx.locale);
      const render = () => {
        help.textContent = messages.t("help");
        status.textContent = messages.t(status.dataset.titlebarDemoStatus === "clicked" ? "clicked" : "idle");
      };
      const stopLocale = messages.subscribe(render);
      status.style.cssText = "display:block;margin-top:24px;color:#6561df";
      page.append(help, status);
      frame.appendChild(page);
      surface.root.replaceChildren(frame);

      const applyIntent = (intent: unknown) => {
        if (!isDemoIntent(intent)) return;
        status.dataset.titlebarDemoStatus = "clicked";
        render();
      };
      applyIntent(surface.initialIntent);
      const stopIntent = surface.onIntent(applyIntent);
      surface.ready();

      return () => {
        stopIntent();
        stopLocale();
        surface.root.replaceChildren();
      };
    });
  },

  async deactivate() {},
});
