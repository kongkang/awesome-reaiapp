import { defineApp } from "@reai/app-sdk/v1";

const FOCUS_INTENT = "focus-input";

export default defineApp({
  async activate(ctx) {
    const store = ctx.storage.private("probe");

    ctx.commands.register("com.reai.install-probe.open", async ({ signal }) => {
      await store.set("last-command", "open");
      await ctx.surfaces.open("main", { intent: { type: FOCUS_INTENT } }, { signal });
      return { status: "ok" };
    });

    ctx.surfaces.register("main", (surface) => {
      const input = document.createElement("input");
      input.id = "install-probe-input";
      input.setAttribute("aria-label", "Install probe input");
      surface.root.replaceChildren(input);

      const applyIntent = (intent: unknown) => {
        if ((intent as { type?: unknown } | undefined)?.type === FOCUS_INTENT) input.focus();
      };
      applyIntent(surface.initialIntent);
      const offIntent = surface.onIntent(applyIntent);
      surface.ready();

      return () => {
        offIntent();
        input.remove();
      };
    });
  },
});
