# Agent 受控运行工具

macOS 上有两个受 Host 范围约束的执行工具，都不是插件直接执行接口：

| 工具 | 工作区 | 能做什么 |
|---|---|---|
| `run` | `mounted` + yolo | 固定的 `awk` / `wc` / `sort` / `diff`（本文主体） |
| `command` | `direct` / `app-private` + yolo | `/bin/sh -c` 运行一条命令：Seatbelt deny-default，只能读写当前工作范围与本次临时目录，只读放行系统运行库；`extraPaths` 里的范围外路径逐条由用户在 Host 主窗口单次确认；输入 `command` / `cwd` / `extraPaths[{path,write}]` / `timeoutMs`（默认 30 s，上限 300 s），输出真实 `stdout` / `stderr` / `exitCode` / `status` / `truncated` / `partialExecution`，各 64 KiB 上限；`descendantsStopped` 表示本次实际停止的额外后代数，不承诺所有后台进程都已退出 |

两者都要求 `local.terminal.exec@1` 平台批准 + 用户授权，并经公共 ToolScope 的 callId 去重、预算与在途授权复查。

### `command` 的文件范围与外部进程边界

`direct` 和 `app-private` 使用相同的授权范围规则。Host 在执行前与执行期间复核当前工作区和用户同意。目录范围改变、账号切换或权限撤销时，调用可以失败或取消；取消不能回滚已经完成的文件修改。

命令及其后代只能访问已经授权的文件范围和执行所需的只读运行依赖。该范围约束不等于隔离同一 macOS 用户下的所有原生进程，也不承诺停止所有后台后代。不要把它当作运行不可信软件的完整安全沙箱。

文本搜索只处理允许读取的 UTF-8 普通文件。超过 1 MiB 或被拒绝读取时，`grep` 返回 `truncated: true`；该结果不能作为完整搜索无匹配的证据。

以下是 `run` 的合同。当前实现只提供 **macOS 文件处理**：`awk`、`wc`、`sort`、`diff`。这是 Agent 工具 `run`，不是插件直接执行接口，也不支持 Shell、任意命令、Node、Python、安装依赖或项目构建。

## 权限与配置

同时满足以下条件才执行：

1. 插件拥有当前 Agent 服务的批准与用户同意。
2. 插件在 `requires.hostCapabilities` 和 `permissions` 中都声明 `local.terminal.exec@1`，平台对当前包批准，用户明确允许。运行前和运行中持续复查。
3. 工作区是用户经 `system.folder-pick@1` 选择并授权的 `mounted` 目录，模式为 `yolo`。
4. Agent 配置的 `tools` 含 `{ "ref": "run" }`；运行时返回的工具调用经公共 ToolScope 执行。

```json
{
  "schemaVersion": 2,
  "systemPrompt": "处理已授权目录中的文本文件。",
  "tools": [{ "ref": "read" }, { "ref": "write" }, { "ref": "run" }],
  "workspace": { "kind": "mounted", "path": "用户已通过面板授权的路径" },
  "memory": "session",
  "mode": "yolo"
}
```

`runtime` 可选 `pi`、`dsh`、`codex`，省略跟随全局默认。配置中的路径必须来自当前插件的目录授权记录；上面示意文字不能作为有效路径。Voice 不因本功能获得文件或执行权限。

## 模型传给 run 的参数

| 字段 | 约束 |
|---|---|
| `program` | `awk` / `wc` / `sort` / `diff` |
| `args` | 最多 64 项，每项最多 4096 字节，总计最多 16 KiB；参数白名单见下表 |
| `cwdRelative` | 镜像内相对目录，默认 `.`；拒绝绝对路径、`..`、符号链接及任意大小写 `.git` |
| `timeoutMs` | 1–30000 毫秒，默认 10000 |

| 程序 | 允许参数 |
|---|---|
| `awk` | `-f <镜像内脚本文件>`，后接至少一个镜像内输入文件；不支持内联脚本 |
| `wc` | 可选 `-c`、`-l`、`-m`、`-w`，然后一个或多个文件 |
| `sort` | 可选 `-r`、`-n`、`-u`，然后一个或多个文件；排序结果仅输出到 stdout |
| `diff` | 可选 `-u`、`-q`，然后恰好两个文件；退出码 1 表示发现差异，属于成功结果 |

示例：`{"program":"awk","args":["-f","summary.awk","input.csv"]}`。SDK 导出 `AgentRunArguments`、`AgentRunOutput` 作为上述模型工具参数/结果类型，没有新增插件直接 exec 方法。

## 执行与副作用

- 固定使用 `/usr/bin/` 下四个系统程序，经过 macOS `sandbox-exec` 的 deny-default Seatbelt 配置。沙箱不可用时立即失败，无无隔离回退。其他平台返回 `AGENT_EXEC_UNSUPPORTED`。
- 仅可读写当前镜像和本次独立临时目录；系统加载所需的库、固定程序与两个系统状态查询单独放行。任何大小写 `.git`、用户主目录、外部目录、网络、子进程均拒绝。
- 环境先清空，只加入固定空 `PATH`、独立 `HOME` / `TMPDIR`、`LC_ALL=C`；stdin 关闭，无法继承登录凭据或用户配置。
- stdout / stderr 分别最多 64 KiB，超限终止进程并返回失败；输出不自动写回文件。awk 脚本可写镜像内普通文件。
- 超时、取消、撤权或调用 future 被丢弃，均终止本工具拥有的进程组。公共 ToolScope 负责每回合 32 次工具预算、callId 去重、在途授权复查。
- 执行失败保留镜像内诊断改动；只有成功 Agent 回合才按现有 YOLO 镜像收尾和冲突检查写回用户目录。不会把 cwd 当作系统隔离。

## 结果与错误

成功返回 `program`、`exitCode`、`stdout`、`stderr`、`truncated:false`。非零退出码（diff 的 1 除外）返回 `ok:false`、`AGENT_EXEC_FAILED` 和同样的有界输出。

稳定错误包括 `AGENT_EXEC_UNSUPPORTED`、`AGENT_EXEC_YOLO_REQUIRED`、`AGENT_EXEC_ARGUMENTS_INVALID`、`AGENT_EXEC_PROGRAM_UNSUPPORTED`、`AGENT_EXEC_PATH_INVALID`、`AGENT_EXEC_SANDBOX_UNAVAILABLE`、`AGENT_EXEC_TIMEOUT`、`AGENT_EXEC_OUTPUT_LIMIT`、`AGENT_EXEC_CANCELLED`、`AGENT_EXEC_IO_FAILED`。没有公共服务执行上下文时为 `AGENT_EXEC_SCOPE_REQUIRED`；权限与任务取消仍可能由上层先返回公共 Agent 错误。

未来可由独立 Provider 增加其他程序及其沙箱策略，不能通过扩大 `args` 或允许任意 executable 绕过本合同。
