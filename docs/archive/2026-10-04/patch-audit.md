# awesome-reaiapp 迁移补丁与旧工作树核验

> 历史核验日期：2026-10-04；归档日期：2026-10-06。来源为已恢复的同名正式报告，以下为公开范围脱敏归档；保留当时结论和未验事项，不代表本次重新执行或当前状态。机器/任务身份、内部工具与未纳入附件的活链已移除。

核验日期：2026-10-04。范围：四个迁移 PR、当前 main，以及 `awesome-sync-reconcile` 的三份未提交文档。此报告只覆盖 Git 和文档补丁必要性；CI 修复和产品验收见后续稳定报告。

结论：四个迁移 PR 已完整合并，未发现遗漏补丁。旧 reconcile 文档的有效约束已由 main 及其关联文档保留，该范围需要的新补丁数为 **0**。保留旧工作树及三份 dirty 文件，不把历史文字整体合入 main。

## 当前基线和工作树

- 当前 `main` 和本地 `origin/main` 均为 `09202cf4aaa07f7cbd05c2d6c453fbdcab4d5b16`；原仓 `git status --porcelain=v1` 为空。
- 旧树 HEAD：`24b03ae7c8f07bceb77d9221b29d266560881867`，detached，位于 PR #1 合并后、PR #2–4 合并前。
- 旧树仅 `AGENTS.md`、`README.md`、`docs/deployment-status.md` 为 `.M`；相对自身 HEAD 是 64 行新增、12 行删除。没有 staged 或 unmerged 文件。
- 核验原仓与旧树各自 Git 目录及 common Git 目录：未见 `index.lock`、`HEAD.lock`、`config.lock`、`packed-refs.lock`、`MERGE_HEAD`、`rebase-apply`、`rebase-merge`、`CHERRY_PICK_HEAD`、`REVERT_HEAD`、`BISECT_START` 或 worktree `locked` 标记。此项只说明 Git 标记，不证明无人使用。

## PR 完整性

GitHub 只读 API 返回 PR #1–4 均为 `MERGED`。逐项使用已返回的 base/head/merge SHA 做本地比较：

1. `head^{tree}` 与 `merge^{tree}` 相同。
2. `git diff base head --binary` 与 `git diff base merge --binary` 字节相同。
3. 两组 diff 的 `git patch-id --stable` 相同。
4. merge SHA 均为当前 main 的祖先。

| 来源 PR | 合并时间 UTC | PR head | main 合并 SHA | 合并后 tree | 改动文件数 |
| --- | --- | --- | --- | --- | --- |
| [#1 发布目标说明](https://github.com/kongkang/awesome-reaiapp/pull/1) | 2026-10-02 12:57:04 | `6f6f994da90099c91f25b3df1ec256d704269455` | `24b03ae7c8f07bceb77d9221b29d266560881867` | `c0eb2e672999afd5e048b7632cb80a8f5748468f` | 3 |
| [#2 网站与 worktree 工作流](https://github.com/kongkang/awesome-reaiapp/pull/2) | 2026-10-03 06:59:44 | `2c3e3c9d34ea3913ff10bb40b72023264dfcfc5b` | `7b4bd8ec0239a972fa67022fe7e67244f4baa085` | `8ac8e3a55ee6296b9c959b9990321c5df73fb09e` | 102 |
| [#3 脱敏开发文档](https://github.com/kongkang/awesome-reaiapp/pull/3) | 2026-10-03 07:08:21 | `50c3b7b256ac795bcf373fdc97da612982f6d1a2` | `348103589945a85271206ff755bc0a101528bfe5` | `af9a4fc1bd31b54b73bc8c109f1eee01d666a581` | 30 |
| [#4 插件与独立工具](https://github.com/kongkang/awesome-reaiapp/pull/4) | 2026-10-03 07:31:37 | `a00da0cadcabf35271096b957867388fbfd7c67c` | `09202cf4aaa07f7cbd05c2d6c453fbdcab4d5b16` | `79546b473b8ddac83cf1e3ef1f4e5693457bcd6b` | 797 |

对应 stable patch-id：

| PR | PR head 与 main 合并共同 patch-id |
| --- | --- |
| #1 | `d20b03de1eb76f8b3ec020e2cd6195c44d603ea2` |
| #2 | `8a541226a2c78b8f72afa72c0b5c85f1e5f45437` |
| #3 | `c64c502187df8d2761d4bf29ce2a39a73605bc82` |
| #4 | `a0b348514c437f637ff7fd02b6ec4923a3b6801b` |

旧 PR 分支的 head 不一定因 squash 合并而成为 main 的祖先，不能据此认定遗漏。上述 tree、diff 与 patch-id 证明实际补丁一致。不要重新合入四个旧分支。

## 三份 dirty 文档分类

| 文件 | 仍有价值的内容及现有落点 | 不能整体回迁的内容 | 建议 |
| --- | --- | --- | --- |
| `AGENTS.md` | 设置页版本/关于入口、每次送审自动撰写版本介绍、同载荷复用、匿名 Catalog、中英文、品牌与部署边界均保留于 main `AGENTS.md`；具体 appId 路由与自动撰写细则见 `docs/plugin-settings-and-release-notes-v1.md:29`、`:44`；首版登录范围、素材与旧品牌废弃说明见 `open-website/README.md:3`、`:22`、`:28`、`:30` | 旧线上状态被写成当前事实，含已从公开版本移除的内部运维细节；整体覆盖会删除 main 的主工作区/worktree 及脱敏规定 | 保留原文件，零补丁 |
| `README.md` | 独立插件、稳定 appId、目录、冻结安装、审核门禁、源码公开与真实安装分开验收，以及许可待确认，已在 main README 和 `docs/source-delivery-2026-10-03.md` 保留 | “暂不公开推送”已被 #3/#4 替代；14 插件通过/Voice 拒绝、424 测试/22 文档等为旧时点验证，不能覆盖后来的精确交付记录；含内部运维和审查信息 | 保留原文件，零补丁 |
| `docs/deployment-status.md` | 目标分项核验、先核授权与回滚、历史记录不等于当前部署、用户测试时不抢锁、未知项不得编造，已在 main 同名文件、`AGENTS.md:35`、`docs/worktree-workflow.md` 与网站发布说明保留 | 以 PR #1 时的缺口描述目前“远端未含运行源码”“仅有 README”；未随 #2–4 更新；不能作为当前版本部署证明 | 保留原文件，零补丁 |

直接比较旧树整棵 tree 与 main 会显示后来合并的约 899 个文件缺失。这是旧 HEAD 的历史位置，不是 899 个待解决冲突，也不能用旧树的完整 diff 反向覆盖 main。

## 原文件保全证据

首次读取与结束复核时的状态、HEAD 和以下 SHA-256 一致：

| dirty 文件 | SHA-256 | 字节数 |
| --- | --- | --- |
| `AGENTS.md` | `5caead92c0a4f541a5a664889a257a5ae568d53fb6593b3456571aac06be9e57` | 4294 |
| `README.md` | `cb624a9419f5a3958ac86eaff6c4800feb213e16e82ddc16e7e36387d345cfbe` | 6488 |
| `docs/deployment-status.md` | `a4ed8fdfbce30a74f299e1c4f99b92533fccc35c13a38f18717f97680f2d576b` | 4654 |

## 验证范围与决策

已做：实时 Git 状态、worktree/操作标记、GitHub 合并状态、逐 PR tree 与补丁等价、三文档逐段必要性、已存在的公开规范落点、前后 dirty 摘要一致性。

未做：本分工没有运行插件/示例测试或构建、没有真实 Host 安装与交互验收、没有生产字节比对。main 合并后 CI failure 不能用历史 PR CI success 替代；这由根代理在独立新 worktree 修复并验证。本报告不认定 main 已达到产品稳定验收，也不认定旧网站产物是当前 main 的部署。

最小必要 PR：本 reconcile 范围无需 PR；若根代理确认当前 main 的 CI 缺陷，则只保留其负责的最小修复 Draft PR。

用户决策：本范围不需批准补丁或合并。旧 detached 工作树的未来归档/删除需要明确 owner 与用户授权，本次保留即可；main 合并、正式 tag 与生产部署均未执行。
