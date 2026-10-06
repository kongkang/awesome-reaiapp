# awesome main 本地验证证据

> 历史核验日期：2026-10-04；归档日期：2026-10-06。来源为已恢复的同名正式报告，以下为公开范围脱敏归档；保留当时结论和未验事项，不代表本次重新执行或当前状态。机器/任务身份、内部工具与未纳入附件的活链已移除。

- 输入提交：`09202cf4aaa07f7cbd05c2d6c453fbdcab4d5b16`（当前 main 基线；本报告不覆盖根任务的候选测试修复）。
- 工具：Bun `1.3.11`；所有依赖使用独立目录冻结安装，`--ignore-scripts`。
- 验证使用独立目录；未启动或重启 Host，未修改源码。

| 范围 | 测试 | 其他检查 |
|---|---|---|
| packages | 424 pass / 0 fail，34 文件 | 冻结安装、类型检查、install-probe validate/build/contract 全部退出 0 |
| todo-app | 45 pass / 0 fail | 冻结安装、类型检查、validate/build/contract/pack 全部退出 0 |
| titlebar-actions-app | 6 pass / 0 fail | 冻结安装、类型检查、validate/build/contract/pack 全部退出 0；locale contract（Host API 1.16.0）通过 |
| skins/codex | 1 pass / 0 fail | 冻结安装、类型检查、validate/build/test:contract/pack 全部退出 0 |
| skins/claude | 1 pass / 0 fail | 冻结安装、类型检查、validate/build/test:contract/pack 全部退出 0 |
| agents-im 基线 | 本子任务未重复单测，根任务另跑 main 137 项 | 冻结安装、validate/build/contract（Host API 1.1）/pack 全部退出 0 |
| website / open-website | 网站既有 8 tests / 0 fail | 冻结安装、文档站构建、公开站构建/测试全部退出 0；既有 >500 kB chunk 提示 |

skins 的 `test:contract` 实际执行 validate 和重复的同一单测，不是 `reai-app contract-test`。每例现有单测覆盖 manifest 身份与明暗主题 token 完整性。todo、titlebar 和 agents-im 的合同检查使用 Mock Host。

首次 todo/titlebar 冻结安装因受限网络下载失败，随后经已授权的联网安装成功，并完整重跑通过。原失败与重跑的命令、退出码分别保留在 JSON 中。

## 包摘要

| 包 | bytes | SHA256 |
|---|---:|---|
| `examples/todo-app/todo-1.1.1.reaiapp` | 155225 | `83da5f851f69a401e99b8b5708f012e48c56882c0cb1093afaac538c82966217` |
| `examples/titlebar-actions-app/titlebar-actions-demo-1.0.2.reaiapp` | 100200 | `4711f226cafb6f8a2339e0b407e94ab81408e6466f9192e6fc1a4529a18dbe43` |
| `plugins/agents-im/ni-chat-1.0.0.reaiapp` | 189994 | `b3defb21156a828df41eeae92e6c6ac1bdfb510cf246ed2b245d1d8df0894346` |
| `examples/skins/codex/codex-skin-0.1.0.reaiapp` | 5154 | `d1f2c464c8d3e758d14825667f50531bd1b7d4328491d042f869b17602d3f587` |
| `examples/skins/claude/claude-skin-0.1.0.reaiapp` | 5169 | `eaa7ae62fc14850809c6c49a1bf5ffba60c76b7ff79672b218aff9663bbe3deb` |

agents-im 基线包摘要用于与根任务只修改测试的候选包比对；本报告不代替候选打包检查。

## 网站与线上版本

网站详细命令、退出码、产物摘要、生产公开版本字段见 website-regression.md（原报告引用 `website-regression.md`，本次不附原始回执） 与 website-regression.json（原报告引用 `website-regression.json`，本次不附原始回执）。公开 release 标记来自旧 `codex/open-platform-homepage` 分支、提交 `10500555284b80af93b0d502fe77bfa991fb7e97`，并带 `includes-uncommitted-source`；不能证明当前 main 已部署。

## 尚未验收

未做 Host 真机安装、真实 UI/服务流程、平台审核、签名、商店上架或生产部署。静态、单元、构建和 Mock Host 合同结果只支持上述范围。真实产品验收和部署差异仍需分别判断。

## 详细证据

- 汇总 JSON（原报告引用 `regression.json`，本次不附原始回执）
- shared tools JSON（原报告引用 `shared-regression.json`，本次不附原始回执）
- todo/titlebar JSON（原报告引用 `examples-regression.json`，本次不附原始回执）
- skins JSON（原报告引用 `skins-regression.json`，本次不附原始回执）
- agents-im 基线 JSON（原报告引用 `agents-im-baseline-regression.json`，本次不附原始回执）
- 网站报告（原报告引用 `website-regression.md`，本次不附原始回执）

本次仅归档报告正文，详细 JSON 回执、运行日志和构建产物未纳入。
