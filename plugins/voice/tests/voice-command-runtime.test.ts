import { describe, expect, test } from "bun:test";

import {
  initialSnapshot,
  isCommandGateFailureCode,
  mapRawEvent,
  projectTask,
  STAGE_BY_BLOCK,
  type MapContext,
  type RawStreamEvent,
} from "../src/voice-command-runtime";
import { VOICE_COMMAND_CATALOG } from "../src/voice-ai-contract";

function ctx(overrides: Partial<MapContext> = {}): MapContext {
  let sequence = 0;
  return {
    runId: "run-1",
    commandId: "voice.command.translate",
    nextSequence: () => ++sequence,
    elapsedMs: () => 1234,
    ...overrides,
  };
}

function raw(event: string, data: unknown): RawStreamEvent {
  return { event, data: typeof data === "string" ? data : JSON.stringify(data) };
}

describe("原始事件 → 合同事件", () => {
  test("run_start 起头", () => {
    const mapped = mapRawEvent(raw("run_start", { runId: "run-1" }), ctx());
    expect(mapped).toMatchObject({ type: "run.started", commandId: "voice.command.translate" });
  });

  test("已知 blockId 产出对应阶段", () => {
    const mapped = mapRawEvent(raw("block_start", { blockId: "translate" }), ctx());
    expect(mapped).toMatchObject({ type: "stage.started", stage: "text.translating" });
  });

  test("未知 blockId 安静跳过，不伪造阶段", () => {
    // 端点重命名过 outputs、或工作流加了我们不认识的 block —— 都不该崩，
    // 更不该编一个看起来合理的阶段出来。
    expect(mapRawEvent(raw("block_start", { blockId: "whatever" }), ctx())).toBeNull();
  });

  test("block_chunk 读的是 chunk 字段而不是 delta", () => {
    // 后端这个字段叫 chunk。照着 delta 取会永远拿到空串，表现是"结果始终为空"。
    const mapped = mapRawEvent(raw("block_chunk", { blockId: "answer", chunk: "你好" }), ctx());
    expect(mapped).toMatchObject({ type: "output.delta", delta: "你好" });
    expect(mapRawEvent(raw("block_chunk", { blockId: "answer", delta: "你好" }), ctx())).toBeNull();
  });

  test("终局事件各自映射", () => {
    expect(mapRawEvent(raw("run_complete", {}), ctx())).toMatchObject({ type: "run.completed" });
    expect(mapRawEvent(raw("run_error", { message: "余额不足" }), ctx())).toMatchObject({
      type: "run.failed",
      error: { message: "余额不足" },
    });
  });

  test("畸形 data 不让运行崩掉", () => {
    // 一条坏事件不该毁掉整次运行。
    expect(mapRawEvent(raw("run_complete", "{ 不是 JSON"), ctx())).toMatchObject({
      type: "run.completed",
    });
    expect(mapRawEvent(raw("block_start", "{ 不是 JSON"), ctx())).toBeNull();
  });

  test("被后端屏蔽的事件类型不会出现在映射表里", () => {
    // tool_start / tool_result / wait_for_input / block_skipped 在 Release 通道被硬屏蔽，
    // 为它们写映射就是死代码。
    for (const blocked of ["tool_start", "tool_result", "wait_for_input", "block_skipped"]) {
      expect(mapRawEvent(raw(blocked, { blockId: "agent" }), ctx())).toBeNull();
    }
    expect(Object.values(STAGE_BY_BLOCK)).not.toContain("tool.web_search");
    expect(Object.values(STAGE_BY_BLOCK)).not.toContain("tool.knowledge_search");
  });

  test("sequence 单调递增，供客户端丢弃乱序", () => {
    const shared = ctx();
    const first = mapRawEvent(raw("run_start", {}), shared);
    const second = mapRawEvent(raw("run_complete", {}), shared);
    expect(first?.sequence).toBe(1);
    expect(second?.sequence).toBe(2);
  });
});

describe("合同事件 → 任务快照", () => {
  const base = () =>
    initialSnapshot({
      taskId: "task-1",
      title: "帮我查下天气",
      startedAt: 1_700_000_000_000,
      planSteps: ["整理问题", "交给 Agent"],
    });

  test("阶段推进更新文案与步数", () => {
    const event = mapRawEvent(raw("block_start", { blockId: "promptify" }), ctx());
    const next = projectTask(base(), event!, VOICE_COMMAND_CATALOG.agent);
    expect(next.stageLabel).toBe("正在整理问题");
    expect(next.stepIndex).toBe(0);
  });

  test("认不出的阶段不挪动进度", () => {
    // 宁可看起来"卡住"，也不要凭空往前挪一格——那会让用户以为某步做完了。
    const start = base();
    const event = mapRawEvent(raw("block_start", { blockId: "polish" }), ctx());
    const next = projectTask({ ...start, stepIndex: 1 }, event!, VOICE_COMMAND_CATALOG.agent);
    expect(next.stepIndex).toBe(1);
  });

  test("跑完留未读标记，等用户真的看过", () => {
    // 完成不等于该撤下：几秒后自动收掉等于把辛苦跑出来的结果弄丢。
    const next = projectTask(base(), mapRawEvent(raw("run_complete", {}), ctx())!);
    expect(next.state).toBe("succeeded");
    expect(next.unread).toBe(true);
  });

  test("失败要被看见，且文案说的是真实原因", () => {
    const event = mapRawEvent(raw("run_error", { message: "账户余额不足" }), ctx());
    const next = projectTask(base(), event!);
    expect(next.state).toBe("failed");
    expect(next.stageLabel).toBe("账户余额不足");
    expect(next.unread).toBe(true);
  });

  test("取消不算需要用户处理的失败", () => {
    const next = projectTask(base(), {
      runId: "run-1",
      sequence: 9,
      elapsedMs: 10,
      type: "run.cancelled",
      reason: "user",
    });
    expect(next.unread).toBe(false);
  });

  test("快照字段名与 Host 侧一致（camelCase）", () => {
    // Rust 侧 TaskSnapshot 用 camelCase 序列化；改名会让界面静默显示空白。
    const snapshot = base();
    expect(Object.keys(snapshot).sort()).toEqual(
      ["planSteps", "startedAt", "state", "stageLabel", "stepIndex", "taskId", "title", "unread"].sort(),
    );
  });
});

// 云端命令门禁失败仍需与「没听清 / 忙」这类瞬时态分开；前者进入统一短结果面板，
// 后者保留现场反馈，不制造额外结果。

describe("命令门禁失败的短结果筛选", () => {
  test("只有门禁错误码进面板：瞬时态（没听清 / 忙）不进", () => {
    expect(isCommandGateFailureCode("VOICE_COMMAND_NOT_CONFIGURED")).toBe(true);
    expect(isCommandGateFailureCode("VOICE_COMMAND_LOGIN_REQUIRED")).toBe(true);
    // 这些有自己的现场反馈或已有命令在跑，不再弹一份重复结果。
    expect(isCommandGateFailureCode("VOICE_COMMAND_NO_SPEECH")).toBe(false);
    expect(isCommandGateFailureCode("com.reai.voice/VOICE_BUSY")).toBe(false);
    expect(isCommandGateFailureCode("VOICE_COMMAND_FAILED")).toBe(false);
  });

});
