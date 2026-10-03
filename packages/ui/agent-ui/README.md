# @reai/agent-ui

**官方示例的内部 UI 素材，不是公开 SDK 的一部分。**

供 `plugins/examples/todo-app` 与 `plugins/official/agents-tasks` 复用的 agent 会话流 UI
组件（composer / conversation-stream / status-pill 等）。它没有稳定性承诺：
接口随官方示例的需要随时重构，不做版本化，也不会随插件平台文档
（`platform/docs/`）成文。

第三方插件不要依赖本包——照 examples 学习时，把它当作"示例自带的界面代码"
看待；你的插件应自带 UI 或复制所需片段。平台合同（Manifest / Bridge / 权限 /
限额）与本包无关，边界见 `tests/repo-contracts/agent-ui-source-contract.test.ts`：
Host 不直接依赖它，仅示例消费。
