# Driver V2 插件开发规范 v1

> 文档状态：除明确标为“规划，尚未实现”的章节外，均对应当前可运行实现
>
> 工具链合同：本仓库支持矩阵和 SDK/contract 为 `1.24.0`。实际已安装 Host 的支持范围仍须单独核对；源码合同不代表客户端已经发布。

> **本仓库验证入口**：在 `packages/` 安装冻结依赖，运行 `bun run test` 和 `bun run typecheck`。再进入目标 `plugins/<slug>/` 或样例目录，运行其 README 中的测试、类型检查、校验、构建、合同测试和打包命令。
> 本仓库在 `packages/` 提供 `bun run verify:pack`，把工具链 tarball 安装到仓库外 fixture 并验证 CLI、语言资源和 SDK 上传合同。真实 Host 安装生命周期仍须单独验收；本地 `file:` 依赖和 Mock Host 不能替代平台批准或真实安装证据。

>
> 最后核对：2026-10-06（本仓库同步后的合同与命令入口）
>
> 接口细节：[Driver V2 插件接口参考 v1](plugin-api-reference-v1.md)
>
> 生命周期：[App、Plugin 与 Device 生命周期 Hooks v1](lifecycle-hooks-v1.md)。插件不得在
> lifecycle Hook 中自行下载可执行依赖或静默完成授权。
>
> 界面长相：[ReAI Board 插件设计规范 v1](plugin-design-system-v1.md)（颜色 Token、图标、按钮档位、
> 抽屉与状态，配可运行示例页）
>
> 规范变更：[更新日志](CHANGELOG.md)。本目录任何规范更新都必须在同一提交或 PR 追加日志；
> 文档站构建会执行门禁，缺少日志时直接失败。

本文给插件开发者一条可以实际执行的路径：编写插件、声明最小权限、跑合同测试、打成
`.reaiapp`，再通过 Driver V2 的本机开发者通道安装和验证。

2026-10-02 新产品要求：全部插件的设置页底部必须提供版本号与「关于插件」；版本点击进入精确版本更新日志，关于进入开放平台具体应用。每次送审由开发工作流自动撰写版本介绍。见[设置页与版本文档规范](plugin-settings-and-release-notes-v1.md)；现有插件与服务需分别实施验收，不因规范新增而视为已实现。

独立插件的开发、构建与打包命令以本仓库各插件 README 为准。本机安装通过 Driver 的 Developer Mode 完成；该入口仍要求显式安装与权限同意，不代表正式审核或公开上架批准。

本文统一使用以下产品术语：

- **应用本身**：整个基于 Tauri 开发的 Driver V2，包括 Rust 核心、主界面、系统权限和本地存储；
- **插件**：用户安装到应用本身、在隔离 WebView 中运行的 `.reaiapp`。

已有协议名、代码类型或历史文档中的 `Host` / `App` 暂不改名；它们在本文分别指应用本身的核心
和插件。`appId` 等公开字段继续保持兼容，但后续产品讨论使用“应用本身”和“插件”，避免把两者混为一谈。

更长的 [ReAI App 开发指南 v1.1](app-development-guide-v1.md) 同时包含平台目标设计；
遇到两份文档不一致时，当前实现以本页、[接口参考](plugin-api-reference-v1.md) 和三份机器可读
事实源为准：

- `host-support-matrix.json`（仓库路径 `packages/contract/host-support-matrix.json`）：开放能力、权限、限额和稳定错误码；
- `app-manifest-1.1.schema.json`（仓库路径 `packages/contract/schemas/app-manifest-1.1.schema.json`）：Manifest 结构；
- `manifest-fixtures/`（仓库路径 `packages/contract/manifest-fixtures/`）：Manifest 合同正反样例。

## 1. 当前边界

当前已经支持：

- 一个 `web-surface` 主界面、侧栏入口、Command 和 App Intent；
- 按 `appId/storeId` 隔离的本机 KV；
- Tab 条目、`actionContext` 事件和存证取件；
- Manifest 权限声明、用户允许/拒绝、权限账本和调用时校验；
- `account.status@1`：只读取“账户功能是否启用、当前是否登录”；
- `os.notification.post@1`：经 Host Broker 发送最小纯文本系统通知；
- `system.tasks@1`：读取归一化版本状态并发起白名单 Host 设置任务；
- `titlebar.action@1`：由 Host 在当前 App 的标题栏、通知铃铛左侧渲染声明式动作；声明该能力时
  Manifest 的 `hostApi.range` 下界必须不低于 `1.2.0`；
- `agent.dsh@1`、`agent.session@1` 保持旧接口兼容；Host API 1.21 新增
  [`agent.session@2`](agent-service-v2.md)，以统一配置调用 Pi/DSH/Codex，省略 runtime 使用全局默认。
  均为 `grantGated`，须平台批准及用户允许；v2 无需同时授予 v1，也不要求插件新增引擎设置页；
- Host API 1.23 新增 [`contributes.agentFeatures`](#46-声明-agent-功能默认值contributesagentfeatureshost-api-123)：
  声明 Agent 功能的默认提示词模板、参数槽与工具基集，配合 `featureRef` 供后续配置页合并默认值与用户覆盖；
- `voice.input@1`：Host 托管录音与本地识别；当前只授予 `com.reai.voice`，不等于其他插件已经可以
  调用 Voice；
- macOS 本机 Developer Mode 导入开发者自己的 `.reaiapp`。
- `requirementsVersion: "1.2"` 的 `managed_executable` 依赖：Host 从签名目录解析
  `.reairuntime`，合并展示同意项，并以复合 journal 提交插件与资源；当前只用于受审核官方资源。

Host API 1.3 起，官方 seed 插件还可以用两条云端纯管道（第三方暂不开放，见下）：

- `cloud.model.invoke@1`：用用户账户额度中转各家大模型 API；
- `cloud.workflow.invoke@1`：调用已发布的云端工作流；
- `voice.deliver@1`：把最终文本写入交付时当前输入框；
- `voice.context@1`：显式读取焦点控件文字、应用粗分类与有界焦点窗口截图，供插件自己拼 AI 上下文；不含窗口标题、文件路径或整屏采集，也不会主动申请屏幕录制权限。
- `terminal.session@1`：Host API 1.15 的托管交互 Shell 会话，只对命中独立审核批准的包开放；
  UI 是插件，PTY、进程和环境仍属于 Host。

Agent v2 可用 `run` 工具执行受控文件处理：仅 macOS、mounted 工作区、yolo 档位，并单独声明和获准
`local.terminal.exec@1`（平台 capability + 用户 permission）。仅支持 awk/wc/sort/diff，不提供任意 Shell、
构建程序或插件直接 exec。参数、隔离和错误码见 [受控执行合同](agent-controlled-run.md)。

App Service 的最小类型化调用子集已实现（Host API 1.14 起），见 [接口参考](plugin-api-reference-v1.md)。具体 Provider 的可用性仍须按安装版本核对；Voice 文本服务见 [实现候选合同](voice-request-text.md)。

当前尚未支持：

- 未经管理员审核的插件使用上述 `grantGated` 能力。Manifest 只能申请，不能自我批准；生产安装还要
  由机器 policy 按 `appId + publisherId + version + packageSha256` 命中批准，并在安装时取得用户同意。
  第三方默认会被 `APP_CAPABILITY_NOT_GRANTED` 拒绝，这是**预期的 fail-closed，不是 bug**；
- 插件声明 Agent Scene、动态 Agent Tool Catalog 和同会话能力热更新；
- 无主 Surface 的 headless Service App；
- 未审核插件的公开分发、在线更新和团队空间切换。
- Windows 第三方本地安装；当前版本不支持，Host 会拒绝该路径。

开发者模式只用于开发调试，不代表平台审核通过；本地包不能公开分发。插件作者固定可以测试且
不占体验者名额，并可为同一插件 Product 添加最多 5 名开发期体验者。每名体验者仍须自行显式安装
开发包，只能授权并访问自己的数据；被移出名单后，下一次开发态 OAuth 调用立即 fail closed。
开发期体验与公开分发审核始终是两条不同通道，体验者资格不会让未审核插件进入 App Store。

插件与硬件的边界是硬约束，不随版本放宽：插件只暴露可绑定事件（`contributes.commands`），硬件输入与事件的
绑定归应用本身的键位设置，插件不内置绑定逻辑、设置页也不出现绑定配置——2026-08-16 架构拍板，见
[开发指南 · 插件与硬件解耦](app-development-guide-v1.md#插件与硬件解耦2026-08-16-架构拍板)。

### 1.1 开发前先做交付分层（Direct 受管运行时一期已实现）

插件从设计和开发开始就必须区分“哪段能力由谁运行”和“哪份产物由谁安装、更新、回滚与卸载”。
这是一条**逻辑与交付边界**，不是要求源码必须拆成三个目录、三个仓库或三个进程。一个纯界面插件
可以只有 `.reaiapp`；只有出现独立可执行闭包、模型或用户数据时，才增加对应生命周期。

开发者先按下表给每项能力定归属：

| 能力或产物 | 应归属 | 开发约束 |
|---|---|---|
| 所有插件都依赖的权限、安装修复、设备、能力与基础 UI | App 主体 / Host Capability | 只能通过版本化 Host 合同使用；不得因单个插件缺依赖而失效 |
| 插件界面、业务编排和小型静态代码 | `.reaiapp` | 随插件审核和版本化；不携带数百 MiB、需要独立升级回滚的运行时 |
| ReAI 构建、签名并审核的平台可执行闭包 | Host 受管资源 | 插件只声明稳定资源身份和用途；下载地址、摘要、签名、探针与落位由 Host 的受信目录决定 |
| 用户主动选择并自行安装的软件 | `optional_external_tool` | Host 做无副作用探测并展示用户触发的修复流程；插件不得直接扫描 PATH、spawn 或静默安装 |
| 模型、音色、固件、媒体等非执行内容 | `downloaded_content` | 与可执行 helper 分开下载、校验、升级和清理，不得下载后当代码执行 |
| 声纹、输出、历史、配置等用户数据 | App 数据合同 | 不随插件 UI 或可执行 runtime 的卸载自动删除；删除必须单独让用户选择 |

以下规则从设计阶段起适用于官方插件和未来第三方插件：

- 插件专用的大运行时不得上浮为 Host 启动条件，也不得为了省事塞回 `.reaiapp`。
- ReAI 受管 runtime 不得回退到用户机器上的 Node/Bun、外部 checkout、profile、插件目录或 PATH；
  `optional_external_tool` 是用户明确选择的另一条合同，不能与受管 runtime 混用。
- 插件代码不得自行下载、解包、安装或执行 runtime，也不得硬编码 App Bundle、AppData 或其他插件的路径。
- 可选依赖缺失时，UI、设置、修复与卸载入口仍须可用；必需依赖必须在复合安装成功后才提交插件，
  不能留下“已安装但打不开”的假成功状态。
- Store 与 `direct` 可以采用不同物理交付方式，但插件的逻辑分层、资源身份和降级语义必须一致。

> **当前实现边界**：Runtime Component 仍只接受恰好一个 `web-surface`；这项限制没有变化。
> 非空 `requirements` 已不再一律拒绝：当前机器可读合同只开放
> `requirementsVersion: "1.2"` + `kind: "managed_executable"` +
> `provision.mode: "host_managed_resource"`，并只解析 Host 登记的 probe 和稳定 `resourceId`。
> 插件不得声明 URL、摘要、签名者、磁盘路径或任意命令。Direct 生产安装还依赖 ReAI 发布签名目录、
> 编译期公钥和已签名/公证的 `.reairuntime`；这些发布资产未配置时 Host fail closed。其他依赖分类、
> 复合 Runtime Component、Store 渠道下载可执行代码仍是目标合同。具体字段始终以 Schema、支持矩阵和
> `managed-requirements-v1.2.json`（仓库路径 `packages/contract/managed-requirements-v1.2.json`） 为准。

### 1.2 改成插件不等于重新设计界面

把现有 Host 页面、内置功能或官方工具迁移为 `.reaiapp`，只改变交付、权限与运行边界，不自动取得
修改产品界面的授权。已有确认设计稿或已验收版本时，迁移后的插件必须把它作为界面和交互的唯一
基线，保留原有信息架构、尺寸、文案、状态和操作入口；不得另起一套“简化版”界面，也不得因为
插件 Surface、SDK 或 Host Title Bar 的接入而顺带改版。

只有另有明确的 UI/UX 变更需求时，才可以偏离原基线，并应单独记录设计范围与验收标准。迁移 PR
至少包含以下回归证据：

- 设计稿中的关键结构、固定尺寸和文案与插件实现直接对照；
- 原有主要交互路径在插件 Surface 中仍可用；
- Host Title Bar 只承接平台拥有的区域，正文不复制标题栏，也不因此丢失原有业务动作；
- 指定设计稿文件保持不变，除非需求本身明确要求更新设计稿。

## 2. 准备环境

需要 Bun、本仓库，以及一个正在运行的 Driver V2 开发版或安装版。先安装 Platform 依赖；每个
插件再在自己的目录安装自己的冻结依赖，不能借用 Driver workspace：

```bash
cd /path/to/awesome-reaiapp/packages
bun install --frozen-lockfile --ignore-scripts
cd ../examples/todo-app
bun install --frozen-lockfile --ignore-scripts
```

仓库内可运行的参考插件是
`examples/todo-app`（仓库路径 `examples/todo-app/README.md`）。它覆盖 Surface、Command、
Intent、KV、合同测试和打包，但刻意不申请任何权限。

标题栏动作的最小第三方样例是
`examples/titlebar-actions-app`（仓库路径 `examples/titlebar-actions-app/README.md`）。它不进入
Host 内置 seed，工具链四连后必须通过 Developer Mode 本地安装，正好覆盖普通插件路径。

如果插件放在仓库之外，本地联调阶段可以在自己的 `package.json` 中用 `file:` 指向 CLI、SDK
和测试包：

```json
{
  "name": "my-reai-app",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "reaiApp": { "entry": "src/app.ts" },
  "scripts": {
    "test": "bun test tests",
    "typecheck": "tsc --noEmit",
    "validate": "reai-app validate .",
    "build": "reai-app build .",
    "test:contract": "reai-app contract-test . --host-api 1.1",
    "pack": "reai-app pack . --out my-reai-app-1.0.0.reaiapp"
  },
  "devDependencies": {
    "@reai/app-cli": "file:/absolute/path/to/awesome-reaiapp/packages/cli",
    "@reai/app-contract": "file:/absolute/path/to/awesome-reaiapp/packages/contract",
    "@reai/app-sdk": "file:/absolute/path/to/awesome-reaiapp/packages/sdk",
    "@reai/app-test": "file:/absolute/path/to/awesome-reaiapp/packages/test-kit",
    "typescript": "~5.6.0"
  },
  "overrides": {
    "@reai/app-cli": "file:/absolute/path/to/awesome-reaiapp/packages/cli",
    "@reai/app-contract": "file:/absolute/path/to/awesome-reaiapp/packages/contract",
    "@reai/app-sdk": "file:/absolute/path/to/awesome-reaiapp/packages/sdk",
    "@reai/app-test": "file:/absolute/path/to/awesome-reaiapp/packages/test-kit"
  }
}
```

随后在插件目录执行一次 `bun install` 并提交生成的 `bun.lock`；以后统一执行
`bun install --frozen-lockfile`。`file:` 只证明本地联调，不是独立交付证据：发布前还要把 Platform
包成 tarball，将插件复制到仓库外再跑 test / typecheck / validate / build / contract-test / pack。

## 3. 最小项目

```text
my-app/
├── app.manifest.json
├── package.json
├── bun.lock
├── src/app.ts
├── tests/contract.suite.ts
└── assets/icon.png
```

完整 Manifest 不建议从文档手抄，请复制
`todo-app/app.manifest.json`（仓库路径 `examples/todo-app/app.manifest.json`） 后修改。至少保持：

- `appId` 使用反向域名格式，并作为插件长期身份；
- `hostApi.range` 至少包含你实际使用的 Host API；当前接受三段版本的精确值、比较器、caret 与
  tilde（例如 `>=1.2.0 <2.0.0` 或 `^1.2.0`），使用 `system.tasks@1` 时必须包含 `1.2.0`；
- 当前只声明一个必需、非 Headless、`on-demand` 的 `web-surface` 组件；
- 没用到的 `requirements`、网络、导入导出、硬件服务和迁移保持为空；
- 代码中注册的 Surface、Command 必须与 `contributes` 精确一致。

最小入口代码：

```ts
import { defineApp } from "@reai/app-sdk/v1";

export default defineApp({
  async activate(ctx) {
    const store = ctx.storage.private("state");

    ctx.surfaces.register("main", async (surface) => {
      const stored = await store.get<unknown>("count");
      let count = typeof stored === "number" && Number.isSafeInteger(stored) ? stored : 0;
      let writes = Promise.resolve();
      const button = document.createElement("button");
      button.textContent = `已点击 ${count} 次`;

      const onClick = () => {
        writes = writes.then(async () => {
          count += 1;
          await store.set("count", count);
          button.textContent = `已点击 ${count} 次`;
        });
      };

      button.addEventListener("click", onClick);
      surface.root.replaceChildren(button);
      surface.ready();

      return () => {
        button.removeEventListener("click", onClick);
        surface.root.replaceChildren();
      };
    });
  },
});
```

必须遵守三个生命周期约束：

1. Surface 和 Command 只能在 `activate()` 期间注册。
2. 每次 Surface mount 必须恰好调用一次 `surface.ready()` 或 `surface.fail()`。
3. mount 返回幂等 cleanup；当前生产 Host 还不能保证所有关闭路径都会送达 cleanup / `deactivate()`，
   因此不要让未释放资源产生外部副作用，并以 SDK 后续补齐的销毁确认为准。

### 3.1 单层页面框架：Host Title Bar + 插件 `main-body`

当前 macOS Host 会让插件 Surface 的背景画布延伸到窗口 `y=0`，再把独立的原生 Title Bar
sibling WebView 盖在最上方。**窗口绝对坐标 `0 <= y < 44px` 完全归 Host**。这 44px 同时承担：

- 左侧页面路径：根页只显示 App 名，例如 `Voice`；二级页显示返回按钮与 `Voice / 设置`，
  不加冗余的 `Apps /` 前缀；
- 中间窗口拖拽区域；
- 右侧图标堆栈：当前 App 的声明式动作位于通知按钮左侧。

因此插件不再创建第二层 `main-title` / page header，也不在 44px 下方复制一套“左标题、右按钮”带。
蓝色标题栏 hover 渐变同样不属于新规范。路径祖先应可点击、当前项只读并带
`aria-current="page"`；二级页面还应保留符合桌面习惯的独立返回按钮。以上路径和返回必须由 Host
渲染与路由，插件不能用绝对定位把自己的 DOM 假装放进 Title Bar。

插件 DOM 从 `main-body` 开始。`main-body` 填满 44px 以下的剩余区域。单栏插件由 `main-body`
直接承担纵向滚动；多栏插件可以让 `main-body` 使用 `overflow: hidden`，再由内部各栏管理自己的
业务滚动，但所有滚动边界仍止于 `y=44px`，不会覆盖 Host 的拖拽和点击层。标题、说明、搜索、
标签页和设置内容都在这个正文区域。需要留在正文顶部的业务工具条可以在 `main-body` 内部
sticky，但它的 `top` 是 `0`（相对滚动容器），不是再造一条系统页头。

Host 在插件文档启动阶段注入 `--reai-plugin-titlebar-safe-top`：macOS 原生 sibling Title Bar 为
`44px`，没有这层原生标题栏的平台为 `0px`。插件根框架只消费一次；`44px` fallback 只用于脱离
Host 的浏览器预览。标准骨架如下：

```css
html,
body,
#app {
  height: 100%;
  margin: 0;
  overflow: hidden;
}

.plugin-main-frame {
  box-sizing: border-box;
  height: 100%;
  min-height: 0;
  padding-top: var(--reai-plugin-titlebar-safe-top, 44px);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.main-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
}
```

Host Title Bar 与插件正文的全宽交界必须满足基础视觉规则：**同色连续，异色内缩**。同色模式使用
同一主题背景 Token，并以最终合成色一致为准，不额外加 padding、卡片套壳或分割线。若正文顶部
必须使用不同颜色，第一块异色 Surface 应内缩到 `main-body` 内，桌面默认 `16px`、紧凑布局最低
`12px`，且间距为 4px 的倍数。单独添加 1px 分割线不算留白，不能修复两个全宽大色块零距离硬切。

示意样式如下；实际变量名应映射到当前主题 Token：

```css
/* 模式一：Title Bar 安全区与正文使用同一最终背景色。 */
.plugin-root--continuous,
.plugin-root--continuous .main-body {
  background: var(--bg);
}

/* 模式二：父背景连续，异色 Surface 在正文内形成真实留白。 */
.main-body--inset {
  padding: 16px;
  background: var(--bg);
}

.main-body--inset > .top-surface {
  background: var(--card-bg);
  border: 1px solid var(--card-border);
  border-radius: 12px;
}
```

视觉衔接只能在插件自己的 Surface 内实现，不能通过 Host DOM、Host CSS、标题栏伪元素或全局样式
实现，也不能让其他插件被动继承。浅色与深色主题都必须验收：同色模式无色差和 1px 接缝；异色模式
至少露出 `12px` 连续父背景，异色块不得全宽顶到 Title Bar 下沿。

`--reai-plugin-titlebar-safe-top` 属于**插件 Surface 自己的文档坐标系**。App Store、占位页、设置等 Host 自有页面由
Host `.app-main` 统一让位，不能再套插件变量，否则会形成 44 + 44 = 88px。抽屉和遮罩的背景可以
铺满 `main-body`；交互弹层应锚定 `main-body`（例如 `position:absolute`），不能用 viewport
`position:fixed` 绕过根安全区进入 Host 命中层。

不要尝试用 `z-index`、`stopPropagation()` 或透明覆盖层抢回事件：两个 WebView 不在同一个 DOM。
页面级动作使用下一节的 `titlebarActions`；插件仍不得模拟交通灯、拖拽条、通知按钮或 Host 路径。

> **当前能力边界**：`titlebar.action@1` 已开放；通用的子路由 / 面包屑贡献合同尚未进入公开 SDK。
> 上述路径与返回是已经拍板的统一设计目标，不代表开发者现在可以写一个未登记字段。能力开放前，
> 插件不得用 DOM 注入绕过边界；确需二级页时，可在 `main-body` 内保留内容级返回作为兼容路径。

当前开发者安装只开放 macOS；跨平台代码仍必须消费 Host Token，不能按 UA、平台名或窗口装饰自行
猜测标题栏高度。

### 3.2 声明 Host 标题栏动作

Manifest 同时声明通用能力与 contribution：

```json
{
  "requires": {
    "hostCapabilities": ["surface.main@1", "sidebar.item@1", "titlebar.action@1"]
  },
  "contributes": {
    "titlebarStatus": { "label": "已连接", "tone": "success" },
    "titlebarActions": [
      {
        "id": "settings",
        "label": "打开设置",
        "icon": "settings",
        "text": "设置",
        "variant": "outlined",
        "showOnTitlebarHover": false,
        "intent": { "type": "open-settings" }
      }
    ]
  }
}
```

- 每个 App 最多 3 个动作；`id` 在 App 内唯一，`label` 最多 48 字符，`text` 最多 12 字符。
- `icon` 与 `text` 至少一个非空，可单独或同时使用。公共图标清单固定为：`settings`、`plus`、
  `search`、`clock`、`external-link`、`more-vertical`、`rotate-cw`、`square`、`mic`、`pen`、`folder`。
- `variant` 可省略（`default`），或声明 `outlined` / `danger`，由 Host 统一渲染描边或危险动作。
- 可选 `titlebarStatus` 提供最长 24 字符的静态状态胶囊；`tone` 可用 `neutral`、`success`、
  `warning`、`danger`。状态与动作都要求 `titlebar.action@1`，且都不允许插件注入 DOM/CSS。
- `intent` 必须是 JSON object，规范化紧凑 JSON 预算最多 4096 bytes、最多嵌套 8 层；字符串按
  实际 UTF-8 JSON 字节、每个 number 保守按 24 bytes 计费，保证 CLI 与 Rust Host 边界一致。
- `showOnTitlebarHover` 省略或为 `false` 时常驻，适合设置、帮助等需要持续可发现的入口；设为
  `true` 时普通态隐藏，适合低频辅助动作，鼠标进入**整条 44px 标题栏**或键盘 Tab 聚焦按钮时
  显现。通知面板打开期间，当前 App 的动作暂时隐藏。
- Host 只渲染白名单图标和纯文本，不读取插件 DOM/CSS/SVG/网络资源。动作只属于当前 Ready 的
  Surface；候选 App Ready 后原子替换，离开、停用、卸载或 contribution 消失后自动移除。

Surface 通过 `onIntent()` 接收 Host 信封；同时验证 `source`、`actionId` 和 payload，不能只看
payload：

```ts
import type { HostTitlebarActionIntent } from "@reai/app-sdk/v1";

type SettingsPayload = { type: "open-settings" };

const stop = surface.onIntent((raw: unknown) => {
  const intent = raw as Partial<HostTitlebarActionIntent<SettingsPayload>>;
  if (
    intent.source === "host.titlebarAction" &&
    intent.actionId === "settings" &&
    intent.payload?.type === "open-settings"
  ) {
    openSettings();
  }
});
```

Host 会重新读取已安装 Manifest 中的 intent，并校验真实主壳、当前 presentation token、actionId 与
mount；前端镜像不携带 payload。切换瞬间的陈旧点击会被静默拒绝并写诊断日志，不保证弹出提示。
`source` 是 Host 事件保留字段，普通 App-to-App `apps.open()` 的顶层 input 若含 `source` 会以
`BRIDGE_BAD_PARAMS` 拒绝，因此 peer 插件不能伪造同形标题栏信封。mount cleanup 中调用 `stop()`。
完整可运行代码见 `examples/titlebar-actions-app`。

#### 设置动作是有真实返回出口的往返开关

已经由 Host 登记为导航开关的 `settings` 动作遵循统一交互：第一次点击进入设置页，按钮保持按下并
暴露 `aria-pressed="true"`；再次点击同一按钮仍投递 Host 从 Manifest 重读的可信
`open-settings` intent，插件处理器必须根据当前页面把它解释为“返回插件根页”。进入设置时插件上报
`{ key: "settings", label: "设置" }`，完成返回后上报 `null`；Host 只以这个导航回报解除按下态，
不能在 intent 刚投递时先把按钮弹起。按下时
Host 把按钮的可访问名改为“返回插件首页”。

插件还必须申请 `commands@1`、在 Manifest 声明并在 `activate()` 注册返回 Command，供面包屑等
其他 Host 返回入口使用。只供 Host 导航使用的命令写成 `callers: ["host"]` 和
`bindingPickerVisible: false`，避免出现在键位动作选择器。设置读取失败、缺配置等错误态也不能跳过导航上报；只要页面真实进入设置，按钮状态就必须
同步。当前通用子路由注册尚未开放为 Manifest 字段，只有 Host 显式登记的集成插件启用此行为；
未登记动作仍是普通单向 intent，插件不得在自己的 Surface 中复制一颗假标题栏按钮。

### 3.3 设置入口必须定向定位并给出瞬时反馈

凡是按钮、空状态或错误提示以“配置… / 去设置 / 授权 / 管理…”等文案把用户带到设置页，
导航参数都必须携带稳定的目标 section/action，不能只切换到设置页后让用户再次寻找。目标页面挂载后
必须完成同一个反馈闭环：

1. 用 `scrollIntoView()` 将目标区滚动到可见位置（通常 `block: "center"`，固定页头场景可用
   `block: "start"` 并留出 scroll margin）；
2. 目标容器使用 `tabindex="-1"` 接收程序化 focus，滚动后用 `focus({ preventScroll: true })`
   保留键盘与辅助技术上下文；
3. 目标卡片使用主题 token 做一次 1.5–2 秒的背景色高亮闪烁，然后自动恢复。不能只依赖细边框或
   outline；`prefers-reduced-motion: reduce` 下取消动画，但仍短暂保留高亮背景；
4. 回归测试至少断言入口映射到正确目标、发生滚动/聚焦，并挂上会自动移除的瞬时高亮状态。

通用“打开设置”入口没有唯一目标时可以回到设置页顶部并聚焦标题；只要入口文案已经指向某项具体
设置，就必须精确定位。Host 系统设置任务由 Host 实现这套反馈，插件自有设置页由插件实现，二者
不能把职责互相甩给对方。

### 3.4 一次性操作点下去必须立刻有反馈

凡是点下去要等 Bridge 调用、网络请求或 Host 任务的按钮（安装、下载、发送、保存、同步、授权、
生成），都按设计规范 [§3.6 操作后立即反馈](plugin-design-system-v1.md#action-feedback) 实现，
这是交付门槛：

1. 在第一个 `await`（包括第一次 `ctx.*` Bridge 调用）**之前**把按钮改成进行时并禁用，
   100ms 内要看得见变化；
2. 超过 1 秒在按钮下方显示真实进度；Bridge 调用本身不回报字节时，显示当前阶段名 + 已用时间 +
   不确定进度条，不编百分比；
3. 处理函数入口用进行中标志挡住重复触发；
4. 完成要有完成态，失败按 [§6.0](plugin-design-system-v1.md#waiting-failure-minimum) 给真实原因
   和「重试」；错误码、插件与 Host 版本、可复制诊断仅在用户明确开启 Host 开发者模式时显示。

交给 Host 去做的事（例如 `ctx.systemTasks` 发起的系统任务、Host 弹出的确认框）由 Host 显示它那一段
的进度；插件自己的按钮在把请求交出去之前，仍要先按第 1 条变样。

## 4. 声明用户权限并调用受控接口

当前开放三项本机设备级插件权限：`account.status@1`、`os.notification.post@1` 与
`http.fetch@1`。权限决定按
`appId` 和声明摘要隔离；一个插件获准不能替另一个插件获准，插件权限也不等于对应的 macOS
系统权限。

插件详情中的用户决定只作用于当前显示的插件。

### 4.1 读取账户状态

权限不是模糊字符串。每一项都必须说明用途以及是否为插件核心功能所必需：

```json
"permissions": [
  {
    "id": "account.status@1",
    "purpose": "在插件首页显示是否需要先登录外脑账户",
    "required": false
  }
]
```

然后通过 SDK 调用，不要直接操作 Bridge：

```ts
import type { AppContext, AccountStatusResult } from "@reai/app-sdk/v1";

export async function readAccountStatus(ctx: AppContext): Promise<AccountStatusResult> {
  return await ctx.account.status();
}
```

返回值只有 `{ enabled: boolean, loggedIn: boolean }`，不会返回用户 ID、邮箱、Team、Project、
余额、access token 或 refresh token。这是刻意的边界，不是待补功能：**外壳不替插件转发身份**。
已定架构下每个插件是独立的外脑 OAuth App，需要用户身份时应当经外壳通道用插件自己的令牌去取，见
[云能力与权限分层基线](wainao-cloud-workflow-distribution-v1.md)。

`oauthAppId` 始终是插件自己的 OAuth Client ID；Manifest `appId`、OAuth Client ID 和发布版本是三个不同身份。
上架包必须声明当前产品的 `oauthAppId` 和团队 `publisherId`，Product ID 单独记录在提交配置；完整字段映射、最终 ZIP 预检和 `universal` 的正确位置见[插件上架打包与提交规范](plugin-submission-v1.md)。
Host 根据安装来源自动选择通道：Catalog 安装读取 public metadata；LocalDeveloper 安装用当前外壳账号的
`oauth:delegate` 令牌读取 `delegated-development` metadata，并把授权固定到当前 draft revision。两种模式分开保管凭据，
开发 token 不会被公开版沿用。开发运行的每次 `oauth_app` 网络调用都会实时重验体验者资格、revision、scope 和
redirect 快照；体验者被移除或草稿切换后，下一次调用立即 fail closed。插件仍拿不到 Host 或自己的 token 明文。

不要在 `activate()` 中无条件调用并让异常向外传播。新安装插件的权限初始为 `pending`；用户拒绝
后为 `denied`。更适合在用户点击相关功能时调用，或者捕获稳定错误并展示操作说明：

```ts
try {
  const status = await ctx.account.status();
  // 根据 status.enabled / status.loggedIn 更新插件自己的界面。
} catch (error) {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code: unknown }).code)
      : "UNKNOWN";

  if (code === "PLUGIN_PERMISSION_REQUIRED" || code === "PLUGIN_PERMISSION_DENIED") {
    // 提示用户到“已安装 → 当前插件 → 权限”处理。
  } else {
    throw error;
  }
}
```

当前 `required` 是 Host 展示和权限状态聚合所需的合同信息；授权仍由用户明确决定，每次真正
调用时 Bridge 都会再次校验。

### 4.2 当前接口：发送系统通知

Manifest 先声明用途：

```json
"permissions": [
  {
    "id": "os.notification.post@1",
    "purpose": "任务完成后提醒用户回来查看结果",
    "required": false
  }
]
```

插件只通过 SDK 提交纯文本：

```ts
await ctx.notifications.post({
  title: "任务已完成",
  body: "打开 ReAI Board 查看结果",
});
```

通知有四层独立门禁：Manifest 声明、用户对当前插件允许、系统通知权限已开启、有效 Bridge 会话。
ReAI Board 启动只查询系统状态，绝不自动申请；macOS 用户必须亲自点击首次引导中的“开启通知”
或设置页的“允许通知”。首次未决定时会直接弹出 macOS 系统确认；如果用户已经拒绝，macOS
不会再次展示首次确认，只能由用户从系统设置重新开启。
插件不能请求系统授权，也不能直接访问 Tauri notification API。当前不支持声音、图标、点击动作、
URL、调度、读取或取消通知。
调用成功返回 `{ queued: true }`，只代表 Host 已加入本地发送队列，不代表系统最终展示通知。
`title` 与 `body` 去除首尾空白后都不能为空；标题最多 80 个字符，正文最多 500 个字符。
Host 会在标题中加入插件名与 appId 指纹，并限制每个插件每 10 秒最多发起 5 次通知请求。通知被拒、
尚未开启或超过速率时，插件应展示可执行说明，不能循环重试或尝试自行触发系统授权。
appId 指纹用于稳定追踪来源；Manifest 显示名不是可信发布者身份，不能只凭显示名判断通知来自
ReAI 官方。
当前 Windows/其他非 macOS 构建由 Host 将系统通知权限视为 `granted`；插件级 Manifest 声明和
用户授权仍然照常执行。

### 4.3 场景化通知目标规范（规划，尚未实现）

> 本节定义下一版通知合同和分阶段实现边界。当前 Schema、SDK 与应用本身尚不接受这里的新字段；
> 现在开发插件必须继续使用 4.2 的 `os.notification.post@1` 与 `ctx.notifications.post()`。

#### 4.3.1 两层权限与总开关

通知权限分成两层，不能互相替代：

1. **应用本身 → 操作系统**：应用本身直接查询 macOS / Windows 的系统通知权限；只有用户在应用本身
   的首次引导或设置页明确点击后才能发起系统授权请求。插件不能查询、申请或修改系统权限。
2. **插件 → 应用本身**：每个插件按本机安装和 `appId` 单独申请通知权限。应用本身拥有系统权限，
   不代表某个插件已经获得发送许可；一个插件获准也不能替另一个插件获准。

插件层包含一个“整个插件的通知总开关”，并在其下展示插件声明的每个通知场景、用途说明、触发位置
和用户选择的透传深度。总开关关闭时，该插件所有场景都等同于 `off`；总开关打开也不能越过单个场景
的限制。

透传深度固定排序为 `off < in_app < system`：

| 深度 | 应用本身的行为 |
|---|---|
| `off` | 不生成通知，也不写通知历史 |
| `in_app` | 写入本地通知历史，在应用本身右上角通知铃铛中展示，不透传到操作系统 |
| `system` | 先完成 `in_app` 行为，再由应用本身向操作系统投递系统通知 |

插件声明默认深度和允许上限，用户可以按场景下调为 `in_app` 或 `off`，但应用本身和插件都不能替用户
静默上调。系统权限不可用时，新的场景化接口把 `system` 降级为 `in_app` 并在回执中说明原因，插件
不得循环重试。

#### 4.3.2 Manifest 场景声明

下一版使用新权限 `notifications.publish@1`，并通过 `contributes.notificationScenes` 声明所有场景：

```json
{
  "permissions": [
    {
      "id": "notifications.publish@1",
      "purpose": "在后台任务完成或需要确认时提醒用户",
      "required": false
    }
  ],
  "contributes": {
    "notificationScenes": [
      {
        "key": "task.completed",
        "label": "任务完成",
        "description": "用户发起的后台任务完成时提醒",
        "trigger": "任务状态由 running 进入 completed",
        "format": "text",
        "defaultLevel": "in_app",
        "maxLevel": "system"
      }
    ]
  }
}
```

字段约束：

- `key` 是插件内稳定且唯一的场景 key；发布后不能把同一个 key 改作另一种含义；
- `label`、`description` 和 `trigger` 必须能直接展示给用户，说明“为什么提醒”和“代码在什么业务状态
  触发”，不能只写“改善体验”；开发者还应在代码评审中把每个调用位置映射回对应 key；
- 第一阶段 `format` 只允许 `text`，通知内容仅含受限的 `title/body`；图标、声音、附件、富文本、
  动作按钮和任意 URL 暂不进入最小合同；
- `defaultLevel` 只能是 `in_app | system`；`maxLevel` 不能低于默认值；
- 新增场景、改变含义、扩大 `maxLevel` 或改变格式会更新声明摘要并回到待确认状态。纯文案修正是否
  重新确认由正式 Schema 版本锁定，首版实现从严处理。

#### 4.3.3 启动授权交互

应用本身每次启动都检查已安装且已启用插件的通知声明，但只对 `pending`（新安装或声明摘要变化）
的插件提示：

1. 主窗口 Ready 后最多弹出一次由应用本身绘制的汇总授权框，不允许每个插件各弹一层；
2. 授权框展示插件名、通知总用途和场景清单，提供“允许”“拒绝”“稍后决定”；
3. “允许”开启插件总开关，并以场景默认深度为初值；“拒绝”记录明确决定，不在以后每次启动重复
   打扰；“稍后决定”保留 `pending`，后续启动可再次集中提示；
4. 插件可以在自己的功能页解释用途并引导用户打开应用本身的通知设置，但不能自己弹系统授权框，
   也不能直接改变决定；
5. 插件授权框与操作系统授权框不连环自动弹出。即使场景允许 `system`，也要等用户在应用本身的
   首次引导或设置页主动开启系统通知。

已授权插件新增或扩大通知场景时，只重新确认变化部分；旧场景在声明未变时保留用户选择。插件停用
时不触发通知，卸载时清除插件通知设置；应用本身的系统权限不随单个插件卸载而改变。

#### 4.3.4 SDK、传递链路与回执

目标 SDK 只接受已声明的 `sceneKey`、请求深度和纯文本内容：

```ts
const result = await ctx.notifications.publish({
  sceneKey: "task.completed",
  requestedLevel: "system",
  title: "任务已完成",
  body: "打开 ReAI Board 查看结果",
});
```

应用本身必须按固定链路处理：

```text
插件触发
  → 校验有效会话、安装状态和启用状态
  → 校验 notifications.publish@1 与插件通知总开关
  → 校验 sceneKey 已声明，并读取该场景说明、格式和用户透传深度
  → 校验 requestedLevel、title/body、来源、去重和速率
  → effectiveLevel 不是 off 时写入应用本身的本地通知历史
  → effectiveLevel 是 system 时再由应用本身向操作系统投递
  → 返回实际存储与透传结果
```

回执至少包含 `notificationId`、`stored`、`requestedLevel`、`effectiveLevel` 和可选 `reason`。插件只能
请求不高于 Manifest `maxLevel` 的深度；最终 `effectiveLevel` 由请求深度、用户总开关、场景选择、
Manifest 上限和系统权限共同决定。插件只提交事实和内容，不决定通知铃铛 UI，也不直接调用 Tauri
notification API。

#### 4.3.5 本地配置、通知历史与云端边界

新接口使用应用数据目录下独立、版本化的 `notification-settings.json` 作为唯一插件通知配置事实源，
至少保存：

- `schemaVersion`；
- 每个 `appId` 的声明摘要、插件通知总决定（`pending/granted/denied`）与总开关；
- Manifest 通知场景快照，包括 `key/label/description/trigger/format/defaultLevel/maxLevel`；
- 用户为每个场景选择的 `effectiveLevel`，以及最后确认时间。

旧 `permission-grants.json` 保持原 schema，不在原文件追加新结构。当前 Host 只在声明和网络范围
精确匹配时把旧决定迁入 `permission-consents-v2.json`，迁移成功后立即退休该 App 的 v1 条目及备份，
防止降级 Host 复活已撤销授权。通知新结构必须进入自己的版本化配置文件，不能让两个文件互相回写
同一个新总开关。

通知内容进入独立的本地历史存储，至少记录
`id/appId/appName/sceneKey/requestedLevel/effectiveLevel/title/body/createdAt/readAt`。应用本身负责容量、
保留期、未读状态和敏感内容规则；插件不能读取其他插件的授权或历史，也不能直接往前端内存列表
塞数据。应用本身右上角通知铃铛只读取这份历史并展示来源、时间和已读状态，应用重启后仍可查看。

当前阶段只做本地配置与本地历史。未来接入云通知时，云端只能作为同步/投递层，不能改变本机授权
主体、伪造操作系统权限、绕过场景 key 门禁或把云端到达当作用户同意系统透传。

#### 4.3.6 旧接口兼容与实施顺序

- 当前 `os.notification.post@1` 与 `ctx.notifications.post({ title, body })` 保持 4.2 的原有语义，
  不接受 `sceneKey` 或级别，也不会因为本节出现就自动升级；
- 本地历史上线后，旧接口通过现有门禁且即将投递系统通知时，映射到保留场景 `legacy.post` 并先写
  历史；系统权限失败仍按旧错误返回，不伪装成降级成功；
- 分阶段顺序为：确定 Schema/SDK 与迁移合同 → 实现场景配置、统一 Broker、本地历史和通知铃铛 →
  实现启动汇总授权与设置页场景控制 → 用真实插件做跨平台、系统权限和降级验收 → 再评估云端同步。

### 4.4 通过 Host Broker 请求网络

插件 WebView 的 CSP 不开放外网；`XMLHttpRequest`、WebSocket、`sendBeacon`、动态远端脚本以及
自行启动 `curl`/Shell 都不是插件网络通道。外部 HTTP(S) 请求必须使用 SDK 的
`ctx.http.fetch()`，或使用 SDK 接管后的全局 `fetch()`。基于标准 `fetch` 的请求库通常可以直接
工作；只能使用 XHR、Node socket 或自带原生网络栈的类库当前不支持。

开发者模式下，从本地安装的插件默认进入宽松网络档位：可以暂时不声明 endpoint，也不要求用户先
授权，但请求仍由 Host Broker 代发，并执行协议、并发、速率、大小、超时、取消和审计限制。可在
“设置 → 开发者”打开“严格网络预览”，提前按发布档位验收。

发布/严格预览必须同时声明 `http.fetch@1` 和完整 endpoint：

```json
{
  "permissions": [
    {
      "id": "http.fetch@1",
      "purpose": "同步用户主动创建的任务",
      "required": false
    }
  ],
  "network": {
    "policyVersion": 1,
    "endpoints": [
      {
        "id": "task-api",
        "componentId": "main-ui",
        "origins": ["https://api.example.com"],
        "pathPrefixes": ["/v1/tasks"],
        "methods": ["GET", "POST"],
        "owner": "Example Inc.",
        "purpose": ["sync"],
        "dataCategories": ["user_prompt"],
        "retention": { "mode": "none" },
        "required": false,
        "providerMode": "vendor_only",
        "auth": { "mode": "none" }
      }
    ]
  }
}
```

严格模式只接受精确 HTTPS origin、已声明路径前缀和方法；origin 必须使用规范序列化写法（域名小写、
无尾斜杠、默认端口省略，例如 `https://api.example.com`）；每次重定向都重新校验，并拒绝
localhost、私网、链路本地、保留地址和 DNS 解析到这些地址的目标。URL 查询串不会写入开发者
日志。直连请求会固定已检查的 DNS 结果；若用户配置了系统 HTTPS 代理，则固定本次匹配的代理
快照，并仅为代理的 198.18/15 Fake-IP DNS 模式放行远端解析，其他私网结果仍拒绝。当前鉴权只
支持无鉴权和由 Host 为当前插件维护的内存 Cookie Jar
（`auth.mode=managed_cookie`）；插件拿不到 Host 或其他插件的 Cookie。用户自定义 origin、Host
密钥注入和持久化 Cookie 尚未开放。

```ts
const response = await ctx.http.fetch("https://api.example.com/v1/tasks", {
  endpointId: "task-api",
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ title: "完成合同测试" }),
  signal: abortController.signal,
});

// 全局 fetch 同样经 Host Broker；endpoint 可省略，由 Host 按 URL、路径和方法匹配。
const list = await fetch("https://api.example.com/v1/tasks");
```

当前每个插件最多 32 个 endpoint，每个 endpoint 最多 16 个 origin 和 32 个路径前缀；运行时最多
4 个在途请求、每分钟 120 次。URL/header/正文等请求总量以及 header/正文响应总量各最多 1 MiB，
最长 30 秒，最多跟随 5 次受控重定向。Manifest 网络范围的摘要独立写入授权账本；扩大 origin、
路径、方法、数据类别或用途后会回到待授权状态，不能沿用旧决定。拒绝网络权限、停用或卸载插件
会取消其在途请求并清除内存 Cookie。

### 4.5 插件服务与 Agent / DSH 扩展（已实现子集与目标规范）

> App Service 基础合同已实现；Voice request-text 有实现候选，详见其合同页。Agent Scene / Tool 等其余目标字段不能直接使用。完整目标合同见
> [插件服务与 Agent / DSH 扩展规范](agent-service-extension-v1.md)。

下一阶段把一个 `.reaiapp` 的贡献分成三类，但仍保持一次安装和一次卸载：

| 贡献 | 用途 |
|---|---|
| UI Surface | 用户看到和操作的界面 |
| App Service | 其他插件或 Host 确定性调用的类型化能力 |
| Agent Contribution | 插件定义的 Agent Scene，以及按需把 Service 暴露成 Agent Tool |

调用方已经知道要做什么时，直接调用 Service；只有模型需要判断是否调用时，才挂 Agent Tool。
Agent Scene 由插件声明输入输出、提示词、依赖阶段、会话策略和结果交付，Host 再把它解析为本次
Pi/DSH 配置。DSH Profile 是执行载体，不是插件产品场景的定义源。

Voice 是标准例子：

1. `speech.transcribe@1`（规划）接收 Host `audioRef` 并返回文本；实际识别可以继续由 Host Rust 提供；
2. `com.reai.voice/request-text@1`（[实现候选及版本边界](voice-request-text.md)）让调用方不提供音频，只请求 Voice/Host 完成录音和识别，
   最后拿到文本；
3. 调用方自己把文本插入输入框并决定是否发送，Voice 不访问其他插件 DOM；
4. 翻译是“拿到文本 → one-shot 模型 → 返回译文”，不挂无关工具；
5. Agent 是“拿到文本 → 进入插件定义的持续 Scene”，只挂该 Scene 需要且已授权的工具。

依赖必须分别声明“必需/可选”和“预装/按需获取”。可选依赖缺失时如实降级；必需依赖缺失且无
fallback 时，Host 让用户选择放弃或重新安装/授权。安装完成后只显示“继续刚才的任务”，用户再次
确认才在原会话下一回合启用新能力；不能自动续跑。

这里约束的是 Agent Scene 安装新的插件能力。Host 的浏览器联网工具是另一条已有授权的在途调用：
用户自行安装并启用浏览器插件后，Host 可以恢复同一次挂起的联网请求；不会替 Agent 开新回合，也
不会由模型自行安装插件。

Agent 只能搜索审核 Catalog 并提出安装、停用或卸载建议；真正动作始终由 Host 展示影响范围并等待
用户点击或语音确认，模型不能直接改变已安装 App。

目标合同从第一版起对平台自带 App 和第三方 App 使用同一字段、limit、权限与审核规则。当前生产
Catalog 的 `official-only` 和编译期 seed grant 是现状门禁，不是未来 Agent Scene 的私有官方合同。
Service/headless App 也不必占侧边栏，统一在“更多/已安装 App”管理。

### 4.6 声明 Agent 功能默认值（`contributes.agentFeatures`，Host API 1.23）

用 `agent.session@2` 创建会话的插件可以在 Manifest 里声明自己的「Agent 功能」：每项功能带默认
提示词模板、参数槽与可调工具基集。Host 的插件 Agent 配置页（后续版本提供界面）以这份声明为
单一事实源展示默认值；插件自己创建会话时也用同一份模板渲染，不维护第二份默认值。

```json
{
  "requires": { "hostCapabilities": ["agent.session@2"] },
  "contributes": {
    "agentFeatures": [
      {
        "id": "translation",
        "name": "翻译",
        "description": "把识别文本翻译成目标语言",
        "promptTemplate": "你是翻译引擎。目标语言：{targetLanguage}。只输出译文。",
        "promptParams": [{ "name": "targetLanguage", "description": "本次翻译的目标语言" }],
        "toolBase": []
      }
    ]
  }
}
```

合同要点：

- 声明 `agentFeatures` 必须同时声明 `agent.session@2`（含同名用户权限）——配置只对 v2 会话生效；
  且 `hostApi.range` 下界必须 ≥ `1.23.0`：旧 Host 的 `deny_unknown_fields` 会因未知字段整包拒装，
  声明了却装不上等于给用户一个假入口；
- 新 Host/CLI 合同按完整三段稳定版本的精确值（含裸版本）、`^`、`~`、`>`、`>=`
  计算下界；多个条件取最高下界，`<` / `<=` 不提供下界。缺位、通配、预发布和 OR
  语法仍不接受。本仓 CLI 已同步此项校验；整个范围仍须覆盖目标 Host，
  并满足 Agent 功能的 `1.23.0` 最低版本。
- `id` 匹配 `^[a-z][a-z0-9-]*$`、≤64 字节（与 `featureRef` 的引用域一致）且在插件内唯一、
  发布后不复用；`name`（≤48 字符）是给用户看的中文说明；
- `promptTemplate` 是**参数化模板**（方案 B）：`{slot}` 槽位必须逐个在 `promptParams` 登记
  （参数名匹配 `^[A-Za-z][A-Za-z0-9_]*$`，否则槽位永远无法引用它），未登记或语法不完整的槽位在
  校验阶段被拒；长度按 UTF-8 字节计（≤16384 字节，中日韩文本比等长英文更早触限）。用户以后在配置页覆盖的是**模板文本**，动态参数（目标语言、
  档位指令等）仍由插件在创建会话时注入——覆盖不会丢掉动态行为。当前插件 Manifest 声明模板
  不支持字面大括号；用户覆盖模板采用 [Agent Service v2 的片段规则](agent-service-v2.md)，
  保留闭合的非槽位文本，不递归插值。两类模板的校验边界分别核对；
- `runtime` 出现即表示该功能锁定引擎（如总结固定 DSH），配置页如实呈现为只读；缺省 = 跟随
  全局默认，可被插件级配置覆盖；
- `toolBase` 是用户可勾选的**基集上限**：用户只能在插件声明的集合内调整工具，勾选也不等于
  授权——能力审批、用户同意与工作区/模式闸照旧生效；
- 每插件最多 16 项功能、每个功能最多 16 个参数槽与 32 个工具引用，具体限额以
  `host-support-matrix.json`（仓库路径 `packages/contract/host-support-matrix.json`） 的 `contributes.agentFeatures` 为准。

创建会话时用 `featureRef` 指认其中一项，Host 以此把声明默认值与用户覆盖合并：

```ts
const created = await ctx.agent.createSession({
  schemaVersion: 2,
  featureRef: "translation",
  systemPrompt: renderTemplate("translation", { targetLanguage }), // 与模板同源渲染
  /* … */
});
```

`featureRef` 必须指认调用方自己声明的功能，否则以 `AGENT_FEATURE_NOT_DECLARED` 拒绝。
**兼容性**：旧 Host 的 v2 配置信封不认识该字段会整包拒绝——插件应按
`backends().capabilities.configuration.featureRef`（1.23 起为 `true`，缺席即旧 Host）探测后
再附带。官方 Voice 的源码候选已把 `hostApi.range` 抬到 `1.23.0`（声明了 agentFeatures 就装
不进旧 Host），同时保留运行时探测降级作为双保险。

「设置 › 插件 Agent 配置」的系统任务 target `agent-config` 已进入 `system.tasks@1` 白名单
（SDK 与 Host 枚举同步）并**已接线**：来源 appId 只取可信 Bridge mount（无可信来源或来源
插件停用即失败，不降级打开泛化设置页）；前端先读取 Host 的当前可配置清单，页面重新读取清单并
完成来源锁定后才确认导航成功。旧的已启用快照或页面缓存不代替现有审批与签名复验；清单排除来源、
读取失败或锁定超时按 `SYSTEM_TASK_NAVIGATION_BLOCKED` 失败。页面进入锁定模式（锁定标签、不可切换插件），
返回上下文走既有 `system-task.return`。带 `featureRef` 的会话还可附加用户配置的**只读
技能目录**产出：用户为插件选择一个本地 Markdown 目录（Host 设置页自己的选择器），
功能级勾选的文档在创建时展开为 inline `SkillDocument`（符号链接拒绝、预算 fail-closed、
展开随创建时快照冻结——续跑不重读目录；总量过 8 份/32K/64KiB 信封闸）。

**覆盖层生效（已落地）**：用户在配置页保存的覆盖（插件级默认引擎、功能模板文本、工具
勾选）存账号目录 `agent-plugin-config-v1.json`，只在 v2 会话创建时合并——生效优先级为
会话显式 runtime > 插件级配置 > 全局默认；带 `featureParams` 时 Host 核验你的
`systemPrompt` 与声明模板渲染结果逐字节一致（`AGENT_FEATURE_PROMPT_DRIFT`），用户覆盖
模板时用同一份参数渲染。合并结果即会话快照：之后改覆盖不影响已建会话。覆盖文件损坏时
fail-closed（`AGENT_PLUGIN_CONFIG_CORRUPT`），不会静默回默认。

## 能力复用与调用边界 {#capability-reuse}

插件通过已有事件与类型化服务组合能力。开发前必须核对 Host、SDK、已安装 Provider 的实际实现和版本，列明复用点与真实缺口；界面调整不能被解释为重写录音、识别、Agent 或全局任务系统。

| 职责 | 负责方 | 约束 |
|---|---|---|
| 键盘、快捷键等触发来源映射 | Host | 插件按调用语义执行，不以触发来源决定业务分支；来源绑定不作为业务必填参数 |
| 录音、停止、超时、转写、取消 | Voice 与 Host 已有能力 | 消费插件调用声明的服务，不自建另一套采集识别流程，不越权调用底层能力 |
| 最终文本的消费 | 调用插件 | 决定填入自己的输入框或发送；Voice 不访问调用方 DOM，也不自动代发 |
| 原光标位置写回 | 语音输入法的既有交付链 | 与服务返回文本分开；一次交付只由一处负责，复用目标捕获与校验，避免重复插入 |
| 翻译、Agent 执行 | 已有 Agent 能力 | 翻译使用目标语言与 one-shot 会话；任务复用持续会话和已授权工具，不另建执行系统 |
| 桌面胶囊、答案浮窗、后台通知 | Host | 插件使用公开呈现合同，不在自身 Surface 外创建全局浮层；普通服务调用不必生成任务胶囊 |

“开始／结束”是用户可理解的动作语义，不要求创建同名 API。现有 toggle 命令可以继续复用。控制调用的受理回执、运行阶段与最终业务结果必须区分：收到 `accepted` 或 `recognizing` 不代表已经拿到文本或 Agent 答案。异步结果应回到原请求，以已有合同关联请求、取消、超时和终态，不能把通知当作结果返回。

### Voice 示例与适用范围

调用方已知需要语音文本时，声明服务依赖并调用 [Voice request-text](voice-request-text.md)：原请求等待最终文本；`finish` / `cancel` 返回受理情况；结果由调用方使用。这里的结束控制不是第二份最终结果。不要通过触发来源、跨插件 DOM 或自行录音绕过服务合同。

语音输入法写回原光标、翻译后写回、Agent 任务展示答案是不同交付场景，不能机械套用同一结果窗口。现有 Voice Command 的 3 秒前台/后台呈现策略是特定实现策略，不是所有插件服务的超时时间，也不表示任务超时失败。设计差异应在已有链路上局部完善。

本节规定开发原则，不宣告所有目标能力均已发布。App Service 基础合同已实现；Voice request-text 有实现候选，安装产物、Host 版本和验收状态以其合同页及发布证据为准。Agent Scene、自动工具贡献等目标扩展仍须按实际支持范围使用。缺依赖或版本不满足时明确反馈，不能静默自建替代能力或绕过授权。

## 5. 工具链四连

以下源码开发命令从仓库根目录执行，`<appDir>` 可以是仓库外的绝对路径；安装正式平台包后也可直接使用 `reai-app`：

```bash
bun packages/cli/src/cli.ts validate      <appDir>
bun packages/cli/src/cli.ts build         <appDir>
bun packages/cli/src/cli.ts contract-test <appDir> --host-api 1.1
bun packages/cli/src/cli.ts pack          <appDir> --out <appDir>/my-app-1.0.0.reaiapp
```

- `validate`：Schema、引用、能力和权限是否被当前 Host 接受；
- `build`：生成 `dist/` 与 `build-manifest.json`；
- `contract-test`：把真实入口接到 Mock Host，核对声明与注册；
- `pack`：重新全量构建并输出可复现的 `.reaiapp`。

`@reai/app-test` 的 Mock Host 可以模拟 `account.status` 和确定性的网络响应，并通过
`notificationRequests` 记录通知请求而不发送真实系统通知；它会执行与生产 Host 相同的字段、
类型、长度和控制字符校验。
用户授权、拒绝和持久化是 Host 责任，必须在真实 Driver V2 中做最后验证。

**工具链版本边界（2026-10-06）**：本仓 test-kit 已同步 `networkHandler`、
`networkUploadNow` 和分块上传模拟。SDK 的版本号仍为 `1.24.0`，
使用这些增量时应核对源码交付记录，不能仅凭同版本号推断安装包内容。

SDK 1.24 的 `brokerFetch` 正文超过512KiB时，新 Mock Host 支持 `http.upload.start/chunk/finish/cancel`。
它检查 Manifest 的 `http.fetch@1` 和 endpoint，按公开支持矩阵限制正文52MiB、分块256KiB、每实例
一个上传，并检查精确 offset 和总长度。`networkResponse` 仍可提供固定响应；显式 `networkHandler`
可接收 `{ request, body, signal }`，其中 `body` 是完整 Blob，供合成 fixture 验证 multipart 或 SHA。
回调必须返回确定性响应，不得请求真实网络。
`signal` 的取消模拟只适用于分块上传；inline 回调不建立在途条目，也不模拟请求取消。
test-kit 发布的是 TypeScript 源码。单独运行消费者类型检查时，应使用 ESNext / NodeNext / Preserve
模块模式、`resolveJsonModule: true`，并提供 Bun 或 Node 类型；合同测试仍使用 Bun。

暂存使用一个有界 buffer；finish 构造 Blob 时瞬时内存约为两倍正文，随后释放 buffer 引用。
上传的 `networkRequests` 只记录一次元数据、bodyBytes 和 uploadId，不保留分块、Blob 或大正文 base64。
回调自行保留的 Blob 由 fixture 管理。取消只匹配 requestId；未命中、已完成或重复取消返回
`cancelled: false`。失败、取消和 disable 清理本实例条目；迟到回调不能删除后来新建的上传。

`networkUploadNow` 可注入合成时钟；start/chunk/finish 惰性检查180秒 idle 和15分钟 absolute 期限。
这不是原生后台计时、真实 HTTP 超时、用户同意、全账号四个名额或跨 runtime 生命周期的模拟。
其他 Mock 功能仍按各自合同验证；这项上传测试不能代替签名 App 和真实 OAuth 验收。

## 6. 安装与权限验收

本节当前只适用于 macOS。Windows 会拒绝本地第三方包，直到每插件 origin 隔离完成。开发者包不能
使用平台保留的官方 `appId`；安装来源由 Host 记录，Manifest 无权自报。旧注册表中没有来源字段的
条目按 `legacyUnverified` 处理，不继承官方 seed grant，需要从可信内置包重新安装后才可恢复。

1. 在 Driver V2 的“设置 → 开发者”开启“开发者模式”。
2. 进入 App Store，点击标题右侧“已安装”。
3. 点击“从本地安装”，选择刚打出的 `.reaiapp`，确认未经审核代码提示。
4. 找到插件，展开“权限”，确认每项都显示 Manifest 中的 `purpose` 和 `pending` 状态。
5. 对 `account.status@1` 点“拒绝”，再触发账户状态功能，预期收到 `PLUGIN_PERMISSION_DENIED`。
6. 点“允许”，再次触发，预期得到 `{ enabled, loggedIn }`。
7. 对 `os.notification.post@1` 点“允许”；如果系统通知尚未开启，调用应返回
   `SYSTEM_NOTIFICATION_PERMISSION_REQUIRED`，且此时不应自行弹出 macOS 授权框。
8. 由用户点击首次引导中的“开启通知”或设置页系统通知项的“允许通知”，完成 macOS 系统授权后
   再次调用；预期返回
   `{ queued: true }`，通知标题带真实插件名和 appId 指纹。拒绝系统授权时预期得到
   `SYSTEM_NOTIFICATION_PERMISSION_DENIED`，并引导用户前往系统设置。
9. 本地开发时按 `Cmd/Ctrl+J` 打开底部开发者面板；“输出”页确认插件 `console` 与脱敏后的网络审计，
   “终端”页运行调试命令。终端属于开发者本人的 Host 工具，不会把 shell 能力暴露给插件。
10. 打开“严格网络预览”，允许 `http.fetch@1` 后验证已声明请求成功；未声明 origin、路径、方法、
    私网地址和越界重定向应被拒绝。修改 endpoint 范围后确认 UI 提示范围变化并要求重新授权。
11. 用 Host 侧自动化测试或仍在途的调用验证停用门禁，预期 Host 拒绝；普通手工界面停用后会先关闭，
   不能把“界面已关、无法再点”误当作运行时门禁已经验证。重新启用后授权决定仍保留。
12. 卸载再安装同一 `appId`，插件权限回到 `pending`；系统通知授权属于 Host App，不随单个插件
    卸载而重置。KV 是否保留取决于卸载时选择。
13. 若声明了 `titlebarActions`：打开插件，按 `showOnTitlebarHover` 分两种验收——`true` 时
    先确认普通态隐藏、Tab 聚焦可见，鼠标进入整条标题栏后动作出现在通知铃铛左侧；`false`
    （§3.2 示例的常驻写法）时动作应直接可见。两种情况下点击后插件都要收到信封；
    切 Home 或停用插件后动作立即消失。

如果修改了权限的 `id`、`purpose` 或 `required`，声明摘要会变化，旧决定不再适用，用户需要重新
授权。这防止插件用同一个权限 ID 悄悄扩大用途。

## 7. 更新和发布边界

当前 Host 没有插件在线更新通道。同一个 `appId` 已安装时会返回
`APP_ID_ALREADY_INSTALLED`，开发阶段需要先卸载再装新包。涉及数据结构升级时，不要把卸载重装
当成正式迁移方案；版本兼容、迁移工作流、审核测试账号和自动升级验证仍属于后续发布系统。

公开给其他用户之前必须经过官方审核。正式包会始终执行 Manifest 网络白名单；开发者模式安装成功
只证明本机包通过当前合同，不证明提交源码与产物一致，也不证明云端额度归属、工作流复制、终端
allowlist 或新旧数据迁移正确。源码上传、自动扫描、人工审核、签名和上架仍属于外部发行服务，
不在本次客户端实现内。这些产品与后端合同记录在
[Driver V2 × 外脑云能力与工作流分发基线](wainao-cloud-workflow-distribution-v1.md)。

## 8. 常见错误

| 错误 | 含义与处理 |
|---|---|
| `BRIDGE_MESSAGE_TOO_LARGE` | `plugin_bridge_invoke` 的 `params` JSON 序列化后超过矩阵 `bridgeMessageBytes`（当前 1 MiB）；缩小请求再提交 |
| `BRIDGE_TOO_MANY_INFLIGHT` | 同一个插件运行会话已有矩阵 `inflightRequestsPerRuntime` 个请求尚未结束（当前 32）；等待已有请求完成，不要立即并发重试 |
| `APP_PERMISSION_UNSUPPORTED` | Manifest 申请了当前矩阵未开放的权限 |
| `PLUGIN_PERMISSION_REQUIRED` | 权限尚未决定；引导用户到“已安装 → 权限” |
| `PLUGIN_PERMISSION_DENIED` | 用户明确拒绝；不要静默重试 |
| `PLUGIN_PERMISSION_NOT_DECLARED` | 代码调用了未写进 Manifest 的权限接口 |
| `PLUGIN_APP_DISABLED` | 插件已停用 |
| `SYSTEM_NOTIFICATION_PERMISSION_REQUIRED` | 系统通知尚未决定；只能提示用户在 ReAI Board 主动开启 |
| `SYSTEM_NOTIFICATION_PERMISSION_DENIED` | 系统通知已被拒绝；提示用户前往系统设置开启 |
| `SYSTEM_NOTIFICATION_STATE_UNAVAILABLE` | 暂时无法读取系统通知状态；稍后再试，不要自行申请 |
| `NOTIFICATION_RATE_LIMITED` | 超过每插件每 10 秒 5 次请求；合并通知并停止立即重试 |
| `NOTIFICATION_PAYLOAD_INVALID` | title/body 为空、超限、含额外字段或禁止控制字符 |
| `NOTIFICATION_ENQUEUE_FAILED` | Host 未能加入本地发送队列；允许用户稍后重试 |
| `NETWORK_PERMISSION_REQUIRED` | 严格模式未声明/未授权 `http.fetch@1`，或网络范围变化后待重新授权 |
| `NETWORK_ENDPOINT_NOT_DECLARED` | URL 没有匹配 Manifest endpoint，或显式 endpoint ID 不匹配 |
| `NETWORK_SCHEME_DENIED` / `NETWORK_PRIVATE_ADDRESS_DENIED` | 非 HTTP(S)，或严格模式命中本机、私网、保留地址 |
| `NETWORK_METHOD_DENIED` / `NETWORK_PATH_DENIED` / `NETWORK_HEADER_DENIED` | 方法、路径或 header 超出严格策略 |
| `NETWORK_REDIRECT_DENIED` | 重定向越界、无效或超过 5 次 |
| `NETWORK_RATE_LIMITED` | 超过每插件并发或每分钟速率限制 |
| `NETWORK_REQUEST_TOO_LARGE` / `NETWORK_RESPONSE_TOO_LARGE` | 请求或响应超过 1 MiB |
| `NETWORK_TIMEOUT` / `NETWORK_CANCELLED` / `NETWORK_UPSTREAM_FAILED` | 超时、AbortSignal 取消或上游/DNS 失败 |
| `APP_ID_ALREADY_INSTALLED` | 首版无更新通道；先卸载旧包再安装 |
| `MANIFEST_SCHEMA_INVALID` | 字段、类型或未知属性不符合 Schema |
| `HOST_CAPABILITY_NOT_AVAILABLE` | 申请了当前 Host 未开放的能力 |
| `APP_CAPABILITY_NOT_GRANTED` | 使用了仅对指定 `appId` 授予的特权能力 |
| `PACKAGE_RESOURCE_NOT_IN_MANIFEST` | 包内文件与 Build Manifest 不一致；重新 `pack` |

更多接口和错误语义见 [插件接口参考](plugin-api-reference-v1.md)。运行时日志使用：

```bash
make driver-v2-logs
```

## 界面语言环境（Host API 1.16.0）

语言资源、公共术语、完整覆盖与发布验收统一遵守[插件语言包规范 v1](plugin-i18n-v1.md)。Host/SDK 的仓库实现不等于分发版本已发布。

Host 统一选择 `zh` / `en`，与 ASR 识别语言及翻译目标无关。插件复用成熟 i18n 引擎并自行维护资源；SDK 不分发业务词典，也不授予插件修改全局语言的能力，无需新增 capability 或 permission。

```ts
const locale = ctx.locale?.getSnapshot().locale ?? "zh";
const stop = ctx.locale?.onChange(({ locale }) => updateExistingView(locale));
// Surface cleanup 中调用 stop?.()，不要为切语言重建 Surface 或清空业务状态。
```

`onChange` 立即回放只读 `{locale, revision}` 快照；单个订阅者失败不影响其它消费者，退订后不再调用。revision 仅在本次 Host 进程与当前运行会话内排序，插件不能跨运行缓存它。旧 Host SDK 没有 ctx.locale，插件可检测后保留历史中文默认；若不做可选访问保护，Manifest 的 `hostApi.range` 必须至少声明 `>=1.16.0 <2.0.0`（类型定义描述 1.16 本身提供的完整合同）；旧插件不访问该 API 时继续正常运行。

Host 通过 activate 可选 locale 快照、带 runtimeSessionId 的 locale.changed 和只读 locale.get 传播状态。新 SDK 只有在 activate 已声明 locale 时做一次有界补读，旧初始化信封不会触发未知请求。一个 runApp 对应一个不可变 runtimeSessionId，重新激活须新建运行实例；重复或其它会话的 activate 不替换原会话。已开、后台及后开 Surface 均接收当前语言，不依赖业务 Manifest event 订阅。

资源使用 zh/en 同键、同插值变量；所选资源缺键回退 en，再返回 key 并在开发中告警。正式覆盖不得留下裸 key，英文长文本不得遮挡操作。静态 manifest/Tab/Action 元数据覆盖仍属 F10 后续里程碑，示例正文切换不代表首发覆盖完整。
