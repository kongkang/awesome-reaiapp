# awesome-reaiapp 稳定候选收口

核验日期：2026-10-04；归档日期：2026-10-06。

> 本文根据已保存的正式稳定报告脱敏整理。正文的 main、PR、CI、线上与验收状态均为 2026-10-04 历史快照，未作为 2026-10-06 现状重新验证。归档没有合并、部署或发布。

当前主线源码基线为 `09202cf4aaa07f7cbd05c2d6c453fbdcab4d5b16`。四个迁移 PR 已完整合并。必要的新补丁只有一处 agents-im 测试竞态修复，已提交并推送为 **[Draft PR #5](https://github.com/kongkang/awesome-reaiapp/pull/5)**，候选 SHA 为 `5affda2a9b6fa45ae716f5979cc24dda5d7330d2`。候选 Linux CI **20/20** 检查通过，PR 状态 OPEN、Draft、CLEAN。

这是经过源码、构建、合同和局部真实浏览器验证的 main 候选。现有证据尚不能证明一个包含全部插件、完成真实 Host 安装与业务验收的正式稳定发布 SHA。

## 基线、候选与线上

| 对象 | 精确身份 | 已证实范围 |
| --- | --- | --- |
| 当前 main 源码基线 | `09202cf4aaa07f7cbd05c2d6c453fbdcab4d5b16` | PR #1–4 已合并，主工作区干净，远端 main 一致；原 main 插件 CI 19/20 成功，唯一失败为 agents-im 测试竞态；网站 main CI 成功 |
| 最小修复候选 | `5affda2a9b6fa45ae716f5979cc24dda5d7330d2` | main 上增加一个测试文件的修复；远端分支 `codex/awesome-main-ci-stability-20261004` 同 SHA；Draft #5 的插件 CI 20/20 成功 |
| 历史绿色 main 祖先 | `348103589945a85271206ff755bc0a101528bfe5` | 当时网站流水线成功；发生于插件源码迁入前，不能作为完整插件稳定基线或回退目标 |
| 网站线上 | release `20261003T021627Z-d586e4116e7a`；命名 commit `10500555284b80af93b0d502fe77bfa991fb7e97` | 公开 release.json HTTP 200；分支 `codex/open-platform-homepage`，明确 `includes-uncommitted-source`；不能认定对应当前 main 或候选 |

当前 main 与线上命名 commit 相差五个提交，但线上含未提交源码，命名 commit 不能代表完整部署输入。未做全线上字节比对，也没有执行部署。网站构建还使用匿名 Catalog 的动态快照，单独的 Git SHA 不能代表全部网站输入。

## 剩余补丁分类

| 范围 | 当前结论 | 处理 |
| --- | --- | --- |
| 迁移 PR [#1](https://github.com/kongkang/awesome-reaiapp/pull/1)、[#2](https://github.com/kongkang/awesome-reaiapp/pull/2)、[#3](https://github.com/kongkang/awesome-reaiapp/pull/3)、[#4](https://github.com/kongkang/awesome-reaiapp/pull/4) | 全部 MERGED；逐 PR head 与对应 main 合并提交的 tree、binary diff、stable patch-id 相同；合并提交均为当前 main 祖先 | 无遗漏，无需重新合入旧分支 |
| main agents-im CI | 首次状态分组断言因真实时钟短 TTL 竞态失败 | 已修复于 Draft #5 |

历史未提交文档保持原样；有效规则已由当时 main 与公开规范吸收，不整体回迁旧文件。

## main CI 失败与最小修复

[原 main Plugin toolchain](https://github.com/kongkang/awesome-reaiapp/actions/runs/37106638676) 唯一失败任务是 [Verify plugin agents-im](https://github.com/kongkang/awesome-reaiapp/actions/runs/37106638676/job/111156456417)，失败在 `tests/ni-chat-ui.test.ts:846` 的首次组头断言。期望「工作中 · 1 / 全部 · 5」，实际「全部 · 6」。

测试在异步挂载前创建 `Date.now() + 60` 的到期时间。视图先等待快照，随后才按协议时钟分类；慢于 60ms 的挂载正确判定状态已过期，却使测试的初始假设失效。延迟快照 120ms 的本地复现产生相同断言失败。同 main 在快速本地运行 137 项测试通过，因此原 PR 绿色不能替代合并后 main 的失败诊断。

修复仅调整 `plugins/agents-im/tests/ni-chat-ui.test.ts`：固定并显式推进协议时钟，捕获实际注册的 timer 回调，覆盖 0/120ms 快照延迟；清理测试核对清除同一 handle，并执行迟到回调检查 DOM 仍为空。所有 timer 包装和视图在 finally 清理。没有改变插件源码、TTL、API、版本、依赖、审核策略或包内容。

临时移除到期重绘与 timer 清理的两种变异均被新测试检出，各产生两项预期失败；生产文件已逐字节恢复。通过差异复核；诊断采用过滤后的失败信息，本文未归档原始 CI 日志。

## 验证结果

| 范围 | 本轮实际执行 | 结果 |
| --- | --- | --- |
| agents-im 候选 | 冻结安装且禁安装脚本；test/typecheck/validate/build/contract-test/pack | 139 tests、662 assertions，0 fail；所有命令 exit 0 |
| agents-im 打包 | main 基线与候选；候选提交后再 build/pack | 均为 189994 bytes；SHA-256 `b3defb21156a828df41eeae92e6c6ac1bdfb510cf246ed2b245d1d8df0894346` |
| 共享工具 | 冻结安装、424 tests、typecheck，以及 install-probe 校验/构建/Mock 合同 | 全部 exit 0 |
| Todo 示例 | 冻结安装、45 tests、类型/校验/构建/Mock 合同/打包 | 全部 exit 0 |
| Titlebar 示例 | 冻结安装、6 tests、类型/校验/构建/Mock 合同/打包，locale 合同 | 全部 exit 0 |
| Codex、Claude skins | 各 1 test，既有类型/校验/构建/合同脚本/打包 | 全部 exit 0；合同脚本是校验及重复 token/identity 单测，不是 Host 安装合同 |
| 文档与开放网站 | 冻结安装、两站构建、网站 8 tests | 全部 exit 0；保留已有 VitePress >500kB chunk 提示 |
| 候选 GitHub CI | [Plugin toolchain run 37193767948](https://github.com/kongkang/awesome-reaiapp/actions/runs/37193767948)，head `5affda2a…` | 20/20 jobs success；14 插件、4 示例、共享工具、Voice 拒绝检查 |
| PR 审查状态 | diff 单文件；issue comments/reviews/inline comments 三种表面 | 历史查询均无反馈，无未处理意见 |

候选的 Voice CI 证明无审核输入时 validate/build/pack 按预期拒绝四项受控能力，没有绕过审核，也不代表 Voice 已完成新平台批准、签名或安装。其余正常插件 CI 完成各自标准构建链。此次测试文件变更未触发网站 CI；网站内容与已成功的 main 网站 tree 相同，且本轮本地网站构建/测试通过。

## 真实浏览器局部验收

在独立 loopback 预览和合成数据上操作，未运行真实 Host、连接用户账户或调用真实业务服务：

- agents-im 使用当前生产视图、Mock adapter、120ms 异步快照和真实 Date.now/native timer。初始「工作中 · 1 / 全部 · 5」，无额外状态事件或点击，自动变为「全部 · 6」。卸载操作后会话 DOM 为空，未出现 console error/warn。
- Todo 使用既有 preview：打开详情，创建合成步骤，完成步骤并观察提示，再恢复未完成状态、关闭详情。预览刷新后合成标记为 0，未出现 console error/warn。
- 临时预览标签已关闭，两台本任务 loopback 服务已停止。没有改动源码或持久化用户数据。

原报告引用了 `agents-im-native-expiry.png` 截图；本次以讨论文档正文为归档范围，图片未纳入，原图片链接已移除。

以上仍是 Mock 传输或 workflow 的浏览器预览，不证明真实 Broker、云端业务、Host bridge、原生标题栏、安装/授权/卸载、平台审核、签名或上架成功。Titlebar 真实 hover、通知互斥、点击投递，两个 skins 的真实 Host 明暗主题，以及全部插件的完整产品验收尚未覆盖。

## 原报告附件与后续工作

原报告曾引用 `patch-audit.md`、`test-review.md`、`spec-review.md`、`regression.md`、
两张浏览器截图及若干 JSON 回执。四份正式原稿现已恢复，公开范围归档见[补丁核对](patch-audit.md)、[测试复核](test-review.md)、
[规范核对](spec-review.md)和[回归记录](regression.md)。两张图片未纳入本次正文归档，
不保留图片活链；原始日志、临时脚本及测试 fixture 未纳入。

2026-10-04 的后续建议是：对 Draft #5 单独决定是否合并；若合并，验证精确合并 SHA 的
main CI，然后独立完成真实 Host 的插件和示例验收。网站部署、正式发布、审核与签名
须绑定实际输入分别验证，不能由本报告或 CI 绿色推定已经完成。

本次 2026-10-06 仅归档历史讨论和规范，不执行上述功能合并或发布。
