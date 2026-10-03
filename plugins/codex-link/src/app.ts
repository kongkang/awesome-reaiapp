import { t, setCodexLocale, releaseLocaleBindings } from "./codex-i18n";
import { AppError, defineApp, type HostTitlebarActionIntent } from "@reai/app-sdk/v1";
import { codexCall } from "./codex-bridge";
import { resolveApprovalTarget } from "./codex-model";
import {
  CodexRepository,
  type CodexRepositorySnapshot,
} from "./codex-repository";
import {
  isMountedSkillIntent,
  mountCodexView,
  type CodexView,
  type ComposePreset,
} from "./codex-view";
import "./codex.css";

type ApproveInput = Record<string, never>;
type DenyInput = { reason?: string };
/**
 * 「新建 Codex 任务」的入参 = 这条键位绑定携带的起跑预设。
 *
 * 四个字段就是 Host `static_input` 白名单里的那四项。**没有「模式」字段**：Codex 协议
 * 没有切换会话审批模式的方法，建 thread / 起 turn 的窄口也不收它——三条路是同一个根因。
 */
type NewTaskInput = ComposePreset;

let activationEpoch = 0;
let stopRuntimeLocale: (() => void) | undefined;
let repository: CodexRepository | undefined;
let latestSnapshot: CodexRepositorySnapshot | undefined;
let selectedThreadId: string | undefined;
const mountedViews = new Set<CodexView>();
/**
 * 界面还没挂上时收到的预设，等挂上再铺。
 *
 * Host 投递命令前会先 `open_with` + `reveal` 把插件拉起来，但「拉起来」和「surface 挂好」
 * 之间有个窗口。丢掉预设的话，用户按了拨杆档位的键却拿到一张空白表单，
 * 只会以为这颗键没反应。
 */
type PendingPreset = { preset: ComposePreset; atMs: number; generation: number };

/**
 * 冷启动命令与 Surface 初始化之间的单槽交接。
 *
 * generation 让失败的旧 Surface 只能丢弃自己开始时看见的预设；若失败期间又来了新命令，
 * 旧失败不能把新命令一起清掉。
 */
export class PendingPresetState {
  private nextGeneration = 0;
  private pending: PendingPreset | undefined;

  stage(preset: ComposePreset, atMs = Date.now()): number {
    const generation = ++this.nextGeneration;
    this.pending = { preset, atMs, generation };
    return generation;
  }

  currentGeneration(): number | undefined {
    return this.pending?.generation;
  }

  discard(generation: number | undefined): void {
    if (generation !== undefined && this.pending?.generation === generation) {
      this.pending = undefined;
    }
  }

  takeFresh(nowMs: number, ttlMs: number): ComposePreset | undefined {
    const pending = this.pending;
    this.pending = undefined;
    return pending && nowMs - pending.atMs <= ttlMs ? pending.preset : undefined;
  }

  clear(): void {
    this.pending = undefined;
  }
}

const pendingPresets = new PendingPresetState();

/**
 * 暂存预设的有效期。
 *
 * 界面拉起通常一两秒就好了。超过这个窗口多半是「拉起失败」或「用户当场把它关了」——
 * 那次按键早就过去了，再把预设铺出来只会让人莫名其妙：过半小时点开 Codex Link，
 * 输入框里凭空多出一句话。
 */
const PENDING_PRESET_TTL_MS = 30_000;

export function codexTitlebarPresetFrom(
  value: unknown,
): ComposePreset | undefined {
  if (!value || typeof value !== "object") return undefined;
  const intent = value as Partial<HostTitlebarActionIntent<{ type?: unknown }>>;
  return intent.source === "host.titlebarAction"
    && intent.actionId === "new-task"
    && intent.payload?.type === "new-task"
    ? {}
    : undefined;
}

/** 只留白名单里的四项，且值必须是非空字符串——绑定表是本机文件，用户手改得进去。 */
function sanitizePreset(input: NewTaskInput | undefined): ComposePreset {
  const preset: ComposePreset = {};
  // 长度按**码点**数，与 Host 侧 `validate_static_input` 的 `chars().count()` 同一把尺。
  // 用 `.length`（UTF-16 码元）会在星外字符（emoji）上跟 Host 判得不一样。
  const take = (value: unknown, max: number): string | undefined =>
    typeof value === "string" && value.length > 0 && [...value].length <= max ? value : undefined;
  preset.model = take(input?.model, 256);
  preset.effort = take(input?.effort, 64);
  preset.skillName = take(input?.skillName, 128);
  preset.promptPrefix = take(input?.promptPrefix, 256);
  return preset;
}

async function approvalTarget(): Promise<{ repository: CodexRepository; serverRequestId: number } | undefined> {
  if (!repository) return undefined;
  const current = latestSnapshot ?? await repository.refresh();
  latestSnapshot = current;
  const pending = current.runtimeThreads.flatMap((thread) => thread.pendingRequests);
  const target = resolveApprovalTarget(pending, selectedThreadId);
  return target.ok ? { repository, serverRequestId: target.serverRequestId } : undefined;
}

function resyncViews() {
  for (const view of mountedViews) view.notifyRealtime();
}

export default defineApp({
  async activate(ctx) {
    const epoch = ++activationEpoch;
    stopRuntimeLocale?.();
    setCodexLocale(ctx.locale?.getSnapshot().locale ?? "zh");
    stopRuntimeLocale = ctx.locale?.onChange(({ locale }) => setCodexLocale(locale));
    repository = new CodexRepository(undefined, ctx.storage.private("thread-state"), {
      onStorageWarning: (message) => console.warn(`[codex-link] ${message}`),
    });

    ctx.events.onCodex(() => resyncViews());
    ctx.events.on((event) => {
      if (event.eventType === "host.pending_overflow") resyncViews();
    });

    // 拨杆档位 + 硬件键 = 用这一档的预设开一个新的 Codex 任务。
    //
    // 这里**不直接建 thread**：没有「要做什么」那句话就建对话，等于替用户花掉一次额度。
    // 正确的落法是把这一档的预设铺进新任务表单再打开它——用户只要敲一句话就走。
    // callers 只给 host：它是硬件键的目标，不该出现在用户的 Action 菜单里。
    ctx.commands.register<NewTaskInput, { ok: boolean }>(
      "com.reai.codex-link.new-task",
      async ({ input }) => {
        const preset = sanitizePreset(input);
        if (mountedViews.size === 0) {
          // Host 正在拉起界面，surface 还没挂好。存下来，挂上就铺。
          pendingPresets.stage(preset);
          return { ok: true };
        }
        pendingPresets.clear();
        for (const view of mountedViews) view.applyComposePreset(preset);
        return { ok: true };
      },
    );

    ctx.commands.register<ApproveInput, { ok: boolean }>(
      "com.reai.codex-link.approve",
      async () => {
        const target = await approvalTarget();
        if (!target) return { ok: false };
        await target.repository.respondApproval(target.serverRequestId, "approved");
        resyncViews();
        return { ok: true };
      },
    );

    ctx.commands.register<DenyInput, { ok: boolean }>(
      "com.reai.codex-link.deny",
      async ({ input }) => {
        const target = await approvalTarget();
        if (!target) return { ok: false };
        await target.repository.respondApproval(target.serverRequestId, "denied", input.reason);
        resyncViews();
        return { ok: true };
      },
    );

    ctx.surfaces.register("main", async (surface) => {
      const pendingGenerationAtStart = pendingPresets.currentGeneration();
      let view: CodexView | undefined;
      // Action 层里挂着的 Skill 被按下时，Host 会把这条 intent 投回来（必要时先冷启动）。
      const applyActionIntent = (intent: unknown) => {
        const titlebarPreset = codexTitlebarPresetFrom(intent);
        if (titlebarPreset) {
          view?.applyComposePreset(titlebarPreset);
        } else if (isMountedSkillIntent(intent)) {
          void view?.runMountedSkill(intent);
        }
      };
      const stopActionIntent = surface.onIntent(applyActionIntent);
      // Host 从胶囊 / Tab 层待办点开一条任务时投 host.taskConversation——挂上视图
      // 再注册（冷启动窗口里 SDK 的 pendingIntent 会补发最后一条，不丢）。
      let stopConversationIntent: (() => void) | undefined;
      try {
        view = mountCodexView(surface.root, {
          repository,
          locale: ctx.locale,
          actionLayer: ctx.actionItems,
          pickFolder: () => ctx.folderPick.pick(),
          onSnapshot(snapshot, selection) {
            latestSnapshot = snapshot;
            selectedThreadId = selection;
          },
          // 任务详情真的渲染出来之后回报「那条会话被打开」——宿主后台任务子系统
          // （胶囊 / Tab 层 / 通知账本三处一体）以它为「已看过」的判据撤卡。
          // 失败只记日志：呈现层的回报链路坏了不该影响 Codex 本身。
          onConversationOpened(threadId) {
            codexCall("codex.conversation_opened", { threadId }).catch((cause) => {
              console.warn("[codex-link] 回报会话已打开失败", cause);
            });
          },
        });
        mountedViews.add(view);
        applyActionIntent(surface.initialIntent);
        void view.refresh();
        // `source` 是 Host 事件的保留判别式（跨 App intent 伪造不了），只认它。
        stopConversationIntent = surface.onIntent((intent) => {
          if (
            intent && typeof intent === "object"
            && (intent as { source?: unknown }).source === "host.taskConversation"
          ) {
            const entityId = (intent as { payload?: { entityId?: unknown } }).payload?.entityId;
            if (typeof entityId === "string" && entityId) {
              view?.openConversation(entityId);
            }
          }
        });
        surface.ready();
        // 界面挂好之前按下的那次拨杆档位键，现在补上；过期的一律丢弃。
        //
        // 这里当场调就行，**不必等首次快照**：`applyComposePreset` 自己会在没有快照时
        // 攒着、等快照落地再铺（只读态与模型目录都要靠快照才判得出来）。
        // 那条前提属于它自己，不该由每个调用方各记一遍。
        const preset = pendingPresets.takeFresh(Date.now(), PENDING_PRESET_TTL_MS);
        if (preset) view.applyComposePreset(preset);
      } catch (cause) {
        pendingPresets.discard(pendingGenerationAtStart);
        stopActionIntent();
        releaseLocaleBindings(surface.root);
        surface.fail(new AppError({
          code: "com.reai.codex-link/SURFACE_INIT_FAILED",
          userMessage: t("errors.surface"),
          retryable: true,
          cause,
        }));
        return;
      }
      return () => {
        stopConversationIntent?.();
        stopActionIntent();
        if (view) mountedViews.delete(view);
        view?.dispose();
      };
    });

    // Surface 和事件处理器先同步注册，Codex 冷启动留在后台，避免 10 秒激活预算竞态。
    void codexCall<{ subscriptionId: string }>("codex.attach", { callbackMethod: "codexEvents" })
      .then(async () => {
        if (activationEpoch !== epoch) await codexCall("codex.detach", {});
      })
      .catch((cause) => {
        console.warn("[codex-link] codex.attach 失败", cause);
      });
  },

  async deactivate() {
    activationEpoch += 1;
    stopRuntimeLocale?.();
    stopRuntimeLocale = undefined;
    for (const view of mountedViews) view.dispose();
    mountedViews.clear();
    latestSnapshot = undefined;
    selectedThreadId = undefined;
    pendingPresets.clear();
    repository = undefined;
    try {
      await codexCall("codex.detach", {});
    } catch (cause) {
      console.warn("[codex-link] codex.detach 失败", cause);
    }
  },
});
