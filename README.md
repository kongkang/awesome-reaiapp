# Awesome ReAI App

本仓库计划作为 ReAI 全部官方插件未来公开收纳的统一仓库，集中维护插件源码、使用说明，以及独立构建、安装和升级所需的内容。

插件的开发与交付应与 ReAI Host 解耦，支持独立构建、安装和升级，无需随 Host 重新打包。

目前仅完成仓库文档初始化，尚未迁入插件源码。GitHub 仓库：[kongkang/awesome-reaiapp](https://github.com/kongkang/awesome-reaiapp)。

官方插件的审核、签名与发布遵循正式流程，官方身份不绕过相关要求。

许可证待核实和确认。

## 目录规范

以下是规划示例，尚未创建这些目录或迁入插件；`voice`、`browser`、`terminal` 仅用于说明各插件的独立位置，不代表完整插件清单。

```text
awesome-reaiapp/
├── README.md
├── plugins/
│   ├── voice/
│   ├── browser/
│   └── terminal/
├── docs/        # 仓库与插件文档
├── scripts/     # 构建、验证与发布脚本
├── packages/    # 可复用的共享代码包
└── examples/    # 插件开发示例
```

每个插件采用独立目录，基本结构规划如下。正式声明文件名 `app.manifest.json` 已按当前平台规范及现有官方插件核对。

```text
plugins/<slug>/
├── README.md          # 用途、依赖、构建、安装与升级说明
├── app.manifest.json  # 插件正式声明，包含稳定 appId 与插件版本
├── package.json       # 插件依赖及构建、测试脚本
├── bun.lock           # 插件依赖锁
├── src/               # 插件源码
└── tests/             # 插件测试
```

- 目录名应短、稳定，使用小写 kebab-case，例如 `voice`、`code-worker`；不将版本号写入目录名。
- 显示名称可以调整，稳定插件 ID（`appId`）保持不变。
- 每个插件独立维护版本、依赖锁、构建、测试与发布流程，分别生成安装包并独立安装、升级。
- 同处一个 monorepo 不要求插件捆绑发布或同步升级，也不要求重新打包 Host。
- 共享代码放在 `packages/`；共享依赖发生变更时，应测试所有受影响插件，并按实际影响安排各插件发布。
