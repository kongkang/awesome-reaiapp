# 日程 Agent V1：App Platform 合同样例

这个样例同时承担两件事：

1. 验证 `@reai/app-sdk`、Mock Host 与 `reai-app` CLI 的 v1.1 合同；
2. 演示“先创建，再理解”的 AI 原生日程前端闭环。

V1 不连接真实云端。用户写下一句话后，客户端先持久化为 `queued` 事项；独立 Mock workflow 再异步返回结构化字段、建议或需要确认的状态。后续替换真实服务时，前端仍使用同一份接口和状态机。

界面按 V1.3「界面克制」做过一轮减法：

- **新增是按需铺开的专注层**，不是常驻输入框。点头部「新增一件事」（或硬件 New 键 /
  `new-task` Intent）后铺满 App 自己这一页，默认就在语音待命，一敲键盘转打字；
  属性（谁 / 地点 / 时间 / 步骤）默认只是一排图标，点哪个才展开哪一条。
- **月历只有一个尺寸**，是跳转控件不是第二个列表：点某一天，左侧日程流滚过去并闪一下，
  月历自身不展开、也不在下面再列一遍那天的事。
- **没有页内通知铃铛**。`user_notification` 的呈现权归 Host 的全局通知中心，App 只负责
  产生事件；App 自己这一侧的出声方式是「助理需要补信息时自己拉开来问」（aside：
  只开助理，不提升详情、不抢焦点）。

平台合同见 [插件开发规范](../../docs/plugin-development-v1.md) 与 [接口参考](../../docs/plugin-api-reference-v1.md)。本样例的产品行为以本页和本目录源码为准。

## 文件职责

```text
todo-app/
├── app.manifest.json       # Surface、三个 Command / Intent 与本地 Store 合同
├── preview.html            # 浏览器验收入口，不进入 App runtime
├── assets/icon.png         # 侧栏与 App Store 图标
├── src/app.ts              # activate / Surface / Command / Intent / 存储适配
├── src/todo-model.ts       # 同构事件树、循环 occurrence、建议与推送 reducer
├── src/state-coordinator.ts# 用户动作和异步推送共用的单写者持久化队列
├── src/mock-workflow.ts    # 可替换、可控时序的本地 Mock workflow
├── src/todo-view.ts        # 日程流、日历、新增专注层、详情与 Agent Drawer
├── src/todo.css            # Aura 视觉与 7:3 / 单列响应式布局
├── src/preview.ts          # 浏览器 Preview 的相对日期演示数据
├── tests/                  # 合同、模型和 DOM 行为测试
├── bun.lock                # 本插件独立依赖锁
├── package.json
└── tsconfig.json
```

## 运行

从本目录按独立插件运行，不依赖 Driver workspace：

```bash
bun install --frozen-lockfile --ignore-scripts
bun run dev           # http://127.0.0.1:4178/preview.html
bun run test          # 模型、DOM 与合同套件之外的插件本地测试
bun run typecheck
bun run validate      # Manifest 是否会被 Host 接受
bun run build         # 编译 App runtime ESM
bun run test:contract # 真实 App 代码接 Mock Host
bun run pack          # 产出可复现的 todo-1.1.1.reaiapp
```

本目录的 `file:` 依赖用于仓库内联调。上述命令检查本地源码与包，不自动验证仓库外 tarball 安装、真实 Host 安装、卸载或重装。这些验收需要单独完成；不能将 Mock Host 合同测试当作真实 Host 结果。

Preview 与 App runtime 共用模型、View 和 Mock workflow，只把 Host Bridge / KV 存储替换成内存适配层，因此适合做真实浏览器交互和响应式验收。它不会被 Manifest 设为 runtime 入口。

## Command

| Command | 意义 | 绑定方式 |
| --- | --- | --- |
| `com.example.todo.new` | 打开日程并铺开「新增一件事」专注层 | Host 或用户可绑定 |
| `com.example.todo.assistant.open` | 打开当前 App 的日程助理 | 用户在键位映射中决定物理键 |
| `com.example.todo.assistant.talk` | 打开日程助理并进入对话/聆听状态 | 用户在键位映射中决定物理键 |

App 不声明推荐物理键，也不重复实现 Host 已有的全局文字输入。两个助理 Command 只提供可绑定的接口和事件。

## 数据兼容

Store id 保持 `tasks`。运行时优先读取 V2 `state`，首次升级时兼容旧版 `items: { id, title, done }[]` 并转换为没有 `parentId` 的 root 节点。当前 Host 不支持 `data.migration`，所以迁移完全由 App 读取适配层完成。

`TodoStateCoordinator` 是唯一写入口。用户操作和 Mock 推送都以 reducer 入队，并在上一份已确认状态上串行计算；持久化失败不会污染确认态，也不会阻断后续更新。

## 首版边界

- Mock 只为验证前端状态和交互，不代表未来云端分析实现。
- 不调用真实麦克风、ASR、通知中心或远程推送；专注层的「正在听」是可见状态的 Mock。
- `user_notification` 目前只做幂等记账。Host 能力矩阵还没有「插件 → Host 全局通知」
  这条投递能力，落点缺失不构成在 App 里重开一个铃铛的理由——能力开放后接上即可，
  App 侧不需要改数据结构。
- 不发网络请求，也不要求额外权限。
- Agent Drawer 和详情 Drawer 都在唯一 `main` Surface 内实现，不创建第二个 Surface。
