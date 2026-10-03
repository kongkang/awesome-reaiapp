/**
 * ni.chat —— 人类使用的 ni-chat IM 客户端入口。
 *
 * Surface 只负责渲染和提交 IM adapter 动作；它不承载 Agent runtime、工具执行、
 * provider 编排或任务插件。Phase 0 的 adapter 是显式 Mock，真实传输由未来 Host Broker 提供。
 */
import { defineApp } from "@reai/app-sdk/v1";
import {
  mountAgentsImView,
  isAttachContextIntent,
  isOpenConversationIntent,
  type AgentsImView,
} from "./agents-im-view";
import "@reai/ni-chat-ui/styles.css";
import "./agents-im.css";

export default defineApp({
  async activate(ctx) {
    ctx.surfaces.register("main", async (surface) => {
      let view: AgentsImView | undefined;
      // 「发给 agent」跨 App intent（A3-24）：Voice 的现场记录以附件形态落进
      // 输入侧。先挂好视图再注册——冷启动窗口里 SDK 的 pendingIntent 会补发
      // 最后一条，不丢（codex-link 同款次序）。
      const applyIntent = (intent: unknown) => {
        if (!view) return;
        if (isAttachContextIntent(intent)) {
          view.attachExternalContext({
            label: intent.label,
            text: intent.text,
          });
          return;
        }
        // B6-26「在 IM 里看上下文」：按 agent 身份落会话。找不到对应会话时
        // 保持当前选择态（intent 已被 Host 接受、目标侧如实不落地——PR 登记）。
        if (isOpenConversationIntent(intent)) {
          view.openConversationByAgent({ agentId: intent.agentId, agentName: intent.agentName });
        }
      };
      try {
        view = await mountAgentsImView(surface.root);
        applyIntent(surface.initialIntent);
        surface.onIntent(applyIntent);
        surface.ready();
      } catch (cause) {
        view?.dispose();
        surface.fail(new Error("ni.chat 界面无法启动", { cause }));
        return;
      }
      return () => view?.dispose();
    });
  },
  async deactivate() {},
});
