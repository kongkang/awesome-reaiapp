# 网站交付与发布

公开入口为 [open.reai.com](https://open.reai.com/)，英文入口为 [/en/](https://open.reai.com/en/)，文档入口为 [/docs/](https://open.reai.com/docs/) 和 [/docs/en/](https://open.reai.com/docs/en/)。

网站使用静态产物和匿名公共 Catalog，不包含账号服务、数据库或 migration。GitHub 源码公开与生产部署分别处理。

## 本地构建

在独立 worktree 安装 `website/` 的冻结依赖，再进入 `open-website/`：

```sh
bun run build
bun run test
```

默认产物位于 `dist/`。可用 `REAI_OPEN_OUTPUT` 指定新的候选目录。构建不会执行远端上传、配置修改或服务重启。

## 发布检查

1. 按本次授权核对目标和当前公开版本。
2. 检查脱敏输入、静态产物、依赖许可、公开 Catalog 和产物摘要。
3. 保留上一版本和对应配置。按本地已核验的发布与回滚流程处理。
4. 核验 HTTPS、实际版本、中文与英文路由、文档链接、匿名权限和未知路径的 404。

真实主机、账号、目录、TLS 配置、运维命令及详细发布证据保留于本地，不随源码公开。不得把历史发布记录当成本次产物的上线证据。

VitePress 的 JS/CSS 文件名包含内容摘要。部署时保留仍被已打开页面引用的旧资源，避免客户端导航失败。
