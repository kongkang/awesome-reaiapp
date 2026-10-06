# 语音输入法

ReAI 插件 `com.reai.voice`。当前源码候选为 `2.14.5-dev.3`。通过语音键录音，将识别或润色后的文字写入当前应用。支持全天时间线、云端转写、翻译和 Agent 对话。

Agent 会话使用版本化服务接口。界面不再提供工作目录选择入口。存量对话的已授权目录继续由 Host 复验。Host 控制目录范围和命令权限。复制诊断使用固定字段，不包含转写、回答、凭据或自定义模型路径。语言覆盖见 [I18N_COVERAGE.md](I18N_COVERAGE.md)。

当前版本缺少 `surface.clipboard@1`、`agent.session@2`、`system.folder-pick@1` 和 `local.terminal.exec@1` 的精确源码审核记录。标准校验会拒绝构建。新的独立源码审查必须绑定完整输入清单和最终包摘要；本地审查不能代替平台批准。

## 当前候选变化

候选增加 PDF、XLSX 和 XLS 附件正文提取。附件根据模型能力和读取开关准入，提交时保持文件与消息一致。图片仍遵循现有模型能力和历史恢复规则。

文档提取保留文件、条目、解压大小和 Worker 时限。PDF 增加累计解码预算，表格增加格式、CFB 链及链接范围检查。超限或格式无效时整份附件失败，不返回静默截断的正文。这些防护不代表整个解析器具有统一内存上限。

现场记录按原始顺序和时间合并连续句片，可展开原始片段。语音列表的复制按钮在悬停或键盘聚焦时显示，触屏设备保持可见。设置中的云端模型只显示名称。

完整候选介绍见 [更新日志](CHANGELOG.md)。这些源码变化尚不代表平台批准、签名、已安装插件更新或商店发布。当前设置页的版本和关于入口尚未完成，要求见 [设置页与版本规范](../../docs/plugin-settings-and-release-notes-v1.md)。

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

本目录依赖 `../../packages/` 中的 SDK 和工具。`prepare:documents` 从固定依赖生成 PDF 和表格 Worker、字符映射与字体资源，并保留第三方许可证。测试、构建和打包命令会执行该步骤。文档资源及生成 reader 属于可复现源码输入。构建生成的 `dist/`、`build-manifest.json` 和 `.reaiapp` 不提交到 Git。

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
