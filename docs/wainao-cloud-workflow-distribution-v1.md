# Driver V2 × 外脑：云能力、工作流分发与 Team 计费基线

> 状态：**产品基线已确认；后端部分等待跨项目联合设计，不是对后端的直接修改指令**
> 记录日期：2026-08-09
> 适用范围：Driver V2 Host、插件开发者平台、外脑 OAuth、云模型能力、工作流安装与计费
> 事实边界：本文严格区分“外脑 `main` 已实现”“本地可见未合并分支”“已确认产品目标”和“待决策”。

## 1. 一页结论

Driver V2 不是把**外壳的**外脑 Token 交给插件，而是一个本地能力与云端能力的统一 Broker
（2026-08-14 澄清：插件自己作为独立的外脑 OAuth App **有自己的令牌**，由外壳保管、经外壳通道使用、
插件取不回，见
`docs/archive/plans/2026-08-14-plugin-oauth-parent-child-architecture.md`（原 Board 仓库内 `docs/archive/plans/2026-08-14-plugin-oauth-parent-child-architecture.md`；未迁入））：

```text
插件
  → Driver V2 权限门禁
  → 当前登录账号与目标 Team 授权
  → 外脑模型 API / 已安装工作流实例
  → 使用目标 Team 的余额并留下插件、版本、资源和设备审计记录
```

工作流分发采用以下产品模型：

```text
作者工作流
  → 发布为不可变 Template Snapshot X@1.0
  → 插件版本 P@1.0 绑定 X@1.0
  → 用户在目标 Team 安装 P@1.0
  → 形成归属于目标 Team 的 Installed Workflow Instance Y@1.0
  → Y 锁定 X@1.0，运行消耗目标 Team 的额度

作者发布 X@2.0 / P@2.0
  → 用户确认升级
  → 形成或切换到 Y@2.0
  → 仍可追溯 X@1.0 → Y@1.0、X@2.0 → Y@2.0
```

这里的“复制”首先是一项**产品语义**：安装方获得独立归属、独立配置、独立计费和独立生命周期。
已确认不要求重复存储相同的 Snapshot 字节：Y 是安装方 Team 独立拥有的 Instance，锁定引用平台保管的
不可变源 Snapshot。作者修改或删除工作区内容、插件下架，都不能篡改已经发布并被实例锁定的历史 Snapshot。

## 2. 外脑的真实归属模型

外脑不是“所有东西直接绑定个人”，也不是“只绑定项目”。当前结构更准确地分为三层：

1. **User** 是操作人和身份主体。
2. **Team** 是资源治理、余额和付款的核心边界。
3. **Project** 是 Team 下面承载工作流、密钥、数据和安装项的工作空间。

### 2.1 实体关系

| 实体 | 当前主要归属 | 当前作用 | 对 Driver V2 的含义 |
|---|---|---|---|
| User / Profile | User | 登录身份、操作人、创建者 | 决定谁在授权、安装和调用 |
| Team | Owner + Members | 组织与付款主体 | 插件云能力最终必须选择一个目标 Team |
| Project | `team_id` + `owner_user_id` | 工作流、密钥、数据和安装项的容器 | Team 是治理边界，Project 是具体落点 |
| Document / Workflow | `project_id` + `owner_user_id` | 可编辑的工作流源文件 | 作者在自己的 Project 中开发和调试 |
| Deployment | Source Project / Team / User | 发布时生成的工作流快照和 API Schema | 可作为插件绑定的不可变执行版本 |
| Release | Project 中的 Release 文档与版本 | 把多个 Deployment 组织为稳定 API 路由 | 适合对外 API，但不等同于插件安装实例 |
| Tool Template Version | Template + Deployment | 把一个发布快照包装成可安装版本 | 与插件绑定工作流最接近的现有模型 |
| Tool Package Version | Package + 多个 Deployment | 把多个文件/工作流快照组成版本 | 可复用其依赖、版本和安装事务思路 |
| Project Tool/Package Install | Project + locked version | 记录目标 Project 安装了哪个确定版本 | 与 `Installed Workflow Instance` 最接近 |
| API Key | User + Team | 代表某个 Team 的调用与额度边界 | 插件不能直接取得 Key；由 Broker 使用 |
| Credit Balance / Transaction | Team | 余额与消费流水 | “谁使用谁付费”最终表现为目标 Team 扣费 |
| OAuth App | Owner User，可选 Team | 外部 App 的 client、scope 与 token 归因 | 一个插件沿用同一 `appId`，通过状态控制分发 |

外脑当前表结构证据主要位于：

- `wainao_editor/supabase/schema/parts/04-tables.sql`：`api_keys`、`credit_balances`、`credit_transactions`、`deployments`、`documents`、`projects`、`project_tool_installs`、`project_package_installs`、`tool_templates`、`tool_template_versions`、`tool_packages`、`tool_package_versions`。
- `wainao_editor/supabase/schema/parts/05-constraints.sql`：上述对象到 Team、Project、Deployment 的外键和唯一约束。

### 2.2 默认个人 Team 与个人 Project

外脑当前已经具备以下基础：

- 注册触发器会尽力创建首个 Team，但失败不会阻断注册，因此不能只依赖“注册后一定已有 Team”。
- `POST /my/default-project/ensure` 会幂等地确保并返回“用户本人拥有的有效 Team + 唯一有效的
  `personal_default` Project”；已有合规结果时返回同一组对象。
- 个人默认 Project 必须挂在用户本人拥有的有效 Team 下；发现错误归属时 fail fast，不静默迁移。
- 个人用户充值、模型调用和硬件数据可以落在该默认 Team / Project。

因此产品上不应描述为“用户没有 Team”，而应描述为“用户没有加入额外的协作 Team，当前使用个人空间”。
Driver V2 第一版的运行空间已经确认：

1. 无论用户是否加入其他协作 Team，安装过程都不展示 Team 或 Project 选择。
2. Driver/后端自动确保并使用个人默认 Team 与 `personal_default` Project。
3. 插件运行 Instance、个人硬件和个人数据默认汇聚到这个 Project。
4. 合同和审计中仍保存真实 `teamId` / `projectId`，不能用“个人账号”字符串代替归属关系。
5. 团队安装、团队付费与协作 Project 属于未来 Team 版本，不进入插件平台第一版。

接口接受用户 JWT 或具备路由权限的 OAuth Access Token，返回 Team、Project 以及
`storage_write: true`、`deletion_locked: true`。它拒绝插件直接提交用户身份，也不允许客户端直接调用底层
service-role RPC。

Driver V2 的联网能力使用独立的 `web:search` / `web:fetch` 窄权限；两个 Scope 都只额外开放
`POST /my/default-project/ensure`，用于取得服务端明确返回的个人默认 Project ID。它们不继承
`mobile:full` 的上传、ROMP、设备或 Profile 权限。模型网关内部 ensure 仍不替代这条显式合同，
Driver 或插件也不得直接调用底层 service-role RPC。

证据：

- `wainao_editor/supabase/migrations/20260525120000_auto_create_first_team.sql`
- `wainao_editor/supabase/migrations/20260605130000_personal_default_project.sql`
- `wainao_editor/apps/backend/src/routes/my.ts` 的 `/my/default-project/ensure`

### 2.3 个人系统 Team 标记与 owner-only 合同

已确认：承载个人默认 Project 的 Team 必须增加明确的“个人系统 Team”标记（字段名待后端设计，本文
暂称 `personal_system`）。该标记不是普通的界面标签，而是以下产品不变量的依据：

- 永久只允许 Owner 本人，不允许邀请或加入其他成员。
- 不允许转让所有权，也不能转换成协作 Team。
- 用户需要协作时，必须创建或加入独立的协作 Team / Project。
- 默认 Project ensure 只能创建或返回符合该标记与 owner-only 约束的 Team，不能复用普通协作 Team。
- 个人插件 Instance、硬件和个人数据默认落入该 Team 的 `personal_default` Project。

现有后端有两个与该目标冲突的边界，必须在开放插件前修正：

- `personal_default` 的 `private` 只表示“不公开”，读取边界仍是 Team；承载 Team 的 accepted 成员可以读取
  Project，相关文件策略也包含 Team 成员路径。
- ensure 会复用用户最早拥有的有效 Team，不要求该 Team 只有本人；承载 Team 当前还可以转让所有权。
  转让后会破坏“Team Owner = Project Owner”的不变量，后续 ensure 会报冲突。

因此“插件 Instance、硬件和个人数据都放在个人默认 Project”在容器模型上兼容，但现有数据和权限模型
尚未满足 owner-only 合同。后端需要审计存量 personal_default 的承载 Team，安全补齐标记，并通过数据库、
服务端门禁和越权测试共同保证不可加成员、不可转让；不能只靠前端隐藏入口。

## 3. Deployment、Release 与不可变快照

### 3.1 `main` 已实现的 Deployment 语义

每次发布都会创建新的 Deployment，而不是修改旧版本：

- Deployment 保存 `snapshot`、`api_schema`、来源 `document_id`、`project_id`、`team_id`、版本号和内容哈希。
- 新发布按 API Schema 变化决定版本推进；新版产生新记录。
- 级联发布会把引用的 Flow 一并发布，并把依赖替换为对应 Deployment 引用。
- Tool 节点不进入普通 Flow 级联树；Tool Template 自己锁定独立 Deployment 版本。
- 当前生产代码没有发现对 `deployments.snapshot` 的常规原地更新路径，发布语义上把 `deployment_id` 当作不可变快照引用。

但必须区分：

- **应用服务语义上不可变：已具备。**
- **数据库层禁止任何更新的强不变量：`main` 尚未完整锁死。**

证据：

- `wainao_editor/apps/backend/src/routes/deployments.ts`
- `wainao_editor/apps/backend/src/services/cascade-deployment.ts`
- `wainao_editor/supabase/migrations/20260722140000_document_versioning_g2_revision_mvp.sql`
- `wainao_editor/supabase/migrations/20260622160000_workflow_capability_test_channel.sql`

### 3.2 Release 的作用

Release 是 Project 中的一份可编辑发布配置，负责把一个或多个 Deployment 组织成：

- alias；
- 版本；
- endpoint path；
- 输入输出映射；
- 鉴权、CORS、限流与公开文档。

所以：

- Deployment 回答“执行哪个不可变工作流快照”；
- Release 回答“通过哪个稳定 API 地址、以什么接口合同调用”；
- Installed Workflow Instance 回答“哪个插件版本把哪个快照安装给了哪个 Team/Project，并由谁付费”。

三者不能合并成同一个对象。

### 3.3 可见但未合并的 Release 强不变量分支

本地可见 `origin/auto/release-schema-invariants`（`b3ca238824f5a286457466a441c6f19d0ec076ee`）增加了 Release Version 发布后不可修改、状态机、Alias 锁定等数据库门禁。但它相对当前 `main` 已明显落后，且解决的是 Release 快照治理，不是 Team-owned Installed Instance。

本文不能把该分支写成已交付能力。

### 3.4 发布前递归依赖检查

已确认：工作流发布不能只检查入口工作流或插件 Manifest。发布服务必须递归检查入口工作流实际引用的
子工作流、Tool、模型、连接器、字段、文件与数据源，直到得到完整依赖闭包，并形成可供插件审核、安装配置
和运行门禁共同使用的依赖清单。

发布检查至少回答：

- 使用了哪些云模型、平台能力和需要审核的 capability；
- 使用了哪些 Project Secret、API Key、连接器与用户数据源；
- 哪些依赖属于作者私有资源，禁止随快照分发或由安装者间接使用；
- 哪些依赖可以转换成安装方必须提供的配置项；
- 哪些非敏感常量、提示词和公开地址可以安全进入快照；
- 引用链中是否存在缺失、循环、未发布版本或无法确定归属的节点。

诊断不能只返回笼统的“发布失败”。每个问题至少需要指出入口工作流、引用路径、具体节点/字段、问题类型、
是否阻止发布，以及作者应该如何修正。递归检查结果必须固化到确定的发布版本；后续插件审核和用户安装
读取同一份结果，不能由三个环节分别猜测。

已确认的产品级诊断分档：

1. **Error / 阻止发布**：作者密钥或私有数据进入快照、引用缺失或循环、依赖未发布版本、使用平台未开放
   能力，或者依赖归属无法确认。
2. **Requires configuration / 允许发布**：依赖已正确声明为安装方配置项；快照可以发布，但用户完成配置前
   Installed Instance 不可运行。
3. **Warning / 允许发布**：可选配置、非敏感默认值、预计费用或效果说明，仅作明确提醒。

具体扫描方式、现有发布链路如何接入、错误模型和数据结构由 Driver V2 与外脑后端在开发前共同确认；上述
分档表达产品验收语义，不预先指定后端实现。

## 4. 外脑已经存在的两种“安装”，以及目标模型的差异

### 4.1 开源 Tool Package：复制为可编辑文档

外脑 `main` 已支持：

1. 读取 Package Version 绑定的 Deployment Snapshots；
2. 在目标 Project 创建新的 Document；
3. 重写包内引用；
4. 写入目标 Project 的目录树；
5. 创建 `project_package_installs` 安装记录；
6. 处理依赖与失败回滚。

复制后的文档归目标 Project，但它是普通可编辑 Document。这不满足“分发实例不可修改”的要求。

证据：`wainao_editor/apps/backend/src/services/tool-package-installer.ts` 的 `installOpenSource()`。

### 4.2 Tool Template / 闭源 Package：引用锁定版本运行

外脑 `main` 也支持另一种更接近目标的方式：

- 安装记录属于目标 Project；
- 安装记录锁定一个 `tool_template_version` 或 `tool_package_version`；
- 版本指向作者发布的 Deployment Snapshot；
- 运行时验证当前 Project 的安装关系；
- 执行器使用安装方的 `projectId`、`userId`、项目/Team 密钥和父级 Billing Context；
- 升级通过修改安装记录锁定的新版本完成；
- 不把源工作流作为可编辑 Document 暴露给安装方。

这已经实现了“固定作者版本 + 安装方上下文执行”的大部分语义，但没有创建一个新的、由 B 的 Team 拥有的 Deployment Y。

证据：

- `wainao_editor/supabase/schema/parts/04-tables.sql` 的 `project_tool_installs`、`tool_template_versions`、`project_package_installs`。
- `wainao_editor/apps/backend/src/routes/project-tool-templates.ts` 的安装、升级和卸载路由。
- `wainao_editor/apps/backend/src/services/tool-package-installer.ts` 的闭源安装路径。
- `wainao_editor/apps/backend/src/executor/blocks/tool.ts`：从安装记录加载锁定版本，并继承调用方 Project 与 Billing Context。

### 4.3 Driver V2 的目标：Team-owned Installed Workflow Instance

已确认的目标不是简单复制为可编辑 Document，也不能只留下一个含义模糊的 Deployment 引用。平台需要能表达：

| 字段语义 | 要回答的问题 |
|---|---|
| `pluginAppId` | 实例由哪个插件创建 |
| `pluginVersion` | 安装时对应哪个插件审核版本 |
| `sourceTemplateId` | 原始工作流模板身份是什么 |
| `sourceVersionId` | 锁定了作者的哪个不可变版本 |
| `sourceDeploymentId` | 实际执行的源快照是什么 |
| `targetTeamId` | 谁拥有、授权并付费 |
| `targetProjectId` | 安装到 Team 下面的哪个工作空间 |
| `installedBy` | 哪个用户代表 Team 完成安装 |
| `instanceState` | active / disabled / upgrading / removed 等生命周期 |
| `configurationRef` | 安装方自己的输入、密钥和配置放在哪里 |
| `replacedBy` / `derivedFrom` | Y 1.0、Y 2.0 与 X 1.0、X 2.0 如何追溯 |
| `dataVersion` | 当前 Instance 的数据已经迁移到哪个版本 |
| `migrationPath` | 从安装版本到目标版本必须经过哪些确定迁移步骤 |

Instance 必须满足：

- 安装方不能修改源执行逻辑；
- 作者后续修改源 Document 不影响既有实例；
- 作者不能远程把既有实例静默切到新版本；
- 插件升级和工作流升级必须绑定到一个经过审核的确定版本；
- 使用安装方自己的 Team 配置和额度；
- 作者下架影响新安装还是强制停用，必须由平台政策决定，不能删除历史来源链。

已确认的存储与归属语义：

- Y 是目标 Team 拥有的独立 Instance，不是作者 Deployment 的所有权转移。
- Y 可以锁定引用同一份内容寻址的不可变源 Snapshot，无须为每次安装复制相同字节。
- 平台必须独立保管已发布 Snapshot；作者工作区删除、源 Document 变化或停止分发都不能改写历史内容。
- Y 的配置、权限、付款 Team、启停、升级和卸载状态全部独立于作者及其他安装实例。
- 任何运行必须从 Y 解析确定版本，禁止运行时跟随作者的 latest 或可变工作区 Document。

## 5. 已确认的插件与工作流生命周期

### 5.1 开发阶段

1. 第一版开发者在自己的个人系统 Team / `personal_default` Project 中开发工作流。
2. 开发者运行并验证工作流，包括依赖、模型、输入输出和错误路径。
3. 发布产生不可变 Template Snapshot。
4. 插件版本绑定确定的 Snapshot / Template Version，不绑定可变的工作区 Document。
5. 插件沿用稳定 `appId`，状态为 `development`。
6. `development` 状态只允许插件作者本人授权、安装和调用，固定消耗作者个人系统 Team 的额度。

### 5.2 提审与公开分发

1. 工作流发布前递归扫描完整依赖树，生成能力、资源和安装方配置需求清单。
2. 作者私有密钥、连接器凭据、私有文件和数据源不能进入可分发快照，也不能继续由安装者间接使用。
3. 可由安装方提供的依赖必须转换成明确配置项；缺少配置时 Installed Instance 不可运行。
4. 提交审核时冻结插件版本、Manifest、权限清单、工作流版本引用和递归检查结果。
5. 审核对象是完整组合：插件代码 + 本地权限 + 云能力 + 工作流快照 + 数据与计费说明。
6. 新版本上架前，平台必须用审核测试身份安装旧版、准备旧版数据副本与备份，并实际执行新版升级和数据迁移。
7. 自动或人工验收发现安装、迁移、数据完整性或新版运行问题时，必须阻止上架并把可定位的诊断退回开发者。
8. 审核通过后，同一个 `appId` 的该版本进入 `approved`，其他用户才能安装。
9. 新增敏感权限、替换工作流版本或改变执行逻辑，需要提交新版本重新审核。

升级验证是管理员审核的必经步骤。第一阶段可以包含人工确认，但流程与证据必须结构化记录；后续应逐步
自动化安装、备份、迁移、断言、报告和准入判断，不能依赖审核人员凭经验点击后口头确认。

每个插件 `appId` 还必须拥有一个平台自动创建的专属审核测试账号：

- 测试账号与插件一一绑定，跟随插件终身存在，不与其他插件共用。
- 账号、凭据、个人系统 Team、Project 和数据均由平台控制，开发者不可见、不可登录、不可取得凭据。
- 它保存该插件最近正式版本及代表性测试数据，作为后续升级的标准旧版基线。
- 每次审核从标准基线复制出独立工作副本并先做备份；审核失败丢弃工作副本，不污染标准基线。
- 审核成功后，平台才把通过验证的新版状态更新为下一次审核所用的标准基线。
- 插件下架、暂停或开发者离开后，测试身份与历史证据仍按平台审计政策保留，不能转交给开发者。

“测试账号”是产品上的独立平台身份与隔离边界，不预先限定必须复用普通注册账号的具体技术实现；账号创建、
系统标记、凭据托管、额度和生命周期需要与外脑后端共同确认。

对于邮箱、Webhook、第三方 API 等外部能力，平台应逐步提供“AI 专用测试资源”，例如平台控制的专用测试
邮箱域、测试收件箱、测试回调地址、沙箱账号和测试凭据。审核执行遵循：

- 自动化测试只能访问该插件获准使用的测试能力和平台控制目标，不能触达开发者或用户的生产资源。
- 外部输入、输出和副作用需要被记录，并在测试结束后按资源类型清理或归档。
- 平台具备标准测试资源时优先自动完成，管理员审核自动化证据和异常。
- 暂无标准沙箱但可以受控验证的能力，允许进入更严格的人工审核，而不是直接视为普通插件放行。
- 高风险人工审核可以有更长审核时间、更严格准入条件和更高审核成本，具体政策需单独确认。
- 无法限制目标、无法审计副作用或必须使用生产密钥/真实用户数据的能力，不具备公开上架条件。

审核费用复用外脑现有积分（Token 消耗单位），不建立独立审核币种：

- 每个插件 `appId` 每个自然月拥有 `N` 次免费审核额度；每个开发者账号每个自然月另有总计 `M` 次
  免费审核额度。
- 只有插件级与开发者级额度同时有剩余时，本次审核才免费；任一层额度耗尽后，从插件开发者的个人系统
  Team 积分余额扣除审核费。
- `N`、`M`、普通审核价格、高风险人工审核价格及生效时间由平台设置动态配置，不能硬编码在客户端。
- 提交前必须明确展示剩余免费次数、预计扣除积分、审核风险档位和预计时长，并由开发者确认。
- 免费次数使用、积分预扣/扣除/退还、审核结果和配置版本都必须进入审计流水，避免重复扣费或价格争议。
- 插件删除、下架、转移或重新创建不能重置开发者级额度，也不能让同一插件身份重复领取当月额度。
- 提交前的格式、字段和依赖预检失败，不消耗免费次数，也不扣除积分。
- 审核任务正式进入自动化或人工审核队列时，预占一次免费额度或对应积分。
- 因插件自身问题被驳回，正常结算额度或审核费；审核是否通过不等同于是否收费。
- 因平台、审核环境或管理员操作故障而终止，全额恢复额度或退还积分。
- 审核开始前开发者主动撤回则恢复；审核已经开始后撤回则正常结算。
- 同一提交和重试必须使用稳定幂等身份，不能重复占用次数或重复扣费。
- 具体预占、结算和退款流水需要结合外脑现有积分账单能力共同确认。

### 5.3 用户安装

1. 用户已在 Driver V2 登录外脑账号。
2. 第一版任何时候都不展示 Team/Project 选择；平台自动确保并使用当前用户的个人系统
   Team + `personal_default` Project。
3. 即使用户已经加入其他协作 Team，也不能切换安装目标、付款 Team 或运行 Project。
4. 安装前展示：插件版本、发布者、审核状态、本地权限、云能力、工作流、数据用途和付款 Team。
5. 后端原子创建插件安装记录、工作流 Instance、权限授权和版本锁定关系。
6. 任何一步失败都不得留下可运行的半安装状态。

### 5.4 调用与计费

每次调用至少复核：

```text
当前用户仍登录
+ 插件仍安装且启用
+ appId / pluginVersion 与审核记录匹配
+ 申请的 capability 已获平台开放
+ 当前用户/Team 已授权该插件
+ Installed Workflow Instance 属于目标 Team
+ Instance 锁定的工作流版本可运行
+ 目标 Team 余额足够
```

插件只能取得结果和必要的短期任务状态，不能取得：

- OAuth access/refresh token；
- 隐藏 API Key；
- Team 长期付款凭据；
- 工作流中属于作者或安装方的服务密钥明文。

计费审计至少记录：

```text
userId + targetTeamId + pluginAppId + pluginVersion
+ workflowInstanceId + sourceVersionId + deviceId + runId
```

### 5.5 升级

升级不是单纯替换程序或工作流 Snapshot，而是“程序版本 + 工作流版本 + 数据版本”的联合升级：

1. 作者发布新版本时必须声明与哪些旧版本直接兼容，以及是否改变数据结构或数据语义。
2. 存在数据变化时，作者必须提供确定版本的升级工作流，把旧版数据安全迁移到新版所需形态。
3. 用户跨多个版本升级时，平台必须计算完整迁移路径；只有目标版本明确支持当前来源版本，或所有必要的
   中间迁移步骤都存在并通过检查，才允许升级，不能默认跳级。
4. 升级工作流与插件代码、权限和目标工作流作为同一升级单元接受审核并锁定版本；作者后续不能修改已发布
   的迁移逻辑。
5. 安装方需要看到版本变化、数据迁移、权限变化、工作流变化和可能的计费变化，再确认升级。
6. 升级后的 Instance 必须记录程序版本、工作流版本、数据版本和实际执行的迁移链，保持完整来源审计。
7. 升级失败继续使用旧版，不能留下部分迁移但程序未切换的中间状态。
8. 升级成功后默认不提供随意降级；旧版本只保留历史与审计语义。若未来支持降级，必须为该版本组合单独
   设计并审核逆向数据迁移，不能仅切回旧 Snapshot。
9. 在任何真实用户获得升级前，平台审核环境必须先从旧版实例和旧版数据实际执行同一条升级路径；旧版
   测试数据在每次演练前都要复制和备份，测试失败不能污染下一次审核基线。
10. 至少验证“当前公开旧版 → 候选新版”；如果候选版本声明可以从更早版本直接升级，必须分别验证每一条
    声明支持的来源路径。若只能通过中间版本迁移，则验证完整迁移链。
11. 审核证据至少包括来源/目标版本、数据版本、备份标识、执行的迁移链、迁移结果、新版运行断言和失败诊断。

版本兼容性表达、迁移工作流协议、执行事务边界与存量数据保护方式，需要 Driver V2 和外脑后端共同确认；
本文只确定上述产品不变量。

#### 升级提醒与已安装列表

第一版不自动执行插件升级，但必须主动告诉用户已有经过审核且与当前安装版本兼容的新版本：

- App 侧栏的 **App Store** 入口显示更新标记；存在多个待更新插件时可以显示数量。
- 必须提供独立的“已安装”列表，作为查看当前版本、启停状态、权限、诊断、更新和卸载的统一管理入口。
- 已安装列表中的插件需要明确显示“有新版本”、目标版本和升级按钮，并能筛选待更新项。
- App Store 的已安装卡片也可以显示更新状态，但发现页不能维护另一套安装或更新事实源。
- 用户进入升级确认前，需要看到版本说明、数据迁移、权限变化、计费变化和不可降级提示。
- 用户暂不升级时，标记持续存在；严重安全问题可以把旧版标记为停用，但不能静默迁移用户数据。

当前 Driver V2 已有 `AppStorePage.vue`、独立的 `InstalledAppsPage.vue`，并复用
`InstalledExtensionsCard.vue` 管理已安装插件；`AppSnapshot` 也已经包含 `update` 状态维度。当前仍没有本节定义
的完整升级提醒流程。具体页面归属仍需产品确认，不能把“代码里已有一张设置卡片”误写成目标已完成。

已确认并已落地的界面基线（可信更新源与升级事务仍待后续实现）：

- App Store 标题行右侧放置次级描边“已安装”按钮，与标题平齐；它是页面级管理入口，不进入下方功能分类标签。
- 无更新时按钮显示“已安装”，可以附带安装数量；有更新时显示待更新数量徽标。
- 点击进入独立的已安装管理页面；页面展示版本、启停、权限、诊断、更新和卸载。
- 已安装页面标题为“已安装”，右上角提供“浏览 App Store”返回动作，形成清晰的双向切换。
- 返回 App Store 时保留之前的搜索词、分类和滚动位置。
- 用户不在 App Store 页面时，侧栏 App Store 入口可以显示较轻的更新圆点或数量；侧栏提醒、标题按钮和
  已安装列表必须读取同一更新状态。
- 设置页不再维护第二套管理状态，当前保留已安装入口和“卸载全部”等危险操作。

### 5.6 卸载与撤销

停用、卸载和删除数据是三个不同动作：

- **停用**：停止插件运行和能力代理，但保留安装关系、用户授权、配置、数据和工作流 Instance，重新启用即可恢复。
- **卸载并保留数据（默认）**：停止所有本地与云端调用、停止产生新费用、撤销运行时能力租约，将 Instance
  设为不可运行；保留插件拥有的本地数据、云端配置和业务数据。重新安装同一 `appId` 并通过身份/版本检查后
  可以恢复数据，但不能自动恢复活动权限决定；插件重装后必须重新向用户展示声明并取得同意。
- **卸载并删除数据**：用户二次确认后，删除该插件明确拥有的本地数据、云端配置和可删除业务数据；共享数据
  或不属于插件的数据不能被连带删除。该操作不可恢复。

无论选择哪种卸载路径，账单流水、审核记录、版本来源、迁移链和必要的安全审计都必须保留。OS 权限属于
Driver V2 App 与当前设备，卸载插件不能假装撤销 macOS TCC；Driver 必须停止向该插件代理相关能力。

“保留插件数据”与“保留执行授权”是两个合同：停用可以保留授权，任何卸载都撤销该插件的活动用户权限决定；
必要安全审计可以继续保留，但不能被重装流程当作用户仍然同意的依据。

具体云端 Instance 状态、数据所有权识别和删除事务仍需与外脑后端共同确认。

## 6. 当前计费现状与必须收敛的合同

### 6.1 已具备

- `credit_balances` 与 `credit_transactions` 以 Team 为计费对象。
- API Key 同时记录 Owner User 与 Team。
- Driver/Vibe Board 的直接模型网关可以把 OAuth 用户桥接到其个人默认 Team 的隐藏系统 Key，并记录 OAuth App 归因。
- Tool Template 在调用方 Project 上执行时会继承父运行的 Billing Context，已经接近“安装方 Team 付费”。

### 6.2 当前 Release API 不能直接代表目标合同

Release 的现有计费规则会根据调用方式选择不同付款来源：

- Deployment 自带 `team_id` 时优先使用 Deployment Team；
- 公开或跳过鉴权的 Endpoint 使用发布者配置的 API Key；
- OAuth 调用在部分个人项目场景才回落到调用用户默认 Team；
- 执行归因中仍存在“工作流主人”语义。

因此不能仅给插件一个普通 Release URL，就宣称已经实现“安装到谁的 Team，谁付费”。Installed Workflow Instance 必须带明确的 `targetTeamId`，插件运行入口必须按该合同计费，不能继续依赖现有 Release 的多分支猜测。

证据：`wainao_editor/apps/backend/src/routes/api-run.ts` 的 Deployment/Release Billing Context 选择。

### 6.3 归属与账单审计红线

后续给外脑后端建立 Issue 时，必须把以下内容写成 P0 验收条件，而不是一般注意事项：

1. **身份不得折叠**：`sourceAuthorUserId`、`installedByUserId`、`targetTeamId`、`payerTeamId`、`pluginAppId` 必须分别记录，禁止用一个 `owner` 字段猜测多种语义。
2. **目标 Team 必须服务端复核**：不能信任插件或客户端直接提交的 Team；安装、升级、调用、卸载时都要复核当前用户对目标 Team 的有效权限。
3. **付款 Team 必须与 Instance 合同一致**：默认要求 `payerTeamId == targetTeamId`；未来若支持代付，必须是显式的新合同，不能静默回落到作者 Team、API Key Team 或用户任意默认 Team。
4. **缺失或冲突必须 fail closed**：Instance 没有目标 Team、目标 Team 已失效、安装记录与 Project Team 不一致、Billing Context 与 Instance 不一致时，不得继续运行或猜测兜底。
5. **全生命周期可审计**：创建、授权、运行、升级、回滚、撤销和卸载都要记录 `userId + targetTeamId + payerTeamId + pluginAppId + pluginVersion + workflowInstanceId + sourceVersionId + runId`。
6. **账单写入必须可证明**：余额检查、消费流水和运行记录的 Team 必须一致；失败重试需要幂等，不能重复扣费或出现运行成功但账单无归属。
7. **跨 Team 绝不继承密钥**：作者 Team 的 API Key、Project Secret、连接器凭据不得进入安装方 Instance；安装方必须在自己的 Team/Project 中重新提供或授权。
8. **测试必须包含越权反例**：至少覆盖伪造 Team、退出 Team、权限降级、源作者与安装者不同、Project/Team 不一致、升级竞态、重复请求和余额不足。
9. **个人空间必须有独立隐私不变量**：个人系统 Team 必须带明确标记，永久只允许 Owner 本人；后端必须
   禁止添加其他成员、转让所有权或转换为协作 Team，并审计存量数据；不能把 `private` 误当成仅本人可见。

只有这些不变量通过数据库约束、服务端校验、计费流水和自动化测试共同证明，才能把该能力标记为可公开分发。

## 7. OAuth 与权限开放现状

### 7.1 `main` 已实现

- OAuth Authorization Code + PKCE；
- App scopes、redirect URI 白名单、token 刷新与撤销；
- 用户按 App 查看并撤销授权；
- 管理员禁用 OAuth App 并撤销 token；
- `vibe-board:cloud` 模型网关能力；
- 模型列表、文本对话和语音识别；
- 按 OAuth App、User、Team 记录计费归因。
- `POST /my/default-project/ensure` 可幂等确保并返回个人默认 Team / Project；普通用户 JWT，或具备
  `mobile:full`、`web:search`、`web:fetch` 任一对应路由权限的 OAuth Token 可以调用。

### 7.2 `main` 尚未实现

- 开发者自助创建 App；当前 OAuth App 管理仍是 `site:admin` 后台能力。
- `development → submitted → approved → suspended/delisted` 插件分发状态机。
- `development` App 只能由 `owner_user_id` 授权的服务端硬约束。
- 安装时选择目标 Team 的通用 OAuth/插件授权流程。
- 按插件版本和具体工作流资源授权。
- 图像、视频、OCR 等完整模型能力的 OAuth API；当前网关主要是 text / ASR。
- Team-owned Installed Workflow Instance。
- Driver V2 当前 `profile:read + vibe-board:cloud` 无权调用默认 Project ensure；不能用移动端
  `mobile:full` 代替最小权限合同，需要增加窄 scope 或 Driver 专用服务端动作。

现有 `oauth_apps.owner_user_id` 和 `is_official` 只是可复用字段，当前授权端点没有用它们实现开发者自用限制。

证据：

- `wainao_editor/apps/backend/src/routes/admin/oauth-apps.ts`
- `wainao_editor/apps/backend/src/routes/oauth.ts`
- `wainao_editor/apps/backend/src/utils/oauth-scopes.ts`
- `wainao_editor/apps/backend/src/routes/model-gateway.ts`

### 7.3 2026-08-08 可见未合并分支

`auto/oauth-scope-control-plane`（`745133676c0e572a9a79a003c6cbe7d2c6d5dcda`）相对当时 `main` 领先一个提交，增加动态 Scope 生命周期、紧急停续签/禁用/撤销、影响反查和后台管理。

它可以成为平台逐步开放云能力的治理底座，但没有实现：

- 插件审核状态；
- 开发态仅作者授权；
- 目标 Team 选择；
- 工作流安装实例；
- 插件版本与资源级授权。

该分支尚未合并，本文仅记录其存在，不能作为 Driver V2 当前依赖。

## 8. Driver V2 的本地权限与云权限分层

| 层级 | 示例 | 谁真正持有 | 插件获得什么 |
|---|---|---|---|
| OS 权限 | 麦克风、辅助功能、输入监控、系统通知 | Driver V2 App / 当前设备 | 经 Host Broker 调用，不获得系统授权本身；通知真实三态当前仅 macOS，Windows 暂视为已授权 |
| Host 本地能力 | 终端、CLI、脚本、文件 Broker | Driver V2 Host | Manifest 声明并经运行时门禁的调用权 |
| 云模型能力 | 文本、ASR、图像、视频、OCR | 外脑账号 / 目标 Team | 经 Driver + 外脑 Broker 的计费调用权 |
| 云工作流能力 | Installed Workflow Instance | 目标 Team / Project | 只能调用已安装并锁定的版本 |
| 开发与分发资格 | development / approved | ReAI 平台政策 | 决定谁可以授权和安装，不等同于具体能力授权 |

权限坚持最小开放：平台没有某项能力时可以新增能力申请与审核，而不是发放“任意 API”“任意终端”或“全部网络”权限。

## 9. 已确认产品决策

1. Driver V2 是本地 OS 权限和外脑云能力的统一 Broker。
2. 插件永远不直接取得**外壳的** OAuth Token、API Key 或 Host 长期凭据；插件自有外脑 OAuth App 的
   令牌同样由外壳保管——插件能用（经外壳通道）、不能取（2026-08-14 澄清）。
3. 插件使用稳定 `appId`；从开发到公开分发不更换 `appId`。
4. 第一版允许 Developer Mode，但开发态只能由作者本人使用自己的账号与 Team 额度。
5. 其他用户安装和授权前，插件及其确定版本必须经过官方审核。
6. 插件作者先以外脑用户身份完成工作流开发、测试和发布。
7. 插件只能绑定不可变的已发布工作流版本，不能绑定可变工作区文档。
8. 安装后形成归属于安装方目标 Team 的不可变工作流 Instance。
9. 第一版运行时固定由当前用户的个人系统 Team 付费；未来 Team 版才允许用户明确选择协作 Team 付费。
10. 升级是程序、工作流与数据版本的联合迁移；跨版本升级必须存在明确兼容关系或完整迁移链，不能默认跳级。
11. 各平台已实现的系统权限按设备授权；系统通知真实三态当前仅 macOS，Windows 暂由 Host 视为已授权。云端安装清单和非敏感配置可以同步，但不能同步 Token 或伪造 OS 授权。
12. Instance 可以锁定引用平台保管的不可变源 Snapshot，不要求按安装次数复制相同字节；Instance 的所有权、配置、权限、付款和生命周期仍完全归目标 Team。
13. 作者、安装操作人、目标 Team 和付款 Team 必须分别记录并严格审计；归属或账单不一致一律停止执行，不允许猜测兜底。
14. 第一版任何时候都不展示或提供 Team/Project 切换；平台固定使用当前用户的个人系统 Team 与
    `personal_default` Project，插件 Instance、个人硬件和个人数据默认落在该 Project。
15. 个人默认 Project 必须由带有个人系统标记的 owner-only Team 承载；该 Team 不可增加成员、不可转让、
    不可转成协作 Team，协作场景使用独立 Team / Project。
16. 团队安装、团队付费、团队 Project 与成员权限属于未来 Team 版本；第一版只保留可扩展的归属字段，
    不提供入口，也不根据用户已有 Team 自动切换。
17. 工作流发布必须递归检查完整引用树并生成版本化依赖清单；作者私有密钥与数据不得分发，安装方依赖
    必须转成明确配置项，诊断需定位到引用路径、节点和字段并提供修正方式。
18. 递归检查采用“阻止发布 / 需要安装方配置 / 普通提醒”三级产品语义；具体接入后端发布流程的方式必须
    与外脑项目共同确认，本文不构成直接修改后端的指令。
19. 数据结构或语义变化时，插件版本必须附带经过审核且不可变的升级工作流；升级后记录实际迁移链和数据版本。
20. 成功升级后默认不提供降级；未来只有在对应版本具备专门设计并审核的逆向数据迁移时，才可能开放降级。
21. 每个公开插件新版上架前，平台必须使用审核测试身份和旧版数据副本真实演练升级；失败则打回开发者，
    不允许真实用户先行试错。
22. 升级审核是管理员必经流程并保留结构化证据；初期可人工辅助，未来自动化完成安装、备份、迁移、验证和准入。
23. 每个插件 `appId` 由平台自动创建一个终身专属、开发者不可见的审核测试账号；每次审核使用其标准基线的
    隔离副本，失败不污染基线，成功后才推进基线版本。
24. 平台为外部能力逐步建设 AI 专用测试资源；优先自动化，无法标准化但可受控验证的能力进入更慢、更严格、
    成本更高的人工审核，无法限制或审计真实副作用的能力不得公开上架。
25. 每个插件每个自然月有可配置的 `N` 次免费审核；超额审核使用开发者个人系统 Team 的平台积分付费，
    免费次数和分档价格由平台设置动态配置并在提交前明示。
26. 免费审核同时受每插件 `N` 次和每开发者账号总计 `M` 次限制；两层额度必须同时有余额才免费，防止通过
    批量创建、删除或重建 `appId` 套取免费人工审核。
27. 预检失败不收费；正式进入审核才预占额度或积分。开发者原因驳回或审核开始后撤回正常结算，平台原因
    失败全额恢复；同一提交重试必须幂等且不可重复扣费。
28. 第一版插件升级必须由用户主动确认，不静默执行程序替换或数据迁移；App Store 入口持续显示可更新标记。
29. 已安装插件必须有独立管理列表，统一展示版本、状态、权限、诊断、更新和卸载；App Store 发现页与
    已安装列表读取同一份 Host 安装状态，不能各存一套。
30. App Store 标题右侧使用次级描边“已安装”按钮并显示待更新数量；点击进入独立管理页，返回时保留商店
    搜索、分类与滚动状态。Driver V2 当前已落地独立已安装页、入口与更新计数；真实在线更新源仍待发布系统接入。
31. 卸载默认保留插件数据，并提供二次确认的“连数据一起删除”；停用、卸载和删除数据语义严格分离，任何
    路径都不能删除账单、审核、版本来源、迁移链和必要安全审计。
32. 每一个公开插件版本都必须重新经过平台审核，不能因为 `appId` 或旧版本已通过审核就自动继承公开资格。
33. 新版本扩大权限、扩大数据访问边界、增加新的 OS/云端/终端/外部连接器能力，或提高/改变用户承担的
    价格时，升级前必须再次取得用户明确同意；旧授权不能自动覆盖新增范围。
34. 工作流或业务逻辑变化但权限范围未扩大时，仍需在升级确认页说明变化并由用户确认升级，不额外弹出一层
    权限授权对话框；价格降低或权限减少同理，只需清晰展示变化。
35. OS 系统授权继续按设备由操作系统管理；插件升级不能把 A 设备的 TCC 状态同步到 B 设备，也不能把
    Driver 已获系统权限理解成所有插件自动获准使用该能力。
36. 用户拒绝新版权限或升级条款时继续停留在旧版；若旧版存在严重安全问题，平台可以将旧版标记为停用，
    但不能借安全处置绕过用户同意、静默升级或迁移数据。

## 10. 已收敛的版本复审与用户重新同意规则

版本审核、升级确认与权限重新同意是三层不同门禁：

1. **平台复审**：每一个公开版本都必经，审核对象包含插件代码、权限、工作流、数据、迁移和计费说明。
2. **升级确认**：任何版本变化都需要用户主动触发并确认，第一版没有后台自动升级。
3. **权限/价格重新同意**：只有权限或数据边界扩大、增加新能力，或用户承担价格提高/变化时额外触发；
   权限减少、价格降低以及同权限范围内的工作流变化不重复索取权限，但必须在升级说明中展示。
4. **拒绝路径**：拒绝不会改变现有安装版本；旧版被安全停用时只停止运行，不自动切换版本或迁移数据。

## 11. 跨项目协作与变更边界

本文是 Driver V2 向外脑提出的产品需求、目标不变量与风险清单，不是要求后端据此直接修改代码。凡涉及
`wainao_editor` 的功能，必须遵循：

1. 开发前重新核对后端最新分支、现有业务流程、数据模型、API、计费与权限边界。
2. Driver V2 与后端共同确认产品合同、职责边界、兼容策略、数据迁移、审计要求和失败/回滚行为。
3. 后端 Issue 先描述问题、目标语义、验收条件、风险和待确认项；未共同确认前，不把本文中的候选字段、
   接口或流程写成指定实现。
4. 具体技术方案由后端结合现状提出并与 Driver V2 联合评审；涉及双方合同的变更需要两边共同验证。
5. 归属、账单、密钥和存量数据迁移属于高风险项，不能由任一项目单方面决定或静默兼容。
6. 只读 Ask Project 调研用于建立讨论背景，不授权修改目标仓库，也不能代替开发时的最新代码复核。

## 12. 调研边界

本次通过 `ask-project` 以 read-only 方式咨询 `/Users/kongkang/Developer/wainao_editor`：

- 当时 `main` 与本地 `origin/main` 均为 `a976372e5f6603ef6eb6bba5293aa91519388568`，工作区干净。
- 已核对 main、可见 refs/worktrees、实体表、Deployment/Release、Tool Template/Package、OAuth、模型网关和计费路径。
- GitHub Issue 实时查询因网络连接失败，不能声称已经盘点远端所有 Issue。
- 独立咨询进程完成取证后，在生成最终长报告时因连接重试长时间无输出而被终止；本文只采用它已经返回的代码与 Git 证据，不把未返回的推断写成事实。
- 随后再次只读核对默认 Team/Project 专题并完整返回：确认了 ensure 接口、幂等与保护规则、现有调用方、
  Driver scope 缺口，以及“private 仍对 Team 成员可读”和 Team 转让可能破坏归属不变量的风险。本轮未
  fetch，因此事实代表目标仓库当时本地 `main`，不能代替未来开发前的最新分支复核。

### 12.1 2026-08-09 自动开发前复核

本轮再次通过 Ask Project 只读核对 `wainao_editor` 本地 `main`（`a976372e5f6603ef6eb6bba5293aa91519388568`，
相对本地 `origin/main` ahead/behind 均为 0，工作区干净；未 fetch）。结论进一步收敛为：

- `vibe-board:cloud` 已能调用模型列表、文本 Chat Completions 和音频转写，模型网关内部会为 OAuth 用户
  ensure 默认 Team/Project 与隐藏系统 API Key，并记录 user / OAuth App / Team / Project 计费归因。
  因此 Driver 可以在不向插件暴露 Token 或 API Key 的前提下先做结构化模型 Broker；图像、视频与 OCR
  不能因多模态模型可能可用就自动宣称为稳定 `vision.recognize` 合同。
- `/my/default-project/ensure` 不开放给 `profile:read + vibe-board:cloud`；Driver 只有在用户重新授权
  `web:search` 或 `web:fetch` 后才能调用，而且这不等于拥有通用个人空间管理权限。
- Deployment 级联发布已递归处理 Flow、冻结 revision、检测循环并尝试失败回滚；但构建 Tool manifest
  失败时存在 warning 后回退原 snapshot 的路径，不能满足插件公开发布必须 fail closed 的递归诊断要求。
- Tool Template/Package 的版本、安装和 required config 可复用为底层素材，但现有 Template 版本切换允许
  选择旧 published 版本；Package 更新还可能先移除旧内容再装新版，均不能直接当作插件“失败保留旧版、
  成功默认不可降级”的正式升级合同。
- 现有 Release 计费可能选择 Deployment Team 或发布者配置 Key，不等于 Installed Instance 的安装者
  Team 付费；正式插件运行不得把该多分支逻辑当作“谁使用谁付费”的证明。
- 仓库中的 Tool Package RLS 定义存在 published 即可读、未按 private/team/global 再分层的风险；正式
  联合开发前需要后端核对真实已部署策略，并同时验证 API 与 RLS 两层越权反例。
- Template/Package 会保存客户端提交的 hidden input defaults。现有 secret scanner 能提取密钥名称，
  但尚不足以证明默认值中不含作者私有值；正式发布 API 必须服务端重跑值泄漏与可移植性检查。
- 当前后端仍只识别 Driver 这个 OAuth App 和用户，不识别经 Driver 调用的具体插件版本。云能力公开分发前
  必须共同确定可验证的 plugin/version 归因，不能信任插件自己在请求参数中声明身份。

本轮 Ask Project 的完整只读输出保存在会话和临时审计结果中；上述内容只进入 Driver 的产品/合同文档，
不构成对后端仓库的修改授权。
