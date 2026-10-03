# 官方插件

本目录包含 15 个官方插件的独立源码候选。每个目录拥有自己的依赖锁、测试、构建和打包入口；同处一个仓库不要求捆绑发布或重新打包 Host。稳定 appId 和插件版本沿用迁移快照。

进入相应插件目录运行：

```bash
bun install --frozen-lockfile --ignore-scripts
bun run test
bun run typecheck
bun run validate
bun run build
bun run test:contract
bun run pack
```

共享工具在 `../packages/`，开发规范见 [开发文档](../docs/README.md)。产出的 `.reaiapp` 仍走正式审核、摘要绑定、签名和安装流程。源码候选及本地测试通过不代表已批准公开分发或运行。Voice 当前缺少迁移输入对应的四项能力审核，校验与出包会保留拒绝，不得通过降低门禁绕过。
