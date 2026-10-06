# awesome-reaiapp 历史仓库审计整理

核验窗口：2026-10-04 09:06:02—09:12:55 UTC；归档日期：2026-10-06。

来源为已保存总审计中的“专项附录 4：awesome-audit.md”。本页为公开范围内的提取整理，
不是从旧电脑复制的原文件；省略本机路径、任务身份、内部工具和原始机器回执。
以下均为当时快照，较晚的诊断见[稳定报告](stability-report.md)。

## 主线与合并结论

当时主仓与远端 main 均为 `09202cf4aaa07f7cbd05c2d6c453fbdcab4d5b16`。
四个迁移 PR 已合并，没有遗漏的已提交功能线。

| PR | source head | 合并提交 |
| --- | --- | --- |
| [#1](https://github.com/kongkang/awesome-reaiapp/pull/1) | `6f6f994da90099c91f25b3df1ec256d704269455` | `24b03ae7c8f07bceb77d9221b29d266560881867` |
| [#2](https://github.com/kongkang/awesome-reaiapp/pull/2) | `2c3e3c9d34ea3913ff10bb40b72023264dfcfc5b` | `7b4bd8ec0239a972fa67022fe7e67244f4baa085` |
| [#3](https://github.com/kongkang/awesome-reaiapp/pull/3) | `50c3b7b256ac795bcf373fdc97da612982f6d1a2` | `348103589945a85271206ff755bc0a101528bfe5` |
| [#4](https://github.com/kongkang/awesome-reaiapp/pull/4) | `a00da0cadcabf35271096b957867388fbfd7c67c` | `09202cf4aaa07f7cbd05c2d6c453fbdcab4d5b16` |

PR #2/#4 的 source 提交因 squash 可能在 `git cherry` 显示 `+`，但累计 patch-id 与合并提交
相同，source/merge tree 相同；这不是待整合补丁。旧树包含更早的文档与目录状态，不能整体
替换现主线。旧未提交 AGENTS、README、部署说明应保留，逐段核对有效内容，不自动回灌。

## CI 与时间顺序

- PR #4 source 的插件及网站 CI 历史回执合计 21/21 成功。
- 合并后 main 的 [Plugin toolchain](https://github.com/kongkang/awesome-reaiapp/actions/runs/37106638676)
  失败，唯一失败 job 为 agents-im 测试，其后类型检查、校验、构建和打包跳过。
- main 的 [Open website](https://github.com/kongkang/awesome-reaiapp/actions/runs/37106638650) 成功。
- 该审计窗口没有定位失败用例根因，也没有后续绿色 main 证据；原交接的 136/1 计数不构成
  计时根因证明。后续稳定报告补上复现、纯测试候选和候选 CI，不能把两轮状态混写成同一时刻。

## 公开部署回执的证明范围

当时 `open.reai.com/release.json` 显示 release `20261003T021627Z-d586e4116e7a`，
命名提交 `10500555284b80af93b0d502fe77bfa991fb7e97`，并明确
`workingTree: includes-uncommitted-source`。首页可访问，但命名 SHA 不能代表全部部署输入，
也不能单凭祖先关系推断漏了哪些功能。网站构建使用匿名 Catalog 动态快照，Git SHA 同样不覆盖全部输入。

当时网站 workflow 只构建和测试，没有部署步骤；因此源码已合并、CI 成功、公开站可访问、
当前 main 已部署是四个不同结论。该轮未部署、重启、改凭据，也未完成真实 Host 安装、
审核签名或商店上架验收。

## 后续建议

以核验后的 main 为后续实现基线，保护旧未提交内容；不重复 cherry-pick 已合并补丁，
不依据缺少锁文件推断没有并行使用者。功能修复、候选合并、部署及产品验收分别执行。
本次归档未重新执行历史测试或重查生产状态。
