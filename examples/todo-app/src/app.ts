import { AppError, defineApp, type HostTitlebarActionIntent } from "@reai/app-sdk/v1";
import "@reai/agent-ui/styles.css";
import { createMockTodoWorkflow } from "./mock-workflow";
import { TodoStateCoordinator } from "./state-coordinator";
import { migrateTodoState, type ConversationKey } from "./todo-model";
import { mountTodoView, type TodoIntent } from "./todo-view";
import "./todo.css";

type AssistantCommandInput = { conversationKey?: ConversationKey };

function isTodoIntent(value: unknown): value is TodoIntent {
  if (!value || typeof value !== "object" || !("type" in value)) return false;
  const intent = value as { type?: unknown; conversationKey?: unknown };
  if (intent.type === "new-task") return true;
  if (intent.type !== "open-assistant" && intent.type !== "talk-to-assistant") return false;
  return intent.conversationKey === undefined
    || intent.conversationKey === "app"
    || (typeof intent.conversationKey === "string" && intent.conversationKey.startsWith("task:") && intent.conversationKey.length > 5);
}

function todoIntentFrom(value: unknown): TodoIntent | undefined {
  if (isTodoIntent(value)) return value;
  const titlebar = value as HostTitlebarActionIntent<TodoIntent> | null | undefined;
  if (titlebar?.source !== "host.titlebarAction") return undefined;
  if (titlebar.actionId !== "new-task" && titlebar.actionId !== "assistant") return undefined;
  return isTodoIntent(titlebar.payload) ? titlebar.payload : undefined;
}

export default defineApp({
  async activate(ctx) {
    const tasks = ctx.storage.private("tasks");

    ctx.commands.register("com.example.todo.new", async ({ signal }) => {
      await ctx.surfaces.open("main", { intent: { type: "new-task" } satisfies TodoIntent }, { signal });
      return { status: "ok" };
    });

    ctx.commands.register<AssistantCommandInput, { status: "ok" }>("com.example.todo.assistant.open", async ({ input, signal }) => {
      await ctx.surfaces.open("main", {
        intent: {
          type: "open-assistant",
          ...(input.conversationKey ? { conversationKey: input.conversationKey } : {}),
        } satisfies TodoIntent,
      }, { signal });
      return { status: "ok" };
    });

    ctx.commands.register<AssistantCommandInput, { status: "ok" }>("com.example.todo.assistant.talk", async ({ input, signal }) => {
      await ctx.surfaces.open("main", {
        intent: {
          type: "talk-to-assistant",
          ...(input.conversationKey ? { conversationKey: input.conversationKey } : {}),
        } satisfies TodoIntent,
      }, { signal });
      return { status: "ok" };
    });

    ctx.surfaces.register("main", async (surface) => {
      let stored: unknown;
      try {
        stored = await tasks.get<unknown>("state");
        if (stored === undefined || stored === null) stored = await tasks.get<unknown>("items");
      } catch (cause) {
        surface.fail(new AppError({
          code: "com.example.todo/STORAGE_READ_FAILED",
          userMessage: "无法读取日程",
          retryable: true,
          cause,
        }));
        return;
      }

      const coordinator = new TodoStateCoordinator(migrateTodoState(stored), (state) => tasks.set("state", state));
      let view: ReturnType<typeof mountTodoView> | undefined;
      let offState: (() => void) | undefined;
      let offIntent: (() => void) | undefined;
      const workflow = createMockTodoWorkflow({
        onPush: async (envelope) => {
          const duplicate = coordinator.current.processedEventIds.includes(envelope.eventId);
          await coordinator.applyPush(envelope);
          if (!duplicate && envelope.kind === "client_action") {
            view?.applyIntent({
              type: "talk-to-assistant",
              ...(envelope.payload?.conversationKey ? { conversationKey: envelope.payload.conversationKey } : {}),
            });
          }
        },
      });
      try {
        const mounted = mountTodoView(surface.root, {
          state: coordinator.current,
          updateState: (reducer) => coordinator.update(reducer),
          enqueueAnalysis: (node, supplement) => workflow.enqueue(node, supplement),
          answerAgent: (node, text) => workflow.answer(node, text),
          onPersistenceError: (cause) => surface.reportError(new AppError({
            code: "com.example.todo/STORAGE_WRITE_FAILED",
            userMessage: "保存失败，请重试。",
            retryable: true,
            cause,
          })),
        });
        view = mounted;
        offState = coordinator.subscribe((state) => mounted.setState(state));
        const applyIntent = (intent?: unknown) => {
          const todoIntent = todoIntentFrom(intent);
          if (todoIntent) mounted.applyIntent(todoIntent);
        };
        applyIntent(surface.initialIntent);
        offIntent = surface.onIntent(applyIntent);
        surface.ready();
      } catch (cause) {
        offState?.();
        offIntent?.();
        workflow.dispose();
        view?.dispose();
        surface.fail(new AppError({
          code: "com.example.todo/SURFACE_INIT_FAILED",
          userMessage: "无法打开日程",
          retryable: true,
          cause,
        }));
        return;
      }

      return () => {
        offState?.();
        offIntent?.();
        workflow.dispose();
        view?.dispose();
      };
    });
  },

  async deactivate() {
    // SDK 撤销注册；每个 Surface 的清理函数负责释放工作流、订阅和 DOM 监听器。
  },
});
