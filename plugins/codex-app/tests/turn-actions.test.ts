import { describe, expect, test } from "bun:test";

import { interruptActiveTurn, sendThreadMessage } from "../src/turn-actions";
import { emptyThreadPlaceholder } from "../src/thread-state";

const idleDetail = { thread: { status: { type: "idle" }, turns: [] } };
const activeDetail = {
  thread: {
    status: { type: "active" },
    turns: [{ id: "turn-live", status: "inProgress", items: [] }],
  },
};

function fakeClient(detail: unknown) {
  const calls: string[] = [];
  return {
    calls,
    client: {
      async resumeThread(id: string) { calls.push(`resume:${id}`); return {}; },
      async readThread(id: string) { calls.push(`read:${id}`); return detail; },
      async startTurn(options: { threadId: string; model?: string; effort?: string }) {
        calls.push(`start:${options.threadId}:${options.model}:${options.effort}`);
        return {};
      },
      async steerTurn(options: { threadId: string; expectedTurnId: string }) {
        calls.push(`steer:${options.threadId}:${options.expectedTurnId}`);
        return {};
      },
      async interruptTurn(threadId: string, turnId: string) {
        calls.push(`interrupt:${threadId}:${turnId}`);
      },
    },
  };
}

describe("Codex App 回合动作编排", () => {
  test("历史线程先 resume + read，再启动新 turn", async () => {
    const fake = fakeClient(idleDetail);
    const result = await sendThreadMessage(fake.client, {
      threadId: "thread-old",
      text: "继续",
      model: "gpt-real",
      effort: "high",
      loaded: false,
    });
    expect(result.kind).toBe("start");
    expect(fake.calls).toEqual([
      "resume:thread-old",
      "read:thread-old",
      "start:thread-old:gpt-real:high",
    ]);
  });

  test("活动 turn 使用 steer，不错误开启并发 turn", async () => {
    const fake = fakeClient(activeDetail);
    const result = await sendThreadMessage(fake.client, {
      threadId: "thread-live",
      text: "先检查测试",
      loaded: true,
      detail: activeDetail,
    });
    expect(result.kind).toBe("steer");
    expect(fake.calls).toEqual(["steer:thread-live:turn-live"]);
  });

  test("停止按钮只对真实 active turn 调用 interrupt", async () => {
    const fake = fakeClient(activeDetail);
    await interruptActiveTurn(fake.client, "thread-live", activeDetail);
    expect(fake.calls).toEqual(["interrupt:thread-live:turn-live"]);
    await expect(interruptActiveTurn(fake.client, "thread-idle", idleDetail)).rejects.toThrow(
      "没有正在运行的回合",
    );
  });

  test("界面重载后的活动线程先 resume + read，再 interrupt", async () => {
    const fake = fakeClient(activeDetail);
    await interruptActiveTurn(fake.client, "thread-live", activeDetail, false);
    expect(fake.calls).toEqual([
      "resume:thread-live",
      "read:thread-live",
      "interrupt:thread-live:turn-live",
    ]);
  });

  test("CODEXAPP-01：首 turn 前的 idle 占位仍走 startTurn（正常路径不变）", async () => {
    const fake = fakeClient(emptyThreadPlaceholder(false));
    const result = await sendThreadMessage(fake.client, {
      threadId: "thread-new",
      text: "第一次发送",
      loaded: true,
      detail: emptyThreadPlaceholder(false),
    });
    expect(result.kind).toBe("start");
    expect(fake.calls).toEqual(["start:thread-new:undefined:undefined"]);
  });

  test("CODEXAPP-01：首 turn 已接受、权威详情等待期内的 active 占位阻止并发开第二个 turn", async () => {
    const fake = fakeClient(emptyThreadPlaceholder(true));
    await expect(
      sendThreadMessage(fake.client, {
        threadId: "thread-new",
        text: "趁详情未就绪再发一条",
        loaded: true,
        detail: emptyThreadPlaceholder(true),
      }),
    ).rejects.toThrow("活动回合没有可用的 turn id");
    expect(fake.calls).toEqual([]);
  });
});
