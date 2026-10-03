# Titlebar Actions Demo

一个不进入 Host 内置 seed 的独立第三方插件样例，用来验证 `titlebar.action@1`。
它拥有自己的依赖锁，不属于 Driver workspace：

```bash
bun install --frozen-lockfile --ignore-scripts
bun run test
bun run typecheck
bun run validate
bun run build
bun run test:contract
bun run pack
```

本目录的 `file:` 依赖用于仓库内联调。上述命令不自动验证仓库外 tarball 安装或真实 Host 安装生命周期；这些项目需要单独验收。

真实 Host 验收尚未由本仓库命令完成。手动验收时，在 macOS ReAI Board 开启 Developer Mode 并本地安装该包。打开 `Titlebar Demo`，鼠标移入整条标题栏，检查 `＋ 运行` 是否显示；点击后检查页面状态是否变为 `clicked · 标题栏动作已送达插件`。
