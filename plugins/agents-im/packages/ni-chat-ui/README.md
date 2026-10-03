# @reai/ni-chat-ui

**官方示例的内部 UI 素材，不是公开 SDK 的一部分。**

供 `plugins/official/agents-im`（ni.chat 客户端）使用的 IM 界面层：会话/消息模型、
coordinator、视图与 mock-adapter。它没有稳定性承诺：接口随官方示例的需要
随时重构，不做版本化，也不会随插件平台文档（`platform/docs/`）成文。

第三方插件不要依赖本包——照 examples 学习时，把它当作"示例自带的界面代码"
看待。内部合同由 `plugins/official/agents-im/tests/ni-chat-ui.test.ts` 与
`plugins/official/agents-im/tests/ni-chat-scope-contract.test.ts` 锁定；Host 不直接依赖它，
仅 Agents IM 插件消费（见仓库级 `tests/repo-contracts/agent-ui-source-contract.test.ts`）。

后续把本示例接入真实 Agent 外脑、群聊、`@Agent` 或自动回复前，必须先阅读
`docs/agent-im-attention-and-reply-policy.md`（原 Board 仓库内 `docs/agent-im-attention-and-reply-policy.md`；未迁入）。
该规范定义“不回复也是一种回复”、每 Agent 独立判断、系统级冷静期、快慢脑、
发送前上下文新鲜度校验，以及 ni-chat 与外脑的职责边界；这些行为不能由 UI
组件或 ni-chat 传输层自行决定。

样式注意：包内颜色一律经 `var(--ni-accent)` 等间接层指回宿主注入的主题
token（写死十六进制仅作兜底），不要依赖下游样式表的同名覆盖。
