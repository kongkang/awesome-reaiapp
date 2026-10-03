/**
 * 合同测试套件。
 *
 * App 作者写的是**期望**（我贡献了哪些 Surface / Command / Intent，哪些必须能就绪），
 * 跑的是真实 App 代码接在 [`MockHost`] 上。这样「文档里写了但代码没实现」「代码实现了
 * 但 Manifest 没声明」这两类错，在开发者机器上就能发现，不用等 Host 拒绝安装。
 *
 * ## 这里**不**验证什么
 *
 * 绑定不被覆盖、停用只移除自己的绑定 —— 这些是 **Host 的保证**，App 无论怎么写都
 * 违反不了。把它们放进 App 合同套件只会给人一种「我测过了」的错觉。它们在 Host 自己
 * 的测试里。
 */

import type { AppManifestLike, MockHost, SurfaceObservation } from "./mock-host";

export interface ContractExpectations {
  /** Manifest 声明且 activate 必须注册的 Surface。 */
  surfaces?: string[];
  /** Manifest 声明且 activate 必须注册的 Command。 */
  commands?: string[];
  /** Manifest 声明的 Intent。 */
  intents?: string[];
  /** 打开后必须 `ready()` 的 Surface。 */
  readySurfaces?: string[];
  /** `"all"` 表示整个套件期间不得发起任何网络请求。 */
  forbiddenNetworkRequests?: "all";
  /** 所有存储访问必须落在这个命名空间下（通常等于 appId）。 */
  storageNamespace?: string;
  /** unmount 后 App 自建资源必须已释放（后续意图不得再到达）。 */
  noResourcesAfterUnmount?: boolean;
}

export interface ScenarioApi {
  host: MockHost;
  expect: (surface: SurfaceObservation | undefined) => SurfaceMatchers;
}

export interface ContractScenario {
  name: string;
  run(api: ScenarioApi): void | Promise<void>;
}

export interface ContractSuiteConfig {
  /** App 目录，相对于合同测试文件。 */
  appDirectory: string;
  /** 目标 Host API 版本。 */
  hostApi: string;
  expect: ContractExpectations;
  scenarios?: ContractScenario[];
}

/** 运行套件所需的外部能力，由 `reai-app contract-test` 注入。 */
export interface ContractRuntime {
  manifest: AppManifestLike;
  createHost(): MockHost;
  /** 有 DOM 环境时提供，用于 `toHaveFocus` 这类断言。 */
  hasDom: boolean;
}

export interface CheckResult {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface ContractResult {
  passed: boolean;
  checks: CheckResult[];
}

export interface ContractSuite {
  config: ContractSuiteConfig;
  run(runtime: ContractRuntime): Promise<ContractResult>;
}

/** Surface 断言。 */
export interface SurfaceMatchers {
  toBeOpen(): void;
  toHaveReceivedIntent(intent: unknown): void;
  toHaveFocus(label: string): void;
}

export function defineContractSuite(config: ContractSuiteConfig): ContractSuite {
  return {
    config,
    async run(runtime) {
      const checks: CheckResult[] = [];
      const record = (name: string, ok: boolean, detail?: string) => {
        checks.push({ name, ok, ...(detail === undefined ? {} : { detail }) });
      };

      const network = config.expect.forbiddenNetworkRequests === "all" ? blockNetwork() : undefined;

      try {
        const host = runtime.createHost();
        await host.installAndEnable();

        checkDeclaredVsRegistered(config, runtime, host, record);
        await checkReadySurfaces(config, host, record);
        checkStorageNamespace(config, host, record);
        await checkNoResourcesAfterUnmount(config, host, record);
        await runScenarios(config, runtime, record);

        if (network) {
          record(
            "整个套件期间不发起网络请求",
            network.calls.length === 0,
            network.calls.length === 0 ? undefined : `实际发起了：${network.calls.join(", ")}`,
          );
        }
      } finally {
        network?.restore();
      }

      return { passed: checks.every((c) => c.ok), checks };
    },
  };
}

function checkDeclaredVsRegistered(
  config: ContractSuiteConfig,
  runtime: ContractRuntime,
  host: MockHost,
  record: (name: string, ok: boolean, detail?: string) => void,
): void {
  const registration = host.registration;
  if (!registration) {
    record("activate 上报了注册项", false, "没有收到 app.registered");
    return;
  }

  const manifestSurfaces = (runtime.manifest.contributes?.surfaces ?? []).map((s) => s.id);
  const manifestCommands = (runtime.manifest.contributes?.commands ?? []).map((c) => c.id);

  compare("Surface", config.expect.surfaces, manifestSurfaces, registration.surfaces, record);
  compare("Command", config.expect.commands, manifestCommands, registration.commands, record);

  const manifestServices = (runtime.manifest.contributes?.services ?? []).filter(s => !s.implementation).flatMap(s => s.methods.map(m => `${s.id}#${m.id}`));
  compare("Service", undefined, manifestServices, registration.services ?? [], record);

  const manifestIntents = (runtime.manifest.contributes?.intents ?? []).map((i) => i.id);
  if (config.expect.intents) {
    const missing = config.expect.intents.filter((id) => !manifestIntents.includes(id));
    record(
      "Intent 与 Manifest 声明一致",
      missing.length === 0,
      missing.length === 0 ? undefined : `Manifest 里没有：${missing.join(", ")}`,
    );
  }
}

function compare(
  what: string,
  expected: string[] | undefined,
  declared: string[],
  registered: string[],
  record: (name: string, ok: boolean, detail?: string) => void,
): void {
  if (expected) {
    const missing = expected.filter((id) => !registered.includes(id));
    record(
      `${what} 全部已注册`,
      missing.length === 0,
      missing.length === 0 ? undefined : `activate 里没注册：${missing.join(", ")}`,
    );
  }

  // 这一条是合同的硬要求：声明与实际注册必须**精确一致**，多一个少一个都不行。
  const declaredSet = new Set(declared);
  const registeredSet = new Set(registered);
  const onlyDeclared = declared.filter((id) => !registeredSet.has(id));
  const onlyRegistered = registered.filter((id) => !declaredSet.has(id));
  const details: string[] = [];
  if (onlyDeclared.length) details.push(`声明了但没注册：${onlyDeclared.join(", ")}`);
  if (onlyRegistered.length) details.push(`注册了但没声明：${onlyRegistered.join(", ")}`);
  record(
    `${what} 声明与实际注册精确一致`,
    details.length === 0,
    details.length === 0 ? undefined : details.join("；"),
  );
}

async function checkReadySurfaces(
  config: ContractSuiteConfig,
  host: MockHost,
  record: (name: string, ok: boolean, detail?: string) => void,
): Promise<void> {
  for (const surfaceId of config.expect.readySurfaces ?? []) {
    const observation = await host.openSurface(surfaceId);
    const ok = observation.readyCount === 1 && observation.failCount === 0;
    record(
      `Surface ${surfaceId} 打开后恰好就绪一次`,
      ok,
      ok ? undefined : `ready ${observation.readyCount} 次、fail ${observation.failCount} 次${describeFailure(observation.failure)}`,
    );
  }
}

function checkStorageNamespace(
  config: ContractSuiteConfig,
  host: MockHost,
  record: (name: string, ok: boolean, detail?: string) => void,
): void {
  const namespace = config.expect.storageNamespace;
  if (!namespace) return;

  const strays = host.storageKeys().filter((key) => !key.startsWith(`${namespace}/`));
  record(
    `存储全部落在 ${namespace} 命名空间下`,
    strays.length === 0,
    strays.length === 0 ? undefined : `越界的键：${strays.join(", ")}`,
  );
  record(
    "没有越权访问未声明的 store",
    host.rejections.length === 0,
    host.rejections.length === 0
      ? undefined
      : host.rejections.map((r) => r.reason).join("；"),
  );
}

async function checkNoResourcesAfterUnmount(
  config: ContractSuiteConfig,
  host: MockHost,
  record: (name: string, ok: boolean, detail?: string) => void,
): Promise<void> {
  if (!config.expect.noResourcesAfterUnmount) return;

  for (const surfaceId of config.expect.readySurfaces ?? []) {
    const observation = host.surface(surfaceId);
    if (!observation) continue;

    await host.unmountSurface(observation.surfaceMountId);
    const before = observation.intents.length;
    try {
      await host.sendIntent(observation.surfaceMountId, { type: "__probe__" });
    } catch {
      // mount 已经不存在——正是期望的结果。
    }
    const reachedApp = observation.intents.length > before + 1;
    record(
      `Surface ${surfaceId} 卸载后不再接收意图`,
      !reachedApp,
      reachedApp ? "卸载后仍有意图到达 App，说明订阅没被清理" : undefined,
    );
  }
}

async function runScenarios(
  config: ContractSuiteConfig,
  runtime: ContractRuntime,
  record: (name: string, ok: boolean, detail?: string) => void,
): Promise<void> {
  for (const scenario of config.scenarios ?? []) {
    // 每个场景用干净的 Host：场景之间互相污染是最难查的一类测试假阳性。
    const host = runtime.createHost();
    try {
      await host.installAndEnable();
      await scenario.run({
        host,
        expect: (surface) => makeMatchers(surface, runtime),
      });
      record(`场景：${scenario.name}`, true);
    } catch (thrown) {
      record(`场景：${scenario.name}`, false, thrown instanceof Error ? thrown.message : String(thrown));
    }
  }
}

function makeMatchers(
  surface: SurfaceObservation | undefined,
  runtime: ContractRuntime,
): SurfaceMatchers {
  const required = (): SurfaceObservation => {
    if (!surface) throw new Error("这个 Surface 还没被打开过");
    return surface;
  };

  return {
    toBeOpen() {
      const s = required();
      if (s.unmounted) throw new Error(`Surface ${s.surfaceId} 已卸载`);
      if (s.readyCount !== 1) {
        throw new Error(
          `Surface ${s.surfaceId} 期望就绪一次，实际 ready ${s.readyCount} 次 / fail ${s.failCount} 次${describeFailure(s.failure)}`,
        );
      }
    },
    toHaveReceivedIntent(intent) {
      const s = required();
      const wanted = JSON.stringify(intent);
      const got = s.intents.map((i) => JSON.stringify(i));
      if (!got.includes(wanted)) {
        throw new Error(`Surface ${s.surfaceId} 没收到意图 ${wanted}，实际收到：${got.join(", ") || "（无）"}`);
      }
    },
    toHaveFocus(label) {
      required();
      if (!runtime.hasDom) {
        throw new Error(
          "toHaveFocus 需要 DOM 环境。请在合同测试里提供 DOM（例如注册 happy-dom），或改用协议级断言。",
        );
      }
      const active = globalThis.document?.activeElement as HTMLElement | null;
      const actual = active
        ? active.getAttribute("placeholder") ??
          active.getAttribute("aria-label") ??
          active.textContent?.trim() ??
          ""
        : "";
      if (actual !== label) {
        throw new Error(`期望焦点在「${label}」上，实际在「${actual || "（无焦点）"}」`);
      }
    },
  };
}

/**
 * 把失败原因摊开给开发者看。
 *
 * `userMessage` 是给最终用户的（「这个界面暂时打不开」），单独看等于没说。
 * `diagnostic` 才是「到底哪一行炸了」——测试输出里必须有它，否则开发者只能靠猜。
 */
function describeFailure(failure: { userMessage: string; diagnostic?: string } | undefined): string {
  if (!failure) return "";
  return `（${failure.userMessage}${failure.diagnostic ? `：${failure.diagnostic}` : ""}）`;
}

/** 临时封堵网络出口，记录任何尝试。 */
function blockNetwork(): { calls: string[]; restore(): void } {
  const calls: string[] = [];
  const g = globalThis as Record<string, unknown>;
  const saved: [string, unknown][] = [];

  const block = (name: string, describe: (args: unknown[]) => string) => {
    if (!(name in g)) return;
    saved.push([name, g[name]]);
    g[name] = (...args: unknown[]) => {
      calls.push(`${name}(${describe(args)})`);
      throw new Error(`合同禁止网络访问，但 App 调用了 ${name}`);
    };
  };

  block("fetch", (args) => String(args[0]));
  block("WebSocket", (args) => String(args[0]));
  block("XMLHttpRequest", () => "");
  block("EventSource", (args) => String(args[0]));

  return {
    calls,
    restore() {
      for (const [name, value] of saved) g[name] = value;
    },
  };
}
