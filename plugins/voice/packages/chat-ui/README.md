# @reai/chat-ui

**官方示例的内部 UI 素材，不是公开 SDK 的一部分。**

Agent 对话界面的三件通用组件——消息气泡（user / ai）、附件卡（文件 / 图片 /
语音气泡含波形与时长）、底部输入坞（`+` 附件钮 + 输入框 + 麦克风）。形态逐项对
`design/VoiceType_UI_Designs.html` 的 `#taskChat`（稿内 `cardHTML` / `renderMsg` /
`.chat-input-bar`），类名直接沿用稿的 `.chat-*`，方便 1:1 对账。

第一个消费方是 `examples/voice-app` 的命令详情页；以后各插件的 Agent 对话界面直接
import，不各写一份。它与 `@reai/agent-ui` / `@reai/ni-chat-ui` 同层：workspace 私有包、
零依赖、纯 DOM + 一张 CSS，随插件由 app-cli 打进 `.reaiapp`；没有稳定性承诺，
接口随官方示例的需要重构，不做版本化，也不随插件平台文档成文。Host 不依赖它。

## 使用约定

- 样式：`import "@reai/chat-ui/styles.css"`。颜色只认宿主注入的主题 token
  （`--accent` / `--accent-soft` / `--divider` / `--text-*` / `--card-bg`），写死的
  十六进制只是脱离宿主时的浅色兜底；accent 底上的白字按稿写死 `#fff`。
- 水平内边距由容器变量 `--chat-dock-x`（默认 32px）驱动，消费方在自己的容器 /
  断点里改变量，**不要**用同名类规则去覆盖包内规则——那会变成靠样式表加载顺序
  决胜负。
- 插件 WebView 的 CSP `style-src` 没有 `'unsafe-inline'`：本包不写任何内联 `style`
  属性，波形条高度用 CSSOM（`el.style.height = …`）赋值。
- 输入坞 Enter 发送（稿里没有发送钮）；`onAttach` 缺省时 `+` 钮渲染但 disabled
  并带说明——形态对稿，但不是一扇点了没反应的假门。
- 麦克风只是一颗按钮：它做什么（定向听写 / 起命令）由消费方决定。
