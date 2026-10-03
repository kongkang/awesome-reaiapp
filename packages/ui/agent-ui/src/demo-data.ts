import type { AgentOrGroup, AgentTask, StreamAsk, StreamItem } from "./model";

const DEMO_AGENTS: AgentOrGroup[] = [
  /* 外脑：这台键盘上的第一个 agent，也是唯一置顶的那个。 */
  {
    id: 'wainao', kind: 'agent', ava: '🧠', name: '外脑', tag: '常驻', pinned: 1,
    role: '拿不准找谁的时候，找它',
    status: 'idle', unread: 0, time: '',
    last: '要加新的 agent，或者一件事不知道派给谁，直接跟我说。',
    stream: [
      { k: 'day', t: '今天' },
      { k: 'msg', text: '我是这台键盘上的第一个 agent。三件事可以找我：<br><br>· <b>想加一个新 agent</b> —— 跟我说要它干什么，我来建，不用你填表<br>· <b>一件事不知道该派给谁</b> —— 说给我，我找合适的接手<br>· <b>在别处 @ 了却没指名</b> —— 默认就是我', ts: '常驻' },
    ],
  },
  {
    id: 'cc', kind: 'agent', ava: '◆', name: 'Claude Code', tag: '本机', tagLocal: true, role: '/workspace/demo-project',
    status: 'wait', unread: 1, time: '刚刚', last: '发布说明要不要把固件那条也写进来？',
    stream: [
      { k: 'day', t: '7 月 9 日' },
      { k: 'msg', me: 1, text: '先把这个仓库过一遍，跟我说说它大概是个什么结构', ts: '09:20' },
      { k: 'msg', text: '看完了。Rust + Tauri 的桌面 App，前端 Vue，另外还挂着官网、浏览器扩展和三个子模块。要我从哪块开始？', ts: '09:26' },
      { k: 'msg', me: 1, text: '先不急，我就是想知道有多大', ts: '09:27' },
      { k: 'anchor', icon: '🗺', title: '通读仓库结构', meta: '7 月 9 日 · 42 个目录', st: 'done' },
      { k: 'day', t: '7 月 14 日' },
      { k: 'msg', me: 1, text: 'HID 那条线断连之后不会自己重连，能修吗', ts: '11:05' },
      { k: 'msg', text: '能。热插拔那段现在只认「插上」不认「拔掉」，补一个重扫就行。', ts: '11:08' },
      { k: 'msg', me: 1, text: '那就改', ts: '11:09' },
      { k: 'anchor', icon: '🔌', title: 'HID 断连后自动重扫', meta: '7 月 14 日 · <span class="dif"><b>+56</b><i>−12</i></span>', st: 'done' },
      { k: 'msg', text: '改好了，拔掉再插回去会自己接上。', ts: '11:41' },
      { k: 'day', t: '7 月 21 日' },
      { k: 'msg', me: 1, text: '帮我看看拨杆切模式在 Windows 上为什么不生效', ts: '10:12' },
      { k: 'msg', text: '看了一下，Windows 那边 send_key 还在用旧 API，Shift+Tab 根本发不出去。要换成 SendInput。', ts: '10:14' },
      { k: 'anchor', icon: '🔧', title: '修复 Windows 拨杆注入', meta: '7 月 21 日 · <span class="dif"><b>+128</b><i>−34</i></span>', st: 'done', dir: '~/Projects/example-app' },
      { k: 'day', t: '7 月 24 日' },
      { k: 'msg', me: 1, text: '上次那个修好了。再加个开关，能把 YOLO 那一档关掉', ts: '16:30' },
      { k: 'msg', text: '加好了，默认关闭。只有你用跳过权限的方式启动 Claude Code 时才需要打开——否则 Shift+Tab 环里没有 bypass 这一档，步数会算错。', ts: '16:33' },
      { k: 'anchor', icon: '⚙️', title: 'yolo_cycle_enabled 开关', meta: '7 月 24 日 · <span class="dif"><b>+64</b><i>−9</i></span>', st: 'done', dir: '~/Projects/example-app' },
      { k: 'day', t: '今天' },
      { k: 'msg', me: 1, text: '那个开关默认值是什么来着？我记得我们讨论过', ts: '14:02' },
      { k: 'msg', text: '默认 false。这是 7 月 24 号你自己定的——因为大多数人的 Shift+Tab 环里根本没有 bypassPermissions 这一档。', ts: '14:02' },
      { k: 'msg', me: 1, text: '对，想起来了。帮我把这个版本的发布说明写一下', ts: '14:05' },
      { k: 'anchor', icon: '📝', title: '写这版发布说明', meta: '今天 14:05 开始', st: 'run', since: 1560, dir: '~/Projects/example-app' },
      { k: 'ask', text: '这个版本一共 3 处改动，其中「禁用 DFU 长按」是固件侧的（v1.55）。发布说明要不要把固件那条也写进来？', brief: '发布说明要不要写固件那条', opts: ['一起写', '只写 App', '拆成两篇'], open: '或者说说你想怎么写' },
    ],
  },

  {
    id: 'mail', kind: 'agent', ava: '✉️', name: '邮箱助手', tag: '云端', role: 'assistant@example.com',
    status: 'wait', unread: 2, time: '20:01', last: '我起草了回复，要发吗？',
    stream: [
      { k: 'day', t: '今天' },
      { k: 'msg', text: '今天收到 3 封新邮件，其中 1 封是 示例合作方 的合作回复，他们问能不能下周约个会。', ts: '19:58' },
      { k: 'anchor', icon: '📬', title: '收件箱整理', meta: '今天 19:58 · 3 封 · 1 封需要回复', st: 'done' },
      { k: 'msg', me: 1, text: '帮我回一下，说下周三下午都可以', ts: '20:00' },
      { k: 'msg', text: '草稿写好了：', ts: '20:01', card: { type: 'file', icon: '📄', name: 'Re_Example.eml', meta: '邮件草稿 · 0.8 KB' } },
      { k: 'ask', text: '收件人是 partner@example.com，抄送了合作邮箱。确认后我就发出去——发出去就撤不回来了。', brief: '这封回复要不要发出去', opts: ['确认发送', '我先看看'], no: '我先看看', open: '或者说说哪里要改' },
    ],
  },

  {
    id: 'release', kind: 'group', name: 'AI Board 01 发布小组', tag: '群聊', status: 'busy', time: '2 分钟前',
    last: '<b>[有人@我]</b> Codex：那两个 warning 我改完提交',
    members: [
      { ava: '◆', name: 'Claude Code', role: '编码 · 本机', st: 'idle', id: 'cc' },
      { ava: '⬡', name: 'Codex', role: '审查 · 本机', st: 'busy', id: 'codex' },
      { ava: '🎛', name: '固件助手', role: 'BS20-N1200', st: 'off', id: 'fw' },
      { ava: 'K', name: '你', role: '群主', st: 'idle', id: 'me', self: 1 },
    ],
    stream: [
      { k: 'day', t: '今天' },
      { k: 'msg', who: 'Claude Code', ava: '◆', text: '双平台打包跑完了，macOS 和 Windows 都过。', ts: '15:40' },
      { k: 'msg', who: '固件助手', ava: '🎛', text: '固件这边 v1.55 已经打好，DFU 长按禁用了。', ts: '15:41' },
      { k: 'msg', who: 'Codex', ava: '⬡', text: '我这边 lint 有 2 个 warning，都在 cc_link 里，不影响发布但看着难受。', ts: '15:44' },
      { k: 'msg', me: 1, text: '@{codex} 那两个顺手修了吧，别留到下个版本', ts: '15:46' },
      { k: 'msg', who: 'Codex', ava: '⬡', text: '@{me} 好，改完提交。', ts: '15:46' },
      { k: 'msg', me: 1, text: '@{cc} 打包先别动，等 @{codex} 改完 warning 一起出', ts: '15:47' },
      { k: 'work', label: 'Codex 正在修改', since: 134, steps: [
        { t: '读了 cc_link/mod.rs 与 mode.rs', d: 1 },
        { t: '改掉第一个 warning：未使用的导入', d: 1 },
        { t: '改掉第二个 warning：多余的 clone', d: 1 },
        { t: '正在跑 clippy 复查' },
      ] },
    ],
  },

  {
    id: 'codex', kind: 'agent', ava: '⬡', name: 'Codex', tag: '本机', tagLocal: true, role: '/workspace/demo-project',
    status: 'busy', time: '刚刚', last: '在看 cc_link 那部分',
    stream: [
      { k: 'day', t: '今天' },
      { k: 'msg', me: 1, text: '帮我审一下这次的改动，重点看拨杆那块', ts: '15:20' },
      { k: 'msg', text: '在看了。先说结论：SendInput 那段没问题，但模式环的边界处理我有疑问，等我读完 effective_mode_cycle 再说。', ts: '15:22' },
      { k: 'anchor', icon: '🌐', title: '官网价格表改版审查', meta: '今天 13:20 · 提了 4 条', st: 'done', dir: '~/Projects/landing' },
      { k: 'work', label: '代码审查', since: 412, steps: [
        { t: '扫了这次改动涉及的 7 个文件', d: 1 },
        { t: 'SendInput 那段：没问题', d: 1 },
        { t: '正在读 effective_mode_cycle 的边界' },
      ] },
    ],
  },

  {
    id: 'research', kind: 'agent', ava: '🔍', name: '竞品调研', tag: '云端', role: '研究型 · 长任务',
    status: 'idle', time: '昨天', last: '结论：Deepgram 适合实时，AssemblyAI 中文最好',
    stream: [
      { k: 'day', t: '昨天' },
      { k: 'msg', me: 1, text: '分析 3 个主要竞品的语音输入方案', ts: '15:01' },
      { k: 'msg', text: '收到，我按准确率、延迟、语种、价格四个维度拉表。', ts: '15:01' },
      { k: 'anchor', icon: '📊', title: '竞品分析 — 语音输入', meta: '7 月 27 日 · 2 个产物', st: 'done' },
      { k: 'msg', text: '做完了：\n\n• Whisper：开源，准确率高，延迟约 2 秒\n• Deepgram：实时，<300ms，$0.0043/分钟\n• AssemblyAI：中文最好，$0.006/分钟\n\n建议实时场景用 Deepgram，中文场景用 AssemblyAI。', ts: '15:24', card: { type: 'file', icon: '📊', name: 'Competitive_Analysis.xlsx', meta: '表格 · 24 KB' } },
    ],
  },

  {
    id: 'fw', kind: 'agent', ava: '🎛', name: '固件助手', role: 'BS20-N1200 · 未连接',
    status: 'off', time: '7 月 26 日', last: 'v1.55 已打包，DFU 长按已禁用',
    stream: [
      { k: 'day', t: '7 月 26 日' },
      { k: 'msg', me: 1, text: '把 DFU 长按关掉，太容易误触了', ts: '11:02' },
      { k: 'msg', text: '改好了，v1.55 打包完成。刷完记得重新配对一次。', ts: '11:40' },
      { k: 'anchor', icon: '📦', title: '固件 v1.55', meta: '7 月 26 日 · 禁用 DFU 长按', st: 'done' },
    ],
  },

  {
    id: 'daily', kind: 'group', name: '每日简报', tag: '群聊', status: 'idle', time: '早上 8:00', muted: true,
    last: '播客：今天的音频生成好了',
    members: [
      { ava: '📰', name: '简报官', role: '汇总 · 每天 7:50', st: 'idle', id: 'brief' },
      { ava: '🎧', name: '播客', role: '配音 · 每天 8:00', st: 'idle', id: 'pod' },
      { ava: 'K', name: '你', role: '群主', st: 'idle', id: 'me', self: 1 },
    ],
    stream: [
      { k: 'day', t: '今天' },
      { k: 'msg', who: '简报官', ava: '📰', text: '今天 6 条来源，主要是硬件供应链和两条竞品动态。', ts: '7:52' },
      { k: 'msg', who: '播客', ava: '🎧', text: '音频生成好了，12 分钟。', ts: '8:00', card: { type: 'audio', dur: '12:04' } },
    ],
  },
];



export function createDemoAgentState(): AgentOrGroup[] {
  return structuredClone(DEMO_AGENTS);
}

export function deriveTasks(agents: AgentOrGroup[]): AgentTask[] {
  const tasks: AgentTask[] = [];
  for (const agent of agents) {
    agent.stream.forEach((item, anchorIndex) => {
      if (item.k !== "anchor" || !item.dir) return;
      tasks.push({
        id: `${agent.id}:${anchorIndex}`,
        title: item.title,
        agentId: agent.id,
        agentName: agent.name,
        agentAva: agent.ava ?? agent.name.slice(0, 1),
        anchor: item,
        anchorIndex,
        conversation: agent.stream,
      });
    });
  }
  return tasks;
}

export function conversationSliceForTask(task: AgentTask): StreamItem[] {
  const items = task.conversation;
  const index = items.indexOf(task.anchor);
  if (index < 0) return [];
  if (task.anchor.st === "run") {
    let end = index + 1;
    while (end < items.length && items[end]?.k !== "anchor") end += 1;
    return items.slice(index, end);
  }
  let start = index;
  while (start > 0) {
    const previous = items[start - 1];
    if (previous?.k === "anchor" || previous?.k === "day") break;
    start -= 1;
  }
  return items.slice(start, index + 1);
}

export function findPendingPrompt(items: StreamItem[]): StreamAsk | undefined {
  return items.find((item): item is StreamAsk => item.k === "ask" && !item.answered);
}
