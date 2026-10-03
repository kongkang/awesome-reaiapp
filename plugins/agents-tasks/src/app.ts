/**
 * Agents · 任务 —— 插件入口。
 *
 * 走标准插件接入：defineApp + ctx.surfaces.register("main")。任务从共享 Agent 流的
 * anchor 动态派生，详情复用 IM 会话流与输入坞，不再维护第二份任务数据。
 *
 * B6-26：任务详情坞「在 IM 里看上下文」——ctx.apps.status 门控可用性，
 * ctx.apps.open 走 `open-conversation` intent 跳到 Agents·IM 的对应会话。
 * B6-27：titlebar「新增项目」（manifest titlebarActions 贡献）的 intent 在这里解包。
 */
import { defineApp, type HostTitlebarActionIntent } from "@reai/app-sdk/v1";
import { mountTasksView, type TasksView } from "./tasks-view";
import type { AgentTask } from "@reai/agent-ui";
import "@reai/agent-ui/styles.css";
import "./tasks.css";

const AGENTS_IM_APP_ID = "com.reai.agents-im";
const AGENTS_IM_OPEN_CONVERSATION_INTENT = "open-conversation";

/** titlebar / 测试共用的插件内 intent 形状（B6-27）。 */
export interface TasksIntent {
  type: "add-project";
}

export function tasksIntentFrom(value: unknown): TasksIntent | undefined {
  const direct = value as { type?: unknown } | null | undefined;
  if (direct && typeof direct === "object" && direct.type === "add-project") {
    return { type: "add-project" };
  }
  const titlebar = value as HostTitlebarActionIntent<TasksIntent> | null | undefined;
  if (titlebar?.source !== "host.titlebarAction") return undefined;
  if (titlebar.actionId !== "add-project") return undefined;
  return titlebar.payload?.type === "add-project" ? { type: "add-project" } : undefined;
}

export default defineApp({
  async activate(ctx) {
    ctx.surfaces.register("main", async (surface) => {
      let view: TasksView | undefined;
      /* B6-26 门控：问一次 Host「ni.chat 装没装」。失败（能力不可用、Host 更老）
         就沿用上一次的结果——「读不到」不等于「没装」，不能把入口凭空藏掉；
         从未采到过就保持不可用（按钮不渲染，不画假门）。 */
      let agentsImAvailable = false;
      let agentsImStatusSeq = 0;
      const refreshAgentsImAvailability = async () => {
        const seq = ++agentsImStatusSeq;
        try {
          const status = await ctx.apps.status({ appId: AGENTS_IM_APP_ID });
          if (seq !== agentsImStatusSeq) return;
          agentsImAvailable = status.installed && status.enabled;
        } catch {
          // 保持上一次采样。
        }
        view?.setAgentsIm({ available: agentsImAvailable, open: openTaskInAgentsIm });
      };
      const openTaskInAgentsIm = async (task: AgentTask) => {
        try {
          await ctx.apps.open(
            { appId: AGENTS_IM_APP_ID, intent: AGENTS_IM_OPEN_CONVERSATION_INTENT },
            { agentId: task.agentId, agentName: task.agentName },
          );
        } catch (cause) {
          // 门控状态可能已经变了（刚被卸载/停用）：顺手回读一次，让按钮如实消失。
          const code = (cause as { code?: unknown } | null | undefined)?.code;
          if (code === "APP_INTENT_TARGET_NOT_INSTALLED" || code === "INTENT_TARGET_FAILED") {
            void refreshAgentsImAvailability();
          } else {
            surface.reportError(new Error("在 IM 里看上下文：暂时打不开 ni.chat", { cause }));
          }
        }
      };
      try {
        view = mountTasksView(surface.root, {
          agentsIm: { available: false, open: (task) => void openTaskInAgentsIm(task) },
        });
        const applyIntent = (intent: unknown) => {
          const next = tasksIntentFrom(intent);
          if (next) view?.applyIntent(next);
        };
        applyIntent(surface.initialIntent);
        surface.onIntent(applyIntent);
        surface.ready();
        void refreshAgentsImAvailability();
      } catch (cause) {
        view?.dispose();
        surface.fail(new Error("Agents · 任务界面起不来", { cause }));
        return;
      }
      return () => {
        view?.dispose();
      };
    });
  },
  async deactivate() {},
});
