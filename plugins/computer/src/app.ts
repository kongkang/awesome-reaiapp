/**
 * 电脑操控插件 —— `computer.engine@1` 的授权消费者。
 *
 * 分工（与 browser 插件同一条边界）：截图 / 鼠标键盘注入 / 安全线全在 Host
 * 引擎（src/computer），插件 Surface 只是产品脸面：权限引导、紧急停止、
 * 任务控制台（内置演示 Agent 循环，视觉决策走 Host 云通道 ai.text.generate，
 * 凭据归登录账号、插件不接触 API key）与操作审计。pi/DSH 工具桥与这里共用
 * Host 引擎的同一套操作。
 */
import { AppError, defineApp } from "@reai/app-sdk/v1";
import { computerCall } from "./computer-bridge";
import type { ComputerState, PermissionsStatus } from "./computer-bridge";
import { mountComputerHome, type ComputerHome } from "./computer-view";
import { DEFAULT_VLM_CONFIG, describeError, runComputerTask, type VlmConfig } from "./agent-loop";
import "./computer.css";

const VLM_CONFIG_KEY = "vlm-config";

interface StoredVlmConfig {
  /** 旧版直连端点的字段（baseUrl/model/apiKey）已废弃，读取时忽略。 */
  modelAlias?: string;
}

async function loadVlmConfig(store: {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
}): Promise<VlmConfig> {
  try {
    const raw = (await store.get(VLM_CONFIG_KEY)) as StoredVlmConfig | null;
    return {
      modelAlias: raw?.modelAlias?.trim() || DEFAULT_VLM_CONFIG.modelAlias,
    };
  } catch {
    return { ...DEFAULT_VLM_CONFIG };
  }
}

export default defineApp({
  async activate(ctx) {
    // 紧急停止做成 Command（host/user 可调）：任务跑飞时用户可以不进插件页面，
    // 从宿主命令层一刀切断；引擎会强制抬起按住的鼠标按钮。
    ctx.commands.register("com.reai.computer.stop", async () => {
      await computerCall("computer.stop", {});
      return { status: "stopped" as const };
    });

    ctx.surfaces.register("main", async (surface) => {
      const root = surface.root;
      try {
        root.innerHTML = "";
        const store = ctx.storage.private("state");
        let vlm = await loadVlmConfig(store);
        let abortRequested = false;

        const home: ComputerHome = mountComputerHome(root, {
          onStop: () => void refreshAfterAction("computer.stop", {}),
          onResume: () => void refreshAfterAction("computer.resume", {}),
          onRequestAccessibility: () =>
            void refreshAfterAction("computer.permissions.request_accessibility", {}),
          onOpenScreenSettings: () =>
            void computerCall("computer.permissions.open_screen_settings", {}).catch(
              (cause) => home.setNotice(`打开系统设置失败：${String(cause)}`),
            ),
          onRefreshPermissions: () => void refreshPermissions(),
          onStartTask: (task) => void startTask(task),
          onAbortTask: () => {
            abortRequested = true;
          },
          onSaveVlm: (modelAlias) => {
            vlm = { modelAlias };
            void store
              .set(VLM_CONFIG_KEY, { modelAlias } satisfies StoredVlmConfig)
              .then(() => home.setNotice("模型档位已保存"))
              .catch((cause) => home.setNotice(`保存失败：${describeError(cause)}`));
          },
          onRefreshTrace: () => void refreshEngineState(),
        });
        home.setVlmDraft(vlm.modelAlias);

        async function refreshPermissions() {
          try {
            const status = await computerCall<PermissionsStatus>(
              "computer.permissions.status",
              {},
            );
            home.setPermissions(status);
          } catch (cause) {
            home.setPermissions(null, String(cause));
          }
        }

        async function refreshEngineState() {
          try {
            const state = await computerCall<ComputerState>("computer.state", {});
            home.setEngineState(state);
          } catch (cause) {
            home.setEngineState(null, String(cause));
          }
        }

        async function refreshAfterAction(
          method: Parameters<typeof computerCall>[0],
          params: unknown,
        ) {
          try {
            await computerCall(method, params);
          } catch (cause) {
            home.setNotice(describeError(cause));
          }
          await Promise.all([refreshPermissions(), refreshEngineState()]);
        }

        async function startTask(task: string) {
          abortRequested = false;
          home.clearSteps();
          home.setTaskRunning(true);
          home.setNotice("");
          try {
            const result = await runComputerTask(vlm, task, {
              shouldAbort: () => abortRequested,
              onStep: (report) =>
                home.appendStep({
                  step: report.step,
                  thought: report.thought,
                  action: report.action as unknown as {
                    action: string;
                    x?: number;
                    y?: number;
                    text?: string;
                    key?: string;
                    dy?: number;
                    detail?: string;
                  },
                  ok: report.ok,
                  error: report.error,
                }),
            });
            const okText =
              result.status === "done"
                ? `✅ 任务完成（${result.steps} 步）：${result.detail ?? ""}`
                : result.status === "aborted"
                  ? "⏹ 任务已手动中止"
                  : result.status === "fail"
                    ? `⚠️ 模型报告无法完成：${result.detail ?? ""}`
                    : `❌ 任务出错：${result.detail ?? ""}`;
            home.setTaskResult(okText, result.status === "done");
          } catch (cause) {
            home.setTaskResult(`❌ 任务异常终止：${describeError(cause)}`, false);
          } finally {
            home.setTaskRunning(false);
            void refreshEngineState();
          }
        }

        await Promise.all([refreshPermissions(), refreshEngineState()]);
        surface.ready();
        return () => {
          // 卸载时只请求中止本插件发起的任务循环（下一步生效）。**不动引擎停止位**
          // （PR 审查 P1：切换插件页面即触发本 cleanup，无条件 stop 会让 Agent
          // 工具桥的 computer_* 「用一次就卡死」——pi/DSH 没有 resume 工具，停止位
          // 是用户主权语义，只能由用户在插件页或 com.reai.computer.stop 命令触发）。
          abortRequested = true;
          root.replaceChildren();
        };
      } catch (cause) {
        surface.fail(
          new AppError({
            code: "com.reai.computer/HOME_MOUNT_FAILED",
            userMessage: "电脑操控主页初始化失败",
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
