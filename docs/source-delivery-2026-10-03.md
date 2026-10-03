# 源码公开与本地打包验收

验收日期：2026-10-03。所有编辑和验证在独立 worktree 完成。脱敏文档已先通过 [PR #3](https://github.com/kongkang/awesome-reaiapp/pull/3) 合并，然后执行插件流水线。

15/15 插件和 4/4 示例完成冻结安装、测试、类型检查、校验、编译、合同检查及两次打包。应用使用 Mock Host；Skin 检查 Manifest 和包合同。19/19 对重复包的 SHA-256 和字节数一致。

插件单元测试 1777 项、示例测试 53 项、共享工具测试 424 项全部通过，共 2254 项。文档和开放平台构建通过，网站 8 项测试通过。

## 插件包

| 插件 | 源码版本 | 单元测试通过数 | 字节数 | 包 SHA-256 |
| --- | --- | ---: | ---: | --- |
| agents-im | 1.0.0 | 137 | 189994 | `b3defb21156a828df41eeae92e6c6ac1bdfb510cf246ed2b245d1d8df0894346` |
| agents-tasks | 1.0.1-dev.1 | 28 | 101527 | `beb63c53ab54ad0570c8d6ae8f2069061e30936e8768139827d0be090de0b5ad` |
| browser | 1.0.4-dev.2 | 13 | 32808 | `457b3d726b1ae032148e94ebe4df9e18997718068af300ed3db71f93bf926ccc` |
| code-worker | 0.2.1 | 26 | 233004 | `da790edfa54a13ebf8be69453a2894be5deb46e565e508bef150595777e24bd6` |
| codex-app | 0.1.9-h08.1 | 92 | 194975 | `6f11e14ddbd80c95ea351137c1258a79d2d6bd1575a1e40709c4e5ca103e1355` |
| codex-link | 0.5.12 | 212 | 234375 | `96c39b76c6a2b3c9fb39b6dcf3aefc8a9daa8fd833ffa4037a5730cd5ed57345` |
| computer | 0.1.1-dev.1 | 14 | 38622 | `8c3e71799b55b916ac5fec30ce0e529627db4e3a2f20c47c0b81b1d67f0a8040` |
| device-doctor | 1.0.2 | 21 | 54427 | `7afad7b994c918a18d9bbe19a1c9345113f5cae91a25d419f781a5b818d8bdb7` |
| dsh-agent | 1.2.8-dev.1 | 11 | 71379 | `1ca6d75f4784c5c4d1adfd9218214e1cbc3d4b53c5655d93d949be73e3bf6b2d` |
| pi-agent | 1.0.4-dev.2 | 10 | 91609 | `26597d0ed0cba6e0f118c82c6750eecd39327e31114c98da50621619eb373a32` |
| podcast | 1.0.1-dev.2 | 23 | 45496 | `854ba51d25c2d429cb94fc65058466c7ebd9b520001a0bfcc9379931e26f67d4` |
| terminal | 1.0.4-k03.1 | 7 | 581725 | `a1961ef9bb613a9037464bc2022db546a834a502b28500921b91a4f315645578` |
| text-editor | 0.1.2-dev.1 | 43 | 2403809 | `93242eed6d47330b82050dcd6ed300ac68ae829908f376c37720f8354b1ffba1` |
| voice | 2.14.4-rc.3 | 1137 | 1591429 | `8cd7bb2ba12e7d4d74cd18855b2e8ff5e250c74603d8a47e6ccc5494cf0f3a0c` |
| wishing-wall | 0.4.2 | 3 | 117358 | `27b3c0757b833294e52f5695a683f530664e6167e274f505b4129a6c37dcbd30` |

## 示例包

| 示例 | 版本 | 字节数 | 包 SHA-256 |
| --- | --- | ---: | --- |
| examples/todo-app | 1.1.1 | 155225 | `83da5f851f69a401e99b8b5708f012e48c56882c0cb1093afaac538c82966217` |
| examples/titlebar-actions-app | 1.0.2 | 100200 | `4711f226cafb6f8a2339e0b407e94ab81408e6466f9192e6fc1a4529a18dbe43` |
| examples/skins/codex | 0.1.0 | 5154 | `d1f2c464c8d3e758d14825667f50531bd1b7d4328491d042f869b17602d3f587` |
| examples/skins/claude | 0.1.0 | 5169 | `eaa7ae62fc14850809c6c49a1bf5ffba60c76b7ff79672b218aff9663bbe3deb` |

## 审核与公开边界

Voice 的标准校验仍要求当前版本的四项受控能力源码审核。本次使用独立审查的完整输入清单与精确包摘要，通过已有 `--source-review` 入口完成本地预检；两次正式打包都与审查候选摘要一致。审核种子与能力门禁没有放宽。

私有审核报告和证据不进入 GitHub。公开 clone 的 CI 对 Voice 执行测试、类型检查，并确认无显式证据时校验、构建和打包按预期拒绝。其他 14 个插件和 4 个示例在 CI 执行正常编译、合同检查和打包。

生产配置、提交身份、凭据、用户数据、内部安全细节、迁移来源、私人验收材料和根目录本地技能保持私有。提交身份提供明确占位的公开模板。原始输入在仓库外保留了逐文件摘要一致的备份。

本报告证明当前本地构建与包字节结果。平台审核、签名、真实 Host 安装、用户授权、商店上架和网站生产更新需要分别验收。构建产物保留于本地忽略目录。
