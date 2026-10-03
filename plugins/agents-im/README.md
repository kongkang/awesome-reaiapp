# agents-im

ReAI 官方插件源码候选。用途、能力、权限与贡献点以 `app.manifest.json` 为准。

## 独立仓库构建

稳定 ID：`com.reai.agents-im`；当前迁移版本：`1.0.0`。本目录依赖 `../../packages/` 中的 SDK 与工具，不依赖 Board Host 源码进行构建。

```bash
bun install --frozen-lockfile --ignore-scripts
bun run test
bun run typecheck
bun run validate
bun run build
bun run test:contract
bun run pack
```

开发、权限、安装与升级边界见 [开发规范](../../docs/plugin-development-v1.md) 和 [提交规范](../../docs/plugin-submission-v1.md)。真实 Host 安装及交互仍需按规范验收；迁移或本地出包不等于获得发布批准。
