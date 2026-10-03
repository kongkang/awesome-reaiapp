import { t, message, resolveText, setLocale, type LocalizedText } from "./i18n";
import {
  defineApp,
  AppError,
  isSystemTaskReturnIntent,
  type AppContext,
  type HostTitlebarActionIntent,
  type SurfaceHandle,
} from "@reai/app-sdk/v1";
import {
  mountCodexView,
  type CxaViewState,
  type LinkedAppSummary,
  type PendingApproval,
  type RuntimeSummary,
  type SkillSummary,
  type TaskRow,
  type ViewQuestion,
  type ViewUserInput,
} from "./codex-view";
import { normalizeAccountSnapshot } from "./account-state";
import { normalizeSkills } from "./live-state";
import {
  chooseModelSelection,
  normalizeModels,
  normalizeUsageSnapshot,
  type ModelSummary,
  type ReasoningEffort,
  type UsageSummary,
} from "./capability-state";
import { loadPreferences, savePreferences } from "./preferences";
import type { CodexTurnMode } from "./turn-mode";
import { loadThreadPages } from "./thread-loader";
import { interruptActiveTurn, sendThreadMessage } from "./turn-actions";
import { ExclusiveAction, normalizeDeviceLogin } from "./interaction-state";
import {
  buildThreadDetail,
  emptyThreadPlaceholder,
  graceClockNow,
  isFirstTurnReadWithinGrace,
  mergeThreadsWithPending,
  normalizeStartedThread,
  openFirstTurnReadGrace,
} from "./thread-state";

// 本 App 只走 Host 托管的官方 Codex：线程、审批、补充问题、登录全部通过
// @reai/app-sdk 的 codex.tasks.* 协议；不得直调 attached 的 codex.*。
const TEXT_EDITOR_APP_ID = "com.reai.text-editor";
const TEXT_EDITOR_INTENT = "open-document";

interface ApprovalRecord extends PendingApproval {
  threadId?: string;
}

interface UserInputRecord extends ViewUserInput {
  threadId?: string;
}

interface UnsupportedRequestRecord {
  method: string;
  threadId?: string;
}

/* ===== 协议载荷归一化（真实数据进视图前的唯一入口）===== */

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};

function stringAt(value: unknown, ...path: string[]): string | undefined {
  let current: unknown = value;
  for (const key of path) current = asRecord(current)[key];
  return typeof current === "string" ? current : undefined;
}

function arrayAt(value: unknown, ...path: string[]): unknown[] {
  let current: unknown = value;
  for (const key of path) current = asRecord(current)[key];
  return Array.isArray(current) ? current : [];
}

function booleanAt(value: unknown, ...path: string[]): boolean {
  let current: unknown = value;
  for (const key of path) current = asRecord(current)[key];
  return current === true;
}

function normalizeQuestions(value: unknown): ViewQuestion[] {
  return (Array.isArray(value) ? value : [])
    .map((raw): ViewQuestion | undefined => {
      const id = stringAt(raw, "id");
      const question = stringAt(raw, "question");
      if (!id || !question) return undefined;
      const header = stringAt(raw, "header");
      const options = arrayAt(raw, "options").map(
        (option): { label: string; description?: string } | undefined => {
          const label = stringAt(option, "label");
          if (!label) return undefined;
          const description = stringAt(option, "description");
          return description ? { label, description } : { label };
        },
      );
      return {
        id,
        question,
        isOther: booleanAt(raw, "isOther"),
        isSecret: booleanAt(raw, "isSecret"),
        options: options.filter((option): option is NonNullable<typeof option> =>
          Boolean(option),
        ),
        ...(header ? { header } : {}),
      };
    })
    .filter((question): question is ViewQuestion => Boolean(question));
}

const LOGIN_BROWSER_PENDING = message("ui.m102");
const LOGIN_DEVICE_PENDING = message("ui.m103");
const LOGIN_BROWSER_FAILED = message("ui.m104");
const LOGIN_DEVICE_FAILED = message("ui.m105");
const DEVICE_CODE_HINT = message("ui.m106");
// Host 把「内核缺失/损坏」（CODEX_TASKS_NOT_INSTALLED）和「暂时性故障」分成两个
// 稳定错误码：前者要引导一键修复安装，后者 2 秒轮询会自动恢复，不该让用户去登录。
const RUNTIME_DOWN_NOTICE = message("ui.m107");
const RUNTIME_NOT_INSTALLED_NOTICE =
  message("ui.m108");
const CODEX_TASKS_NOT_INSTALLED = "CODEX_TASKS_NOT_INSTALLED";
const START_THREAD_FAILED_NOTICE = message("ui.m109");
const THREAD_LOAD_FAILED_NOTICE = message("ui.m110");

function errorCodeOf(value: unknown): string | undefined {
  const row = asRecord(value);
  return typeof row.code === "string" ? row.code : undefined;
}

function intentType(value: unknown): "open-settings" | "add-project" | undefined {
  const row = asRecord(value);
  if (row.type === "open-settings" || row.type === "add-project") return row.type;
  if (row.source !== "host.titlebarAction") return undefined;
  const payload = asRecord(row.payload);
  return payload.type === "open-settings" || payload.type === "add-project"
    ? payload.type
    : undefined;
}

type CodexIntent =
  | { type: "open-settings" }
  | { type: "add-project" }
  | HostTitlebarActionIntent<{ type: "open-settings" | "add-project" }>;

function mountCodexApp(ctx: AppContext, surface: SurfaceHandle<CodexIntent>) {
  setLocale(ctx.locale?.getSnapshot().locale ?? "zh");
  let disposed = false;
  let view: "work" | "settings" = "work";
  let threads: TaskRow[] = [];
  let pendingThread: TaskRow | undefined;
  let pendingTurnStarted = false;
  // CODEXAPP-01：首 turn 被接受后，官方 app-server 要等首个用户消息处理完才把
  // 线程落盘，期间 thread/read(includeTurns) 会拒绝；对首次权威详情读取开有界
  // 宽限窗口（graceClockNow 单调时钟，回拨墙钟不延长），超时或权威详情落地后归零。
  let firstTurnReadDeadline = 0;
  // 宽限占位共享同一个只读对象：pushState 用引用相等识别「当前展示的是宽限
  // 占位」并投影 firstTurnGrace，让视图禁用必然失败的操作入口。
  const gracePlaceholderDetail = emptyThreadPlaceholder(true);
  const loadedThreadIds = new Set<string>();
  let selectedId = "";
  let selectedDetailId = "";
  let selectedDetailRaw: unknown;
  let selectionGeneration = 0;
  let approvals: ApprovalRecord[] = [];
  let userInputs: UserInputRecord[] = [];
  let unsupportedRequests: UnsupportedRequestRecord[] = [];
  let accountPayload: unknown;
  let accountProbed = false;
  let accountProbePromise: Promise<void> | undefined;
  let accountProbeGeneration = 0;
  let accountProbeFailureReported = false;
  let loginConfirmed = false;
  let loginStatus: LocalizedText = "";
  let deviceLogin: { verificationUrl: string; userCode: string } | undefined;
  let runtimeSummary: RuntimeSummary | undefined;
  let runtimeMissing = false;
  let linkedApps: LinkedAppSummary[] = [];
  let skills: SkillSummary[] = [];
  let skillsCwd: string | undefined;
  let capabilitiesLoading = true;
  let capabilityFailures: LocalizedText[] = [];
  let capabilityProbeKey = "";
  let capabilityProbedAt = 0;
  let capabilityProbePromise: Promise<void> | undefined;
  let capabilityGeneration = 0;
  let models: ModelSummary[] = [];
  let selectedModel: string | undefined;
  let selectedEffort: ReasoningEffort | undefined;
  let selectedMode: CodexTurnMode = "plan";
  let usage: UsageSummary | undefined;
  let storedPreferences: Awaited<ReturnType<typeof loadPreferences>>;
  let preferencesLoaded = false;
  let preferenceWritePromise: Promise<void> = Promise.resolve();
  const preferenceStore = ctx.storage.private("codex-preferences");

  /* 轮询生命周期标志：先声明再使用，避免 TDZ */
  let timer: ReturnType<typeof setInterval> | undefined;
  let firstWorkLoadSettled = false;
  let lastWorkError: LocalizedText = "";
  let displayedError: LocalizedText | undefined;
  let refreshPromise: Promise<void> | undefined;
  let refreshQueued = false;
  const addProjectAction = new ExclusiveAction();

  const report = (cause: unknown) =>
    surface.reportError(new AppError({ code: "com.reai.codex-app/OPERATION_FAILED", userMessage: t("ui.m111"), cause }));

  const initialState: CxaViewState = {
    view: "work",
    logged: false,
    loading: true,
    runtimeMissing: false,
    tasks: [],
    selectedId: "",
    approvals: [],
    userInputs: [],
    unsupported: [],
    newWorkMode: false,
    linkedApps: [],
    skills: [],
    capabilitiesLoading: true,
    accountProbed: false,
    models: [],
  };

  const ui = mountCodexView(surface.root, initialState, {
    onSelectTask: (taskId) => {
      if (taskId === selectedId && selectedDetailId === taskId) return;
      selectedId = taskId;
      selectedDetailId = "";
      selectedDetailRaw = undefined;
      selectionGeneration += 1;
      capabilityGeneration += 1;
      capabilityProbeKey = "";
      capabilitiesLoading = true;
      capabilityFailures = [];
      linkedApps = [];
      skills = [];
      skillsCwd = undefined;
      usage = undefined;
      pushState();
      if (pendingThread?.id !== taskId) {
        void ctx.codexTasks.conversationOpened(taskId).catch(report);
      }
      void refresh();
    },
    // 新工作与标题栏「添加文件夹」同一条真实链路：选文件夹 → 建官方线程。
    onNewWork: () => {
      void addProject();
    },
    onSend: async (text) => {
      if (!selectedId) throw new Error(t("ui.m112"));
      const turnThreadId = selectedId;
      const wasLoaded = loadedThreadIds.has(turnThreadId);
      try {
        await sendThreadMessage(ctx.codexTasks, {
          threadId: turnThreadId,
          text,
          loaded: loadedThreadIds.has(turnThreadId),
          ...(selectedDetailId === turnThreadId ? { detail: selectedDetailRaw } : {}),
          ...(selectedModel ? { model: selectedModel } : {}),
          ...(selectedEffort ? { effort: selectedEffort } : {}),
          mode: selectedMode,
        });
        loadedThreadIds.add(turnThreadId);
        if (pendingThread?.id === turnThreadId) {
          // 宽限窗口每个「首 turn 周期」只设定一次：turn 已被接受过（含权威
          // 详情落地收窗之后）不再重置，官方列表接管前的盲区内后续发送不得
          // 重开或延长窗口。
          const opened = openFirstTurnReadGrace(
            pendingTurnStarted,
            firstTurnReadDeadline,
            graceClockNow(),
          );
          pendingTurnStarted = opened.turnStarted;
          firstTurnReadDeadline = opened.graceDeadline;
        }
        ui.update({ newWorkMode: false });
        await refresh();
      } catch (cause) {
        // 写请求是否已被 runtime 接收并不确定，因此不自动重试。下一次用户明确
        // 重试时先 resume + read，再从真实状态决定 start 或 steer。
        loadedThreadIds.delete(turnThreadId);
        if (!wasLoaded && pendingThread?.id === turnThreadId && !pendingTurnStarted) {
          // 空线程只存在于 runtime 内存。首次失败后用户明确重试仍无法 resume，
          // 说明 runtime 已重启或该 id 已失效，不能把不可用的假任务留在侧栏。
          pendingThread = undefined;
          threads = threads.filter((row) => row.id !== turnThreadId);
          selectedId = threads[0]?.id ?? "";
          selectedDetailId = "";
          selectedDetailRaw = undefined;
          selectionGeneration += 1;
          capabilityGeneration += 1;
          capabilityProbeKey = "";
          capabilitiesLoading = true;
          capabilityFailures = [];
          linkedApps = [];
          skills = [];
          skillsCwd = undefined;
          usage = undefined;
          ui.update({ newWorkMode: false });
          pushState(message("ui.m113"));
        }
        report(cause);
        throw cause;
      }
    },
    onInterrupt: async () => {
      if (!selectedId || selectedDetailId !== selectedId || !selectedDetailRaw) {
        throw new Error(t("ui.m114"));
      }
      const threadId = selectedId;
      try {
        await interruptActiveTurn(
          ctx.codexTasks,
          threadId,
          selectedDetailRaw,
          loadedThreadIds.has(threadId),
        );
        loadedThreadIds.add(threadId);
        await refresh();
      } catch (cause) {
        loadedThreadIds.delete(threadId);
        report(cause);
        throw cause;
      }
    },
    onSelectModel: (model) => {
      const selection = chooseModelSelection(models, {
        model,
        ...(selectedEffort ? { effort: selectedEffort } : {}),
      });
      if (!selection) return;
      selectedModel = selection.model;
      selectedEffort = selection.effort;
      pushState();
      void persistPreferences();
    },
    onSelectEffort: (effort) => {
      const selection = chooseModelSelection(models, {
        ...(selectedModel ? { model: selectedModel } : {}),
        effort,
      });
      if (!selection) return;
      selectedModel = selection.model;
      selectedEffort = selection.effort;
      pushState();
      void persistPreferences();
    },
    onSelectMode: (mode) => {
      selectedMode = mode;
      pushState();
      void persistPreferences();
    },
    onOpenExternal: (path) => {
      void openFile(path);
    },
    onApproval: (requestId, decision) => {
      void ctx.codexTasks
        .respondApproval({ requestId, decision })
        .then(() => {
          approvals = approvals.filter((row) => row.requestId !== requestId);
          pushState();
        })
        .catch((cause) => {
          ui.toast(message("ui.m115"));
          report(cause);
        });
    },
    onSubmitAnswers: (requestId, answers) => {
      void ctx.codexTasks
        .respondUserInput(requestId, answers)
        .then(() => {
          userInputs = userInputs.filter((row) => row.requestId !== requestId);
          pushState();
        })
        .catch((cause) => {
          // 提交失败让表单回到可编辑态；状态以事件流的下一轮为准。
          ui.toast(message("ui.m116"));
          pushState();
          report(cause);
        });
    },
    onExitSettings: () => {
      view = "work";
      surface.reportNav?.(null);
      pushState();
    },
    onLoginBrowser: () => {
      loginStatus = LOGIN_BROWSER_PENDING;
      deviceLogin = undefined;
      pushState();
      void ctx.codexTasks.startLogin("browser").catch((cause) => {
        loginStatus = LOGIN_BROWSER_FAILED;
        pushState();
        report(cause);
      });
    },
    onLoginDevice: () => {
      loginStatus = LOGIN_DEVICE_PENDING;
      deviceLogin = undefined;
      pushState();
      void ctx.codexTasks
        .startLogin("deviceCode")
        .then((result) => {
          const normalized = normalizeDeviceLogin(result);
          if (normalized) {
            deviceLogin = normalized;
            loginStatus = DEVICE_CODE_HINT;
          } else {
            loginStatus = LOGIN_DEVICE_FAILED;
          }
          pushState();
        })
        .catch((cause) => {
          loginStatus = LOGIN_DEVICE_FAILED;
          pushState();
          report(cause);
        });
    },
    onLogout: () => {
      void ctx.codexTasks
        .logout()
        .then(() => {
          // 让 logout 之前发出的 account/read 失效，避免它晚到后把已退出账号画回去。
          accountProbeGeneration += 1;
          loginConfirmed = false;
          accountPayload = undefined;
          accountProbed = true;
          pushState();
        })
        .catch((cause) => {
          ui.toast(message("ui.m117"));
          report(cause);
        });
    },
    onCopyText: (text) => {
      if (!navigator.clipboard) {
        ui.toast(message("ui.m118"));
        return;
      }
      void navigator.clipboard.writeText(text).catch((cause) => {
        ui.toast(message("ui.m119"));
        report(cause);
      });
    },
    // 一键修复安装：Host 打开「已安装 › 运行组件」并聚焦来源插件的组件区；
    // 修复完成（或用户主动返回）后经 system-task.return intent 回到这里重探。
    onRepairRuntime: () => {
      void ctx.systemTasks
        .open({
          target: "app-managed-resources",
          returnIntent: { reason: "codex-runtime-repair" },
        })
        .then(() => {
          ui.toast(message("ui.m120"));
        })
        .catch((cause) => {
          if (errorCodeOf(cause) === "SYSTEM_TASK_RETURN_PENDING") {
            // 上一次打开的修复任务还在等返回：再开同一个入口会被 Host 拒绝，
            // 指引用户走标题栏返回闭环，而不是把任务卡死在失败 toast 上。
            ui.toast(message("ui.m121"));
            return;
          }
          ui.toast(message("ui.m122"));
          report(cause);
        });
    },
  });

  function deriveAccount(): { plan: LocalizedText; email?: string } | undefined {
    if (!accountProbed) return undefined;
    return normalizeAccountSnapshot(accountPayload).summary;
  }

  async function probeAccount(): Promise<void> {
    if (disposed) return;
    if (accountProbePromise) return accountProbePromise;

    const generation = accountProbeGeneration;
    const request = (async () => {
      try {
        const payload = await ctx.codexTasks.account();
        // 登录完成通知会推进 generation。通知之前发出的 account/read 即使晚到，
        // 也不能再用旧的 null 覆盖新账号；reprobeAccount 会在它结束后补一次新读。
        if (disposed || generation !== accountProbeGeneration) return;
        accountPayload = payload;
        const account = normalizeAccountSnapshot(payload);
        loginConfirmed = account.logged;
        accountProbed = true;
        accountProbeFailureReported = false;
      } catch (cause) {
        if (disposed || generation !== accountProbeGeneration) return;
        // 冷启动时 runtime 尚未就绪属于可恢复错误。保留上一次成功状态，并让
        // 2 秒刷新循环继续重试；绝不能把暂时错误固化成“未登录”。
        accountProbed = false;
        if (!accountProbeFailureReported) {
          accountProbeFailureReported = true;
          report(cause);
        }
      } finally {
        if (!disposed && generation === accountProbeGeneration) pushState();
      }
    })();
    const wrapped = request.finally(() => {
      if (accountProbePromise === wrapped) accountProbePromise = undefined;
    });
    accountProbePromise = wrapped;
    return wrapped;
  }

  async function reprobeAccount(): Promise<void> {
    const staleRequest = accountProbePromise;
    if (staleRequest) await staleRequest;
    if (!disposed) await probeAccount();
  }

  async function ensurePreferences(): Promise<void> {
    if (preferencesLoaded) return;
    try {
      storedPreferences = await loadPreferences(preferenceStore);
    } catch (cause) {
      report(cause);
    } finally {
      preferencesLoaded = true;
    }
  }

  function persistPreferences(): Promise<void> {
    if (!selectedModel || !selectedEffort) return Promise.resolve();
    const next = { model: selectedModel, effort: selectedEffort, mode: selectedMode };
    preferenceWritePromise = preferenceWritePromise.then(async () => {
      try {
        await savePreferences(preferenceStore, next);
        storedPreferences = next;
      } catch (cause) {
        ui.toast(message("ui.m123"));
        report(cause);
      }
    });
    return preferenceWritePromise;
  }

  /**
   * 真实能力快照：runtime 来自 codex.tasks.status，关联应用来自 Host 注册表，
   * Skills 来自官方 app-server。相同工作 15 秒内复用，避免 2 秒 UI 轮询反复扫盘。
   */
  async function probeCapabilities(force = false): Promise<void> {
    if (disposed) return;
    const cwd = threads.find((row) => row.id === selectedId)?.cwd;
    const key = cwd ?? "<no-work>";
    const generation = capabilityGeneration;
    if (capabilityProbePromise) return capabilityProbePromise;
    if (!force && capabilityProbeKey === key && Date.now() - capabilityProbedAt < 15_000) {
      return;
    }

    capabilitiesLoading = true;
    capabilityFailures = [];
    pushState();
    const request = (async () => {
      await ensurePreferences();
      const [runtimeResult, editorResult, skillsResult, modelsResult, rateResult, usageResult] =
        await Promise.allSettled([
          ctx.codexTasks.status(),
          ctx.apps.status({ appId: TEXT_EDITOR_APP_ID }),
          cwd ? ctx.codexTasks.listSkills([cwd]) : Promise.resolve(undefined),
          ctx.codexTasks.listModels(),
          ctx.codexTasks.rateLimits(),
          ctx.codexTasks.usage(),
        ]);
      if (disposed) return;
      const currentCwd = threads.find((row) => row.id === selectedId)?.cwd ?? "<no-work>";
      if (generation !== capabilityGeneration || currentCwd !== key) {
        capabilitiesLoading = false;
        capabilityProbeKey = "";
        refreshQueued = true;
        return;
      }

      const failures: LocalizedText[] = [];
      if (runtimeResult.status === "fulfilled") {
        runtimeSummary = {
          running: runtimeResult.value.running,
          version: runtimeResult.value.runtimeVersion,
          ...(runtimeResult.value.installState
            ? { installState: runtimeResult.value.installState }
            : {}),
        };
      } else {
        runtimeSummary = undefined;
        failures.push("Codex runtime");
      }

      if (editorResult.status === "fulfilled") {
        linkedApps = [
          {
            appId: editorResult.value.appId,
            name: message("ui.m124"),
            installed: editorResult.value.installed,
            enabled: editorResult.value.enabled,
          },
        ];
      } else {
        linkedApps = [];
        failures.push(message("ui.m125"));
      }

      skillsCwd = cwd;
      if (!cwd) {
        skills = [];
      } else if (skillsResult.status === "fulfilled") {
        skills = normalizeSkills(skillsResult.value, cwd);
      } else {
        skills = [];
        failures.push("Codex Skills");
      }

      if (modelsResult.status === "fulfilled") {
        models = normalizeModels(modelsResult.value);
        const preferredModel = selectedModel ?? storedPreferences?.model;
        const preferredEffort = selectedEffort ?? storedPreferences?.effort;
        if (storedPreferences?.mode) selectedMode = storedPreferences.mode;
        const selection = chooseModelSelection(models, {
          ...(preferredModel ? { model: preferredModel } : {}),
          ...(preferredEffort ? { effort: preferredEffort } : {}),
        });
        selectedModel = selection?.model;
        selectedEffort = selection?.effort;
        if (
          selection?.effort &&
          (storedPreferences?.model !== selection.model ||
            storedPreferences.effort !== selection.effort ||
            storedPreferences.mode !== selectedMode)
        ) {
          void persistPreferences();
        }
        if (models.length === 0) failures.push(message("ui.m126"));
      } else {
        models = [];
        selectedModel = undefined;
        selectedEffort = undefined;
        failures.push(message("ui.m126"));
      }

      if (rateResult.status === "fulfilled" && usageResult.status === "fulfilled") {
        usage = normalizeUsageSnapshot(rateResult.value, usageResult.value);
      } else {
        usage = undefined;
        failures.push(message("ui.m084"));
      }

      capabilityProbeKey = key;
      capabilityProbedAt = Date.now();
      capabilitiesLoading = false;
      capabilityFailures = failures;
      pushState();
    })();
    const wrapped = request.finally(() => {
      if (capabilityProbePromise === wrapped) capabilityProbePromise = undefined;
    });
    capabilityProbePromise = wrapped;
    return wrapped;
  }

  function pushState(error?: LocalizedText, locale?: string): void {
    if (disposed) return;
    if (locale === undefined) displayedError = error;
    const summary = deriveAccount();
    const tasks = threads.map((row) => ({
      ...row,
      needsDecision:
        approvals.some((approval) => approval.threadId === row.id) ||
        userInputs.some((input) => input.threadId === row.id),
    }));
    const thread = threads.find((row) => row.id === selectedId);
    const built = selectedDetailId === selectedId && selectedDetailRaw
      ? buildThreadDetail(selectedDetailRaw, thread)
      : undefined;
    // 宽限占位（首 turn 已接受、权威详情未落盘）是只读展示：占位没有
    // activeTurnId，停止/追加发送必然失败，交给视图禁用这些入口。
    const firstTurnGrace =
      selectedDetailId === selectedId && selectedDetailRaw === gracePlaceholderDetail;
    const projected: Partial<CxaViewState> = {
      view,
      loading: (!firstWorkLoadSettled || !accountProbed) && !runtimeMissing,
      runtimeMissing,
      error: displayedError || undefined,
      logged: loginConfirmed,
      tasks,
      selectedId,
      firstTurnGrace,
      detail: built
        ? {
            running: built.running,
            fileChanges: built.fileChanges,
            materials: built.materials,
            goal: thread?.name,
            stream: built.stream,
          }
        : undefined,
      approvals: approvals
        .filter((row) => !row.threadId || row.threadId === selectedId)
        .map((row) =>
          row.sub === undefined
            ? { requestId: row.requestId, title: row.title }
            : { requestId: row.requestId, title: row.title, sub: row.sub },
        ),
      userInputs: userInputs
        .filter((row) => !row.threadId || row.threadId === selectedId)
        .map((row) => ({ requestId: row.requestId, questions: row.questions })),
      unsupported: unsupportedRequests
        .filter((row) => !row.threadId || row.threadId === selectedId)
        .map((row) => row.method),
      newWorkMode: ui.snapshot().newWorkMode,
      deviceLogin,
      loginStatus,
      account: summary,
      accountProbed,
      runtime: runtimeSummary,
      linkedApps: [...linkedApps],
      skills: [...skills],
      skillsCwd,
      capabilitiesLoading,
      capabilitiesError: capabilityFailures.length ? t("ui.m169", { p0: capabilityFailures.map(resolveText).join(t("common.listSeparator")) }) : undefined,
      models: [...models],
      selectedModel,
      selectedEffort,
      selectedMode,
      usage,
      detailLoading: Boolean(selectedId) && selectedDetailId !== selectedId,
    };
    if (locale === undefined) ui.update(projected);
    else ui.refreshLocale(locale, projected);
  }

  const consumeEvents = (events: unknown[]): {
    loginCompleted: boolean;
    resyncRequired: boolean;
  } => {
    let loginCompleted = false;
    let resyncRequired = false;
    for (const raw of events) {
      const event = asRecord(raw);
      if (event.type === "resyncRequired") {
        // Host 会在此事件后重放仍真实 pending 的交互；先丢掉本地旧快照，
        // 后续 approvalRequested/userInputRequested 再按 Host 权威状态重建。
        approvals = [];
        userInputs = [];
        unsupportedRequests = [];
        accountProbeGeneration += 1;
        accountProbed = false;
        resyncRequired = true;
      } else if (event.type === "approvalRequested" && typeof event.requestId === "number") {
        approvals = [
          {
            requestId: event.requestId,
            ...(typeof event.threadId === "string" ? { threadId: event.threadId } : {}),
            title:
              typeof event.summary === "string"
                ? event.summary
                : message("ui.m127"),
            ...(typeof event.detail === "string" ? { sub: event.detail } : {}),
          },
          ...approvals.filter((row) => row.requestId !== event.requestId),
        ];
      } else if (
        event.type === "userInputRequested" &&
        typeof event.requestId === "number"
      ) {
        const questions = normalizeQuestions(event.questions);
        if (questions.length === 0) continue;
        userInputs = [
          {
            requestId: event.requestId,
            questions,
            ...(typeof event.threadId === "string" ? { threadId: event.threadId } : {}),
          },
          ...userInputs.filter((row) => row.requestId !== event.requestId),
        ];
      } else if (event.type === "unsupportedRequest") {
        const method = typeof event.method === "string" ? event.method : "";
        const threadId = typeof event.threadId === "string" ? event.threadId : undefined;
        unsupportedRequests = [
          { method, ...(threadId ? { threadId } : {}) },
          ...unsupportedRequests.filter(
            (row) => row.method !== method || row.threadId !== threadId,
          ),
        ].slice(0, 3);
      } else if (event.type === "requestResolved" && typeof event.requestId === "number") {
        approvals = approvals.filter((row) => row.requestId !== event.requestId);
        userInputs = userInputs.filter((row) => row.requestId !== event.requestId);
      } else if (
        event.type === "notification" &&
        event.method === "account/login/completed"
      ) {
        loginCompleted = true;
        accountProbeGeneration += 1;
        accountProbed = false;
        loginStatus = "";
        deviceLogin = undefined;
      }
    }
    return { loginCompleted, resyncRequired };
  };

  const refreshOnce = async () => {
    if (disposed) return;
    if (!accountProbed) void probeAccount();
    try {
      if (view === "settings") {
        // 设置页只需要登录态与事件结算，不拉整条线程列表。
        const eventPayload = await ctx.codexTasks.drainEvents();
        const eventState = consumeEvents(eventPayload.events);
        if (eventState.loginCompleted) {
          ui.toast(message("ui.m129"));
          await reprobeAccount();
        } else if (eventState.resyncRequired) {
          await reprobeAccount();
        } else {
          await probeAccount();
        }
        await probeCapabilities();
        // runtime.status 不经过惰性启动、几乎必然成功：它报出的安装状态
        // 足以自愈工作页遗留的 runtimeMissing，否则设置页的修复入口会在
        // 内核修好后仍然挂着（审查必改②）。状态没读到时保持原判断不动。
        const installState = runtimeSummary?.installState;
        if (installState !== undefined) runtimeMissing = installState === "missing";
        pushState();
        return;
      }
      // drainEvents 是破坏性读取：即使 listThreads 因 runtime 断线失败，
      // 已取出的 resyncRequired 也必须先消费，不能随 Promise.all reject 丢失。
      const [threadPageResult, eventPayloadResult] = await Promise.allSettled([
        loadThreadPages((cursor) =>
          ctx.codexTasks.listThreads({ limit: 100, ...(cursor ? { cursor } : {}) })
        ),
        ctx.codexTasks.drainEvents(),
      ]);
      if (eventPayloadResult.status === "fulfilled") {
        const eventState = consumeEvents(eventPayloadResult.value.events);
        if (eventState.loginCompleted) {
          ui.toast(message("ui.m129"));
          await reprobeAccount();
        } else if (eventState.resyncRequired) {
          await reprobeAccount();
        }
      }
      if (threadPageResult.status === "rejected") throw threadPageResult.reason;
      if (eventPayloadResult.status === "rejected") throw eventPayloadResult.reason;
      const threadPage = threadPageResult.value;
      const merged = mergeThreadsWithPending(
        threadPage.threads,
        pendingThread,
      );
      threads = merged.threads;
      pendingThread = merged.pending;
      if (!pendingThread && firstTurnReadDeadline !== 0) {
        // 官方列表已接管 pending 线程：旧首 turn 周期终结，stale deadline
        // 一并清零，宽限只属于下一个新线程的首 turn。
        firstTurnReadDeadline = 0;
      }
      if (!threads.some((row) => row.id === selectedId)) {
        selectedId = threads[0]?.id ?? "";
        selectedDetailId = "";
        selectedDetailRaw = undefined;
        selectionGeneration += 1;
        capabilityGeneration += 1;
        capabilityProbeKey = "";
        capabilitiesLoading = true;
        capabilityFailures = [];
        linkedApps = [];
        skills = [];
        skillsCwd = undefined;
        usage = undefined;
      }
      let detailError = threadPage.warning ?? "";
      const targetId = selectedId;
      const targetGeneration = selectionGeneration;
      if (
        targetId && targetGeneration === selectionGeneration &&
        pendingThread?.id === targetId && !pendingTurnStarted
      ) {
        // 首个 turn 前空线程只存在于 app-server 内存：list/read 都不可见。
        // thread/start 返回的真实 id 足以支撑一个可输入的空详情。
        selectedDetailId = targetId;
        selectedDetailRaw = emptyThreadPlaceholder(false);
      } else if (targetId) {
        try {
          const detail = await ctx.codexTasks.readThread(targetId);
          // 读取期间用户可能点了另一项工作，旧响应不能覆盖新选择。
          if (targetId === selectedId && targetGeneration === selectionGeneration) {
            selectedDetailId = targetId;
            selectedDetailRaw = detail;
            // 权威详情已落地：关闭首 turn 读取宽限窗口，此后失败按真实错误处理。
            firstTurnReadDeadline = 0;
          }
        } catch (cause) {
          if (
            targetId === selectedId && targetGeneration === selectionGeneration &&
            isFirstTurnReadWithinGrace(
              {
                pendingThreadId: pendingThread?.id,
                turnStarted: pendingTurnStarted,
                graceDeadline: firstTurnReadDeadline,
              },
              targetId,
              graceClockNow(),
            )
          ) {
            // 首 turn 已被接受但线程尚未落盘：官方 thread/read(includeTurns) 此刻
            // 必然拒绝，Host 又把错误收束成 UNAVAILABLE。宽限窗口内保持占位详情
            // （active：防止未知 turn id 时并发开第二个 turn）静默降级，输入框
            // 不禁用、不闪 ui.m110，也不向 Host 错误通道刷屏；下一轮轮询继续重试。
            // 占位没有 activeTurnId，停止/发送必然失败（m153/m154），因此经
            // firstTurnGrace 投影成只读展示，权威详情落地后自动恢复。
            selectedDetailId = targetId;
            selectedDetailRaw = gracePlaceholderDetail;
          } else {
            if (targetId === selectedId && targetGeneration === selectionGeneration) {
              selectedDetailId = "";
              selectedDetailRaw = undefined;
              detailError = THREAD_LOAD_FAILED_NOTICE;
            }
            report(cause);
          }
        }
      }
      await probeCapabilities();
      firstWorkLoadSettled = true;
      lastWorkError = "";
      runtimeMissing = false;
      pushState(detailError);
    } catch (cause) {
      firstWorkLoadSettled = true;
      runtimeMissing = errorCodeOf(cause) === CODEX_TASKS_NOT_INSTALLED;
      lastWorkError = runtimeMissing ? RUNTIME_NOT_INSTALLED_NOTICE : RUNTIME_DOWN_NOTICE;
      pushState(lastWorkError);
    }
  };

  /** 2 秒轮询、选择任务和写操作后的刷新共用一条串行链，旧响应不能覆盖新状态。 */
  const refresh = (): Promise<void> => {
    if (disposed) return Promise.resolve();
    if (refreshPromise) {
      refreshQueued = true;
      return refreshPromise;
    }
    const run = (async () => {
      do {
        refreshQueued = false;
        await refreshOnce();
      } while (refreshQueued && !disposed);
    })();
    const wrapped = run.finally(() => {
      if (refreshPromise === wrapped) refreshPromise = undefined;
    });
    refreshPromise = wrapped;
    return wrapped;
  };

  const addProject = async (): Promise<void> => {
    await addProjectAction.run(async () => {
      try {
        const cwd = await ctx.folderPick.pick();
        if (!cwd) return;
        const created = await ctx.codexTasks.startThread(cwd);
        const started = normalizeStartedThread(created, cwd);
        if (!started) throw new Error(t("ui.m130"));
        pendingThread = started;
        pendingTurnStarted = false;
        // 新的首 turn 周期：旧线程的 stale deadline 一并复位。
        firstTurnReadDeadline = 0;
        loadedThreadIds.add(started.id);
        selectedId = started.id;
        selectedDetailId = started.id;
        selectionGeneration += 1;
        capabilityGeneration += 1;
        threads = mergeThreadsWithPending(threads, pendingThread).threads;
        selectedDetailRaw = emptyThreadPlaceholder(false);
        capabilityProbeKey = "";
        capabilitiesLoading = true;
        capabilityFailures = [];
        linkedApps = [];
        skills = [];
        skillsCwd = undefined;
        usage = undefined;
        ui.update({ newWorkMode: true });
        pushState();
        ui.toast(message("ui.m170", { p0: started.cwd.split("/").filter(Boolean).at(-1) ?? started.cwd }));
        await refresh();
      } catch (cause) {
        lastWorkError = START_THREAD_FAILED_NOTICE;
        pushState(lastWorkError);
        ui.toast(START_THREAD_FAILED_NOTICE);
        report(cause);
      }
    });
  };

  const openFile = async (path: string) => {
    if (!selectedId) return;
    try {
      // 文件深加工交给独立文本编辑器：handoff token + apps.intent。
      const handoff = await ctx.codexTasks.createFileHandoff(selectedId, path);
      await ctx.apps.open(
        { appId: TEXT_EDITOR_APP_ID, intent: TEXT_EDITOR_INTENT },
        { token: handoff.token },
      );
    } catch (cause) {
      ui.toast(message("ui.m131"));
      report(cause);
    }
  };

  const applyIntent = (value: unknown) => {
    if (isSystemTaskReturnIntent(value)) {
      // 修复安装（或用户主动返回）后回到插件：丢弃旧的失败快照与缓存账号，
      // 让下一轮 probeAccount/refresh 用修复后的真实状态重画。
      accountProbeGeneration += 1;
      accountProbed = false;
      accountProbeFailureReported = false;
      runtimeMissing = false;
      lastWorkError = "";
      pushState();
      void (async () => {
        await reprobeAccount();
        await refresh();
      })();
      return;
    }
    const type = intentType(value);
    if (type === "open-settings") {
      view = "settings";
      surface.reportNav?.({ key: "settings", label: t("ui.m132") });
      pushState();
      void refresh();
    } else if (type === "add-project") {
      void addProject();
    }
  };

  const stopLocale = ctx.locale?.onChange(({ locale }) => {
    setLocale(locale);
    pushState(undefined, locale);
    if (view === "settings") surface.reportNav?.({ key: "settings", label: t("common.settings") });
  });

  applyIntent(surface.initialIntent);
  const stopIntent = surface.onIntent(applyIntent);
  pushState();
  // 先恢复持久账号，再拉工作列表，避免冷 runtime 上两组请求并发竞争；失败时
  // refresh/timer 仍会继续重试账号读取。
  void (async () => {
    await probeAccount();
    await refresh();
  })();
  timer = setInterval(() => {
    if (document.visibilityState === "visible") void refresh();
  }, 2000);

  return () => {
    disposed = true;
    stopIntent();
    stopLocale?.();
    if (timer) clearInterval(timer);
    ui.destroy();
  };
}

export default defineApp({
  async activate(ctx) {
    ctx.surfaces.register<CodexIntent>("main", (surface) => {
      try {
        const cleanup = mountCodexApp(ctx, surface);
        surface.ready();
        return cleanup;
      } catch (cause) {
        surface.fail(new AppError({ code: "com.reai.codex-app/SURFACE_MOUNT_FAILED", userMessage: t("ui.m133"), cause }));
      }
    });
  },
});
