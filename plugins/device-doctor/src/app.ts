/**
 * 设备诊断助手 —— 本地 agent 内核（`agent.local@1`）的首发消费者。
 *
 * Host 只提供机制（进程、回环、只读工具、模型通道）；「你是设备诊断助手、
 * 遇到 X 先查 Y」这类提示词与界面都归本插件。
 */

import "@reai/agent-ui/styles.css";
import "./doctor.css";

import {
  AppError,
  defineApp,
  describeLocalAgentError,
  type KeyValueStore,
} from "@reai/app-sdk/v1";
import {
  createDoctorSnapshot,
  errorText,
  persistable,
  pushUserMessage,
  reduceEvent,
  restoreSnapshot,
  settleWithAnswer,
  type DoctorSnapshot,
} from "./doctor-model";
import { mountDoctorView, type DoctorView } from "./doctor-view";

let snapshot: DoctorSnapshot = createDoctorSnapshot();
let store: KeyValueStore | undefined;
const mountedViews = new Set<DoctorView>();

function syncViews() {
  for (const view of mountedViews) view.render(snapshot);
}

/** 状态一变就落 KV：插件切走会销毁运行时，内存态撑不过去。 */
function persist() {
  if (store) {
    void store
      .set("conversation", persistable(snapshot))
      .catch((error) => console.error("[doctor-persist] 失败", error));
  }
}

export default defineApp({
  async activate(ctx) {
    store = ctx.storage.private("doctor-state");
    try {
      const saved = await store.get<ReturnType<typeof persistable>>("conversation");
      if (saved) snapshot = restoreSnapshot(saved);
    } catch {
      // 读不到历史不影响使用，从空会话开始。
    }

    // 进度事件只更新对话流：终局由 send() 的返回值兜底，事件丢一两条不影响答案。
    ctx.events.onLocalAgent((event) => {
      console.log("[doctor-event]", JSON.stringify(event).slice(0, 200));
      snapshot = reduceEvent(snapshot, event);
      // 续文块是打字机动画帧：原地更新最后一条气泡（不重建流、不逐块写盘）；
      // 终局与非续文事件才走全量渲染 + 落 KV。
      if (event.type === "message" && event.append) {
        const tail = snapshot.agent.stream[snapshot.agent.stream.length - 1];
        const merged = tail?.k === "msg" ? tail.text : "";
        for (const view of mountedViews) view.appendToLastMessage(merged);
        return;
      }
      persist();
      syncViews();
    });

    ctx.surfaces.register("main", async (surface) => {
      let view: DoctorView | undefined;
      try {
        view = mountDoctorView(surface.root, {
          placeholder: "描述你遇到的问题，例如「键盘插上了但一点反应都没有」",
          async onSend(text) {
            snapshot = reduceEvent(pushUserMessage(snapshot, text), {
              type: "turn.started",
            });
            persist();
            syncViews();
            try {
              const { answer } = await ctx.localAgent.send({ message: text });
              snapshot = settleWithAnswer(snapshot, answer);
            } catch (cause) {
              const code = (cause as { code?: string })?.code ?? "";
              const info = describeLocalAgentError(code);
              const text = errorText(info.code);
              // 失败文案必须总是显示（不像答案有去重逻辑）。
              const settled = reduceEvent(snapshot, {
                type: "turn.settled",
                ok: true,
              });
              snapshot = reduceEvent(settled, { type: "message", text });
            }
            persist();
            syncViews();
          },
          onCancel() {
            void ctx.localAgent.cancel().catch(() => undefined);
          },
        });
        mountedViews.add(view);
        view.render(snapshot);
        surface.ready();
      } catch (cause) {
        surface.fail(
          new AppError({
            code: "com.reai.device-doctor/SURFACE_INIT_FAILED",
            userMessage: "无法打开设备诊断助手",
            retryable: true,
            cause,
          }),
        );
        return;
      }
      return () => {
        if (view) mountedViews.delete(view);
        view?.dispose();
      };
    });
  },

  async deactivate() {
    for (const view of mountedViews) view.dispose();
    mountedViews.clear();
  },
});
