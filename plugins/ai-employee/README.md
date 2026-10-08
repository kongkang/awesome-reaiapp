# AI 员工三阶段模板

`com.example.ai-employee`，源码版本 `0.1.0`。这是开发 Demo，不是已上架的产品。

模板将原始资料、标准记录和岗位 Agent 分为三个逻辑阶段。界面提供工作看板、原始资料入口、可编辑记录、报告和侧边 Agent。默认岗位为财务，另含人事配置。岗位配置驱动字段、列标题、校验、提示词与定制展示。

## 跑通本地闭环

先在仓库 `packages/` 目录安装冻结依赖，再在本目录执行：

```sh
bun install --frozen-lockfile --ignore-scripts
bun run test
bun run typecheck
bun run validate
bun run build
bun run test:contract
bun run pack
bun run dev
```

打开开发服务提供的 `preview.html` 地址。它运行与插件共用的界面和业务代码，使用浏览器本地存储。浏览器预览不需要启动 Driver，不代表真实 Host 安装成功。

1. 在设置中填写公司名称、展示偏好和岗位的通用配置。
2. 在原始资料中导入 `assets/sample-finance.csv`，或粘贴相同格式的 CSV / JSON。
3. 执行整理。检查标准记录的列、金额和来源。含无效行的文件不会产生部分标准记录。
4. 修改一条标准记录，再查看原始资料与修订历史。原始字节保持不变。
5. 打开 Agent，询问收支情况。默认「演示分析」使用规则计算，不调用大模型。
6. 确认保存报告，再下载报告。报告保留来源与记录版本，不覆盖标准记录。
7. 刷新页面，检查原始资料、记录、配置和报告的保留结果。

示例 CSV 全为虚构数据。金额导入单位为元，标准记录使用整数分保存。Demo 接受有界的 UTF-8 CSV、JSON 和文本资料，也可保存 PDF、图片和办公文档原件。自动整理仅支持岗位 CSV / JSON。PDF / 办公文档提取、OCR、邮箱采集、定时任务、云数据库、向量库和图数据库未实现。

## 设置与开发模式

所有配置集中在设置页。通用设置用于公司信息、业务偏好和展示。开发模式用于岗位字段、提示词、inline Skill、SOP、配色、Logo 文字、CSS 和 HTML 模板。当前 Demo 保持只读 Agent，工具引用必须为空。

首次使用时，设置自己的开发者密码，再输入密码解锁。密码不随岗位配置导出。解锁状态只在当前界面实例中保留，刷新后重新锁定。此密码用于防止误改配置，不替代平台权限、加密存储或公司身份管理。

已有标准记录时，不能直接改变其字段结构。需要新岗位时，优先创建新的插件身份，避免把旧岗位数据解释成新岗位数据。CSS 与 HTML 经过校验，定制 HTML 由受限制的展示容器呈现，不取得应用执行权限。

## 生成另一岗位的插件

在开发模式编辑并导出岗位配置，保存为 JSON。配置只含岗位定义，不含原始资料、标准记录、公司运行数据或开发者密码。发布前仍需检查提示词与 Skill 是否包含公司机密。

```sh
bun run scaffold --profile role-profile.json \
  --app-id com.example.customer-support \
  --name "客户支持工作台" \
  --publisher-id 22222222-2222-4222-8222-222222222222 \
  --out ../customer-support
```

示例身份不能用于提交。请替换为自己的新 `appId` 和平台登记的 `publisherId`。

生成器安装岗位配置到 `src/profiles/default-profile.json`，更新 Manifest、应用入口身份和打包名称。它只复制公开模板文件，不复制原始资料、用户存储、私有身份、依赖目录或构建产物。输出目录已存在时会拒绝，原目录保持不变。

输出可放在仓库 `plugins/<slug>` 或其他目录。生成器会把本地 `file:` 依赖重定位为输出目录的相对路径。首次在生成目录运行 `bun install --ignore-scripts`，产生该目录的锁文件，再运行测试、类型检查、校验和构建。复制插件源目录并不包含平台包的独立分发能力。移动输出目录后，应重新运行生成器，或重新配置本地依赖并生成锁文件。

## 真实 Agent 候选

默认包不申请模型能力，演示分析不会伪装成真实模型。代码提供 Agent Service v2 适配器。它根据当前岗位和公司配置创建会话，向模型提供有界的标准记录上下文，返回文字分析。Agent 不能直接修改业务记录。

```sh
bun run prepare:agent --name agent-candidate
```

该命令只在本插件的 `.artifacts/agent-candidate/` 准备候选源码。候选增加 `agent.session@2`、`cloud.model.invoke@1` 及对应用户权限，将 Host API 下界设为 `1.21.0`。它不修改默认 Manifest，不新增审核白名单，不调用生产服务，不安装或发布插件。

尚无平台批准时，CLI 校验该候选应返回 `APP_CAPABILITY_NOT_GRANTED`。这表示当前权限合同按预期拒绝。实际调用还需要平台精确包批准、用户同意、可用受管运行组件、有效外脑 OAuth 会话，以及对应 Host 支持。密码、提示词、Skill 和 Manifest 均不能赋予这些权限。

## 规范与验证边界

实现合同见 [三阶段最佳实践](../../docs/ai-employee-pattern-v1.md)、[插件开发规范](../../docs/plugin-development-v1.md)、[设计规范](../../docs/plugin-design-system-v1.md)、[Agent Service v2](../../docs/agent-service-v2.md) 和 [设置页与版本规范](../../docs/plugin-settings-and-release-notes-v1.md)。设置页版本取当前 Manifest，提供精确版本日志与关于入口。

本地单元测试、类型检查、CLI 校验、构建、合同测试、打包和浏览器交互分别提供对应证据。平台审核、签名、真实 Host 安装、真实模型调用、语音能力和商店发布尚未验证。不得从本地演示继承上述结果。

## 外部资料适配接口

`src/source-adapter.ts` 提供通用 `SourceAdapter.read({ signal, maxItems, maxBytesPerItem })` 接口。采集器返回 `{ name, mimeType?, bytes }` 数组，再由 `ingestSourceBatch` 追加原始资料。当前每批最多 20 份，每份最多 128 KiB，同内容重试按 SHA-256 去重。适配器应在读取和下载时遵守输入预算。

适配器只提供原始字节，不清洗记录，不运行 Agent。调用方需要另外执行整理。入库按文件分别提交，后续文件失败不会回滚已保存原件。取消会在读取前后与每份入库前检查，正在入库的单份资料仍可能完成保存。

本地 fixture 验证了同内容重试和采集前取消。当前接口没有连接邮箱、网盘、远程 API 或后台定时器，也没有提供凭据管理或自动重试服务。接入真实来源时，需要实现对应采集器，另行核对网络能力、来源授权、用户同意与运行时支持。默认包不声明网络端点。
