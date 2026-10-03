# open.reai.com 静态站部署

2026-10-03 首次上线，当前唯一网站目标为 `root@cn.reai.com`（`node3`）。用户已在本次请求授权发布这个域名；本记录不授予未来新增凭据、网络规则、删除数据或未经请求发布的权限。插件上传/审核不是这个网站部署流程。

- 网站：https://open.reai.com/；英文：https://open.reai.com/en/；整合文档：`/docs/` 和 `/docs/en/`。
- 专属配置：`/etc/nginx/sites-available/open.reai.com.conf`，由同名 `sites-enabled` 链接启用。80 跳到 HTTPS，ACME challenge 使用已有 `/var/www/certbot`。
- 版本目录：`/var/www/open.reai.com/releases/<releaseId>/site/`；线上根目录：`/var/www/open.reai.com/current`。不使用 Git 目录作为 web root。
- TLS：Certbot 已有 ACME 账户，域名证书在 `/etc/letsencrypt/live/open.reai.com/`；`certbot.timer` 已启用。`renew-open-certificate.sh` 只在此域名证书成功续期后检查并 reload Nginx；续期本身未通过强制换证演练。
- 网站为静态文件，公共 Catalog 由浏览器无凭据读取。没有网站账号、应用服务进程、数据库或 migration。

## 每次已获授权的网站发布

1. 核本地当前分支和改动范围、目标主机身份、线上 current 与 release.json。保留已有用户改动；不要根据 Git HEAD 单独声称未提交输入已复现。
2. 用 `REAI_OPEN_OUTPUT=/绝对路径/候选/site bun run build` 在 `open-website/` 构建全新目录，使用同一环境变量运行 `bun run test`。完整输入摘要、候选产物及截图保留在本地 `.artifacts/open-website/releases/<releaseId>/`。
3. 上传前核只含网站静态产物、依赖 license notices、公开 Catalog 与公开发布标识；不上传 plugins 源码、node_modules、skills、私钥、凭据、用户数据或内部验收日志。当前公共 Catalog 没有逐版本日志或多语言文案，不伪造。
4. `rsync -az 候选/site/ root@cn.reai.com:/var/www/open.reai.com/releases/<releaseId>/site/`，另传 SHA256SUMS。在版本目录内执行 `sha256sum -c ../SHA256SUMS`；不使用 `--delete` 或清理别的项目目录。
5. 切换前记录旧 current。使用新的临时 symlink 指向候选，再 `mv -Tf` 原子替换 current；保留旧版本。配置有变化时先备份本域名文件，`nginx -t` 通过后才 `systemctl reload nginx`。不重启其他项目的应用。
6. 默认 TLS 校验检查 HTTP→HTTPS、全部产物摘要、zh/en 页面、文档 clean URL、公开目录刷新、下载与语言入口、未知路径真实404。Nginx appId 回退必须先尝试真实静态文件，不要将 `apps/index.html` 误判为新 appId。
7. 写明线上实际 releaseId、源输入与产物摘要、验证及限制，维护本文件、根项目说明和本地 deployment 记录。

VitePress 的文档 JS/CSS 文件名含内容摘要，缓存7天；下一次更新需保留旧版 hashed assets 在新候选的 `docs/assets/`，保证已打开文档的后续客户端导航可用。常规网站入口文件按内容摘要 query 重新校验。不要在共享服务器执行目录清理。

## 回滚

未来有上一版本时，重新建立指向旧版本 `site/` 的临时链接，再原子替换 current，并验证旧 release.json、HTTPS 与页面。若涉及配置变化，恢复对应已保留的本域名配置，先 `nginx -t` 再 reload。首发前没有旧网站版本：保留的 `nginx-before-https.conf` 是本次 ACME-only 配置，恢复后网站返回503，不声称它是旧网站。

## 首次发布证据

- releaseId：`20261003T021627Z-d586e4116e7a`。
- 候选317个文件，共8,062,043字节；服务器端及线上逐文件 SHA-256 校验一致。
- SHA256SUMS 摘要：`3febed16ef45b8d24f883d7d009720cbf4a683e319399ac7deba83f36f191e16`。
- 源输入摘要：`d586e4116e7adb6646bdbe322ac58331bcfc40a762d82ff7d1b5b388dd1addb3`，来自功能分支未提交输入。发布配置后续修正了静态文件优先级，最终配置单独记录 SHA-256：`d8a4508119841b49a42bfeb417162a15f26b3276521f86dac1586d8cb350639e`。
- Nginx检查、HTTPS、16个代表路由与访问边界通过；旧 `ai-board.reai.com/docs/` 仍为200，未强制切换历史链接。
- 本地8项测试通过。浏览器核 zh/en 切换、查询保持、公开目录更新与图标加载、版本入口、文档返回、官网对应语言下载；375/768px英文页面未整页溢出。
- 中文23篇完整规范；英文23篇阅读指南，不是逐字全文翻译。公共 Catalog 的发布者内容保留原文。
