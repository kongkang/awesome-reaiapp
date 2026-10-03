# 接口调用与执行方法

## 当前生产合同

插件 0.2.0 / Host API 1.20。管理员在协作角色签发连接，得到 `endpoint / token / id`；它属于当前 App、当前账号和一个具体 Agent。端口动态分配，不能硬编码，Agent 必须和 App 在同一台电脑或同一虚拟机内。

请求：`POST <endpoint>`，`Content-Type: application/json`，`Authorization: Bearer <token>`。正文为 `{"method":"invoke","input":{...}}`。成功返回 `{"result":...}`；失败返回 `{"error":{"code":...,"message":...}}`。不发送浏览器 Origin，不把 token 放在 URL。一次请求最长受服务的 15 秒 deadline 限制，模型执行在请求之外完成。

| input.kind | 其他字段 | 返回内容 |
| --- | --- | --- |
| `skill` | 无 | 完整 Skill 与绑定身份 |
| `read` | 无 | 本角色 JSON、revision、writable、writeSchemas、幂等窗口 |
| `detail` | childId | 本范围子任务的完整报告和历史 |
| `act` | action | 当前投影、appliedRevision；分派成功时含子 Agent connection |
| `connection` | agentId | 编排者自己尚在等待或执行的子 Agent 连接 |

`read` 返回 `schema: code-worker.rules.v1`。编排者可见自己的大任务、子任务、相关 Agent 和待分配池的 ID/标题；Worker/Tester 只见当前任务与自己本轮子任务。全局 revision 可能因其他任务变化而前进，但不会泄漏其他任务正文。管理员的界面选择器不会切换实际 API 身份。

写入信封：

```json
{"kind":"act","action":{"requestId":"由客户端生成并持久保存的UUID","expectedRevision":42,"operation":"claim","payload":{"taskId":"从read返回值取得"}}}
```

不要将示例中的 revision 或 ID 当作真实数据。先读取当前投影，用该 revision 构造请求。重试不确定的请求时保留原 requestId、expectedRevision 和 payload；服务保留最近 128 条且不超过 24 小时的幂等回执。窗口外不能保证原结果重放，旧 expectedRevision 仍会冲突。收到 CONFLICT 后先查当前状态，确认旧请求是否已执行，再决定新请求；不能只换 ID 盲目重复派发。

## 角色动作

| 角色 | operation | payload 的全部字段 | 状态变化 |
| --- | --- | --- | --- |
| 编排者 | claim | taskId | 独占一个大任务，占一个编排者额度 |
| 编排者 | addChild | taskId,title,acceptance | 新子任务待分配，不占 Worker 额度 |
| 编排者 | closePlan | taskId | 完成拆分，至少存在一个子任务 |
| 编排者 | startWorker | childId | 创建本轮独立 Worker 连接，等待 begin |
| Worker | begin | childId | 确认即将执行并原子占 Worker 额度 |
| Worker | work | childId,result | 报告工作完成，自动归还 Worker 额度 |
| 编排者 | startTester | childId | Worker 交付后，创建不同 Tester 连接 |
| Tester | begin | childId | 确认即将测试并原子占 Tester 额度 |
| Tester | test | childId,verdict,evidence | pass 待合并 / fail 返工，两者都归还 Tester 额度 |
| 编排者 | merge | childId,mergeRef | 记录已完成的真实合并，全部子任务完成才结束大任务 |
| 当前执行者或自己的编排者 | cancel | childId,reason | 确认执行已停止后取消本轮，自动归还额度，保留原因并返工 |

字段必须精确匹配 Schema，未知字段拒绝。`result / evidence / mergeRef` 是 **JSON 编码的字符串**，总长不超过 4096 UTF-8 bytes，每个文本字段不超过 2048 bytes：

```json
{"summary":"实现了哪些行为","repository":"当前授权仓库的稳定标识","branch":"实际工作分支","commit":"实际40或64位小写commit SHA","verification":"实际自测命令、退出码与摘要"}
```

```json
{"testedCommit":"Worker交付的相同SHA","verification":"独立运行的命令、退出码、观察结果；失败时给复现"}
```

```json
{"repository":"与Worker相同的仓库标识","target":"实际合入的分支或PR","sourceCommit":"独立测试过的Worker SHA","mergedCommit":"实际合并后的commit SHA","verification":"git或PR回读得到的合并事实"}
```

这些是字段说明，不是可提交的假证据。使用真实提交，不编造 SHA、测试命令、模型结果或合并成功。证据来源在接口里标记为 `agent-report`：Host 核对身份、Schema、状态和提交关联，不独立访问你的 Git 仓库或替你执行合并。

正文归档在本插件的私有 Store，普通投影里的 `archive:<childId>:<digest>` 只是内部证据引用；需要正文时调用 `detail`。Agent 不能把这种内部引用作为自己的验证报告上传。

## 可直接使用的客户端

完整 ZIP 含 `scripts/client.py`，只依赖 Python 3 标准库。将管理员给出的连接参数保存成当前任务的私有 JSON 文件，文件权限设为 0600；不提交该文件。以下参数仅含本地文件名，不把 token 放进进程列表：

```sh
python3 scripts/client.py --connection connection.json read
python3 scripts/client.py --connection connection.json skill
python3 scripts/client.py --connection connection.json act claim --payload payload.json
python3 scripts/client.py --connection connection.json replay
```

payload.json 只包含该 operation 的 payload。客户端写入前保存请求日志；响应丢失后 `replay` 使用完全相同的 requestId/revision/payload。成功才删除待确认日志；明确核对失败请求后，可用 `resolve --record reconciliation.json` 保存人工或 Agent 的核对结论再清除待确认日志。记录必须包含原 requestId、当前 observedRevision、outcome（applied / not-applied）和 evidence，工具会复核当前 revision。不能自动捏造“未执行”。有未确认请求时拒绝开始另一写入，不会静默覆写。日志不含 token。

编排者读取任务、claim、拆分并 closePlan；根据真实并发决定分派多少 Worker。`startWorker` 返回的 connection 只交给对应子 Agent，不能让所有 Worker 复用编排者 token。Agent 启动命令、模型与仓库目录由当前工具和用户授权决定，不假设电脑一定安装了某个 CLI。

执行者可以用 runner 包住实际子 Agent 进程：

```sh
python3 scripts/client.py --connection worker.json run --report worker-result.json -- <已授权的Agent命令和参数>
```

执行命令必须保持前台，不能自行 daemonize 或脱离进程组；未知后台进程退出状态时保留额度并核对，不宣称已停止。runner 在启动前请求 begin，确认成功才启动进程。要求 Agent 将工作报告写入 report 文件：Worker 为 `{"result":{...工作报告...}}`，Tester 为 `{"verdict":"pass或fail","evidence":{...测试报告...}}`。进程成功退出且报告可读取后提交终态。进程非零退出或被取消时，确认退出后提交 cancel；不会仅因发出停止请求就宣称进程已结束。工具没有 CLI 时，由编排者按相同 begin → 执行 → work/test 顺序使用已授权的独立子 Agent 工具。

Tester 必须在 Worker 的精确 commit 上独立验证；测试不通过重新分派，不由 Worker 自批。合并前重新检查目标分支与冲突，在已授权的仓库中完成实际 Git/PR 操作、回读 commit，然后写 merge。接口仅记录操作结果，不替代 Git 操作。

Worker/Tester 的终态请求支持原信封重放；终态后新读取/写入被拒绝，由编排者查看最新状态。其连接在最近 128 条 / 24 小时回执窗口内仅用于恢复原调用，移出窗口后自动撤销；编排者取消等待中的执行者且其没有回执时可立即撤销。冷启动后也会按 Host 的无秘密连接列表清理，不依赖页面内存。

## 失败与恢复

- `CONFLICT`：重读，核对是否已应用，不盲目换 requestId。
- `QUOTA`：等待正在执行的角色完成后重试 begin；分派记录本身不占执行额度。
- `FORBIDDEN / GATEWAY_DENIED`：核对连接、当前账号和插件权限，不伪装管理员。
- `SCHEMA / STATE`：修正字段或顺序；旧 attempt 无权覆盖新 attempt。
- `STORAGE_PRESSURE`：保留所有原始工作，不清活动任务；由管理员导出和归档已完成任务后再继续。
- HTTP 超时、断连：结果不确定，先 replay / read。网络断开不表示 Worker 自动停止。
- App 退出或账号变化：重新连接原编排者，不创建替代编排者抢原锁；任务和证据仍在当前 profile。
- 子进程被强杀而来不及回报：核对该进程确实停止，再由负责它的编排者 cancel 并重新分派；没有“失联自动转移大任务”。

## 设计稿的离线示例

以下仅供明确要求的 HTML 设计演示，使用隔离的 `code-worker.preview.v1` 模型。它没有 HTTP 身份、真实进程或 Git 行为；不操作共享页面实例来伪装生产成果。

```js
const m = createCodeWorkerModel();
m.syncPlanned([{id:'demo', title:'演示需求', body:'演示验收目标', status:'planned'}]);
const admin = m.apply('admin', 'newOrchestrator', {}, m.project('admin').revision);
const owner = admin.agents[0].id;
const root = m.project(owner).claimable[0].id;
const send = (actor, op, payload) => m.apply(actor, op, payload, m.project(actor).revision);
send(owner, 'claim', {taskId:root});
send(owner, 'addChild', {taskId:root, title:'演示子任务', acceptance:'演示验收标准'});
send(owner, 'closePlan', {taskId:root});
const child = m.project(owner).children[0].id;
let state = send(owner, 'startWorker', {childId:child});
const worker = state.children[0].worker;
send(worker, 'work', {childId:child, result:'演示：实现及自测记录'});
state = send(owner, 'startTester', {childId:child});
const tester = state.children[0].tester;
send(tester, 'test', {childId:child, verdict:'pass', evidence:'演示：独立测试记录'});
const completed = send(owner, 'merge', {childId:child, mergeRef:'演示：不是实际 Git 提交'});
// completed.tasks[0].status === 'done'；只表示隔离模型的示例已完成。
```
