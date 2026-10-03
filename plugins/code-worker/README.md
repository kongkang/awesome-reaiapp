# AI 代码编排

ReAI 插件 `com.reai.code-worker`。当前源码版本为 `0.2.1`。提供全局看板、子任务详情、协作角色和 Agent 投影。Host 提供公开存储、Service 和本机网关。

编排者领取需求并拆分任务。Worker 和独立 Tester 使用各自连接执行并报告。`begin` 占用并发额度，终态归还额度。外部 Agent 仍使用原有工具和仓库权限，报告来源为 `agent-report`。

管理员在协作角色中创建或更新连接，再将连接交给指定 Agent。端口由 Host 动态分配。凭据不能写入 Git、公开日志或截图。账号变化或 App 重启后需要更新连接。

插件提供公开的编排接口说明和 Python 客户端，位于 `assets/skills/ai-code-orchestration/`。它们属于插件功能资源，与本地开发技能分开管理。客户端只依赖 Python 3 标准库。

## 本地构建

先在仓库的 `packages/` 目录安装冻结依赖，再在本目录执行：

```sh
bun install --frozen-lockfile --ignore-scripts
bun run test
bun run typecheck
bun run validate
bun run build
bun run test:contract
bun run pack
```

本目录依赖 `../../packages/` 中的 SDK 和工具。构建会重新生成 `dist/`、`build-manifest.json` 和 `.reaiapp`，这些产物不提交到 Git。

## 提交检查

复制 `submission.identity.example.json` 为本地 `submission.identity.json`。模板的 `publisherId`、`oauthAppId` 和 `productId` 都是虚构占位，必须替换为实际平台配置。模板不能用于上传，也不代表审核批准。替换后核对 Manifest 的发布者、OAuth App 和版本与本地配置一致。不要在配置里保存密钥。

普通 `bun run pack` 不读取提交身份；提交检查和 `pack:submission` 才读取本地配置。

`submission.identity.json` 保存提交配置。Manifest 的发布者、OAuth App 和版本必须与提交配置一致。Product ID 只用于提交配置。OAuth Client ID 是公开标识，凭据由 Host 管理。

```sh
bun run check:submission --form-version <实际版本>
bun run pack:submission
```

提交打包会检查身份、重复构建和包内资源。表单版本必须与最终包一致。

开发与安装要求见 [开发规范](../../docs/plugin-development-v1.md) 和 [提交规范](../../docs/plugin-submission-v1.md)。本地测试和打包只证明本地结果。真实 Host 安装、用户授权、平台审核和商店发布需要各自的验证证据。
