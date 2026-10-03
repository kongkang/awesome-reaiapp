/**
 * doctor-model 的纯逻辑测试：进度事件 → 对话流折算。
 * 全零 IO，直接锁「StreamWork 可见 / 消息去重 / 状态药丸」这几条验收口径。
 */

import { describe, expect, test } from "bun:test";
import { describeLocalAgentError } from "@reai/app-sdk/v1";
import {
  createDoctorSnapshot,
  errorText,
  persistable,
  pushUserMessage,
  reduceEvent,
  restoreSnapshot,
  settleWithAnswer,
  toolLabel,
} from "../src/doctor-model";

function streamOf(snapshot: ReturnType<typeof createDoctorSnapshot>) {
  return snapshot.agent.stream;
}

test("turn.started 把助手置为忙", () => {
  const next = reduceEvent(createDoctorSnapshot(), { type: "turn.started" });
  expect(next.busy).toBe(true);
  expect(next.agent.status).toBe("busy");
});

test("turn.started 幂等:乐观置忙与 Host 事件各来一次,启动卡只有一张", () => {
  // onSend 先本地 reduce 一次 turn.started(即时反馈),Host 的同名事件随后到达
  // 再 reduce 一次。回归:曾因此一次提问并排出现两张「正在启动本地助手」。
  let snapshot = reduceEvent(pushUserMessage(createDoctorSnapshot(), "键盘没反应"), {
    type: "turn.started",
  });
  snapshot = reduceEvent(snapshot, { type: "turn.started" });
  const startupCards = streamOf(snapshot).filter(
    (item) => item.k === "work" && item.label.startsWith("正在启动"),
  );
  expect(startupCards).toHaveLength(1);
  expect(startupCards[0]).toMatchObject({ open: "open" });
  // 上一轮收尾后新一轮的启动卡照常出现(幂等不吞掉真正的第二次开场)。
  snapshot = reduceEvent(snapshot, { type: "message", text: "先看设备状态。" });
  snapshot = reduceEvent(snapshot, { type: "turn.settled", ok: true });
  snapshot = reduceEvent(pushUserMessage(snapshot, "换了个口还是没反应"), {
    type: "turn.started",
  });
  const secondRound = streamOf(snapshot).filter(
    (item) => item.k === "work" && item.label.startsWith("正在启动"),
  );
  expect(secondRound).toHaveLength(1);
});

test("tool.start → StreamWork 可见,tool.end 把它标记完成", () => {
  let snapshot = createDoctorSnapshot();
  snapshot = reduceEvent(snapshot, { type: "turn.started" });
  snapshot = reduceEvent(snapshot, { type: "tool.start", toolName: "device_status" });
  snapshot = reduceEvent(snapshot, { type: "tool.start", toolName: "permission_status" });
  snapshot = reduceEvent(snapshot, { type: "tool.end", toolName: "permission_status", isError: false });

  const works = streamOf(snapshot).filter((item) => item.k === "work");
  expect(works).toHaveLength(2);
  expect(works[1].label).toBe("查看权限状态");
  expect(works[1].open).toBeUndefined();
  expect(works[1].steps[0].d).toBe(1);
  // 未完结的那张卡保持打开;两张卡的 since 都是秒级(不是毫秒时间戳)
  expect(works[0].open).toBe("open");
  for (const work of works) {
    expect(work.since).toBeLessThan(1000 * 60 * 60 * 24);
  }
  expect(toolLabel("recent_logs")).toBe("翻最近日志");
  expect(toolLabel("未知工具")).toBe("未知工具");
});

test("message 事件进流且计数,settle 后状态回 idle", () => {
  let snapshot = reduceEvent(createDoctorSnapshot(), { type: "turn.started" });
  snapshot = reduceEvent(snapshot, { type: "message", text: "先换个 USB 口试试" });
  expect(snapshot.turnMessages).toBe(1);
  snapshot = reduceEvent(snapshot, { type: "turn.settled", ok: true });
  expect(snapshot.busy).toBe(false);
  expect(snapshot.agent.status).toBe("idle");
});

test("append 续文拼进同一条助手气泡,不拆成多段", () => {
  let snapshot = reduceEvent(createDoctorSnapshot(), { type: "turn.started" });
  snapshot = reduceEvent(snapshot, { type: "message", text: "回车键映射是指" });
  snapshot = reduceEvent(snapshot, { type: "message", text: "键盘按键到动作的对应关系。", append: true });
  const messages = streamOf(snapshot).filter((item) => item.k === "msg");
  expect(messages).toHaveLength(1);
  expect(messages[0].text).toBe("回车键映射是指键盘按键到动作的对应关系。");
  expect(snapshot.agent.last).toBe("回车键映射是指键盘按键到动作的对应关系。");
});

test("append 续文不并进用户气泡:找不到助手气泡时按新消息处理", () => {
  let snapshot = pushUserMessage(createDoctorSnapshot(), "键盘没反应");
  snapshot = reduceEvent(snapshot, { type: "message", text: "收到,先看设备状态。", append: true });
  const messages = streamOf(snapshot).filter((item) => item.k === "msg");
  expect(messages).toHaveLength(2);
  expect(messages[0].me).toBe(1);
  expect(messages[1].me).toBeUndefined();
  expect(messages[1].text).toBe("收到,先看设备状态。");
});

test("两条独立回答(无 append)仍是两条气泡", () => {
  let snapshot = reduceEvent(createDoctorSnapshot(), { type: "turn.started" });
  snapshot = reduceEvent(snapshot, { type: "message", text: "第一轮结论。" });
  snapshot = reduceEvent(snapshot, { type: "message", text: "补充说明。" });
  const messages = streamOf(snapshot).filter((item) => item.k === "msg");
  expect(messages).toHaveLength(2);
});

test("两条各自分块的回答互不粘连,各自拼成完整气泡", () => {
  let snapshot = reduceEvent(createDoctorSnapshot(), { type: "turn.started" });
  snapshot = reduceEvent(snapshot, { type: "message", text: "第一轮" });
  snapshot = reduceEvent(snapshot, { type: "message", text: "结论。", append: true });
  snapshot = reduceEvent(snapshot, { type: "message", text: "补充" });
  snapshot = reduceEvent(snapshot, { type: "message", text: "说明。", append: true });
  const messages = streamOf(snapshot).filter((item) => item.k === "msg");
  expect(messages).toHaveLength(2);
  expect(messages[0].text).toBe("第一轮结论。");
  expect(messages[1].text).toBe("补充说明。");
});

test("settleWithAnswer:丢块的半截回答被全文修正,不伪装成完整回答", () => {
  let snapshot = reduceEvent(createDoctorSnapshot(), { type: "turn.started" });
  // 只有第一块到达,后续续文块全部丢失。
  snapshot = reduceEvent(snapshot, { type: "message", text: "回车键映射是指" });
  const settled = settleWithAnswer(snapshot, "回车键映射是指键盘按键到动作的对应关系。");
  const messages = streamOf(settled).filter((item) => item.k === "msg");
  expect(messages).toHaveLength(1);
  expect(messages[0].text).toBe("回车键映射是指键盘按键到动作的对应关系。");
  expect(settled.agent.last).toBe("回车键映射是指键盘按键到动作的对应关系。");
});

test("用户提问进流且置忙", () => {
  let snapshot = pushUserMessage(createDoctorSnapshot(), "键盘没反应");
  snapshot = reduceEvent(snapshot, { type: "turn.started" });
  const messages = streamOf(snapshot).filter((item) => item.k === "msg");
  expect(messages).toHaveLength(1);
  expect(messages[0].me).toBe(1);
});

test("settleWithAnswer:事件没送来答案时补一条,送来过就不重复", () => {
  // 事件一条 message 都没到 → 用返回值补
  const empty = reduceEvent(createDoctorSnapshot(), { type: "turn.started" });
  const settled = settleWithAnswer(empty, "诊断完成");
  const messages = streamOf(settled).filter((item) => item.k === "msg");
  expect(messages).toHaveLength(1);
  expect(messages[0].text).toBe("诊断完成");

  // 事件已经送来过答案 → 不再补第二条
  const withMessage = reduceEvent(empty, { type: "message", text: "诊断完成" });
  const settled2 = settleWithAnswer(withMessage, "诊断完成");
  const messages2 = streamOf(settled2).filter((item) => item.k === "msg");
  expect(messages2).toHaveLength(1);
});

test("稳定错误码都有用户文案,未知码兜底", () => {
  expect(errorText(describeLocalAgentError("LOCAL_AGENT_NOT_LOGGED_IN").code)).toContain("登录");
  expect(errorText(describeLocalAgentError("LOCAL_AGENT_TIMEOUT").code)).toContain("超时");
  expect(errorText(describeLocalAgentError("WHATEVER_NEW_CODE").code)).toBe(errorText("unknown"));
});

test("答案为空时给一句人话而不是空气泡", () => {
  const started = reduceEvent(createDoctorSnapshot(), { type: "turn.started" });
  const settled = settleWithAnswer(started, "");
  const messages = streamOf(settled).filter((item) => item.k === "msg");
  expect(messages).toHaveLength(1);
  expect(messages[0].text).toContain("请重试");
});

test("持久化往返:切走再回来对话不丢", () => {
  let snapshot = createDoctorSnapshot();
  snapshot = pushUserMessage(snapshot, "键盘没反应");
  snapshot = reduceEvent(snapshot, { type: "turn.started" });
  snapshot = reduceEvent(snapshot, { type: "message", text: "先查设备状态" });
  snapshot = reduceEvent(snapshot, { type: "turn.settled", ok: true });

  const saved = persistable(snapshot);
  const restored = restoreSnapshot(saved);
  expect(streamOf(restored).map((item) => (item.k === "msg" ? item.text : item.k))).toEqual(
    streamOf(snapshot).map((item) => (item.k === "msg" ? item.text : item.k)),
  );
  expect(restored.busy).toBe(false);
});

test("恢复时在途提问补一条已被停止的说明", () => {
  let snapshot = createDoctorSnapshot();
  snapshot = pushUserMessage(snapshot, "键盘没反应");
  snapshot = reduceEvent(snapshot, { type: "turn.started" });
  const saved = persistable(snapshot);
  expect(saved.busy).toBe(true);

  const restored = restoreSnapshot(saved);
  const messages = streamOf(restored).filter((item) => item.k === "msg");
  expect(messages[messages.length - 1].text).toContain("被停止");
  expect(restored.busy).toBe(false);
  expect(restored.agent.status).toBe("idle");
});

test("启动引导卡:发送即出现,首个进展到达即撤", () => {
  let snapshot = reduceEvent(createDoctorSnapshot(), { type: "turn.started" });
  const works = streamOf(snapshot).filter((item) => item.k === "work");
  expect(works).toHaveLength(1);
  expect(works[0].label).toContain("正在启动");

  snapshot = reduceEvent(snapshot, { type: "tool.start", toolName: "device_status" });
  const after = streamOf(snapshot).filter((item) => item.k === "work");
  expect(after.map((item) => item.label)).toEqual(["查看设备状态"]);

  // 没有工具、直接来答案的路径也撤引导卡
  let snapshot2 = reduceEvent(createDoctorSnapshot(), { type: "turn.started" });
  snapshot2 = reduceEvent(snapshot2, { type: "message", text: "诊断完成" });
  const after2 = streamOf(snapshot2).filter((item) => item.k === "work");
  expect(after2).toHaveLength(0);
});

test("settle 时残留的启动引导卡被清掉", () => {
  let snapshot = reduceEvent(createDoctorSnapshot(), { type: "turn.started" });
  snapshot = reduceEvent(snapshot, { type: "turn.settled", ok: true });
  expect(streamOf(snapshot).filter((item) => item.k === "work")).toHaveLength(0);
});
