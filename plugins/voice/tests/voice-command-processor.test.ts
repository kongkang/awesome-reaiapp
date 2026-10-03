import { describe, expect, test } from "bun:test";

import { createProcessor, type StreamOpener } from "../src/voice-command-processor";
import { VOICE_COMMAND_CATALOG, type VoiceCommandRequest } from "../src/voice-ai-contract";
import type { RawStreamEvent } from "../src/voice-command-runtime";

function requestFor(command: keyof typeof VOICE_COMMAND_CATALOG): VoiceCommandRequest {
  return {
    requestId: "req-1",
    command: VOICE_COMMAND_CATALOG[command],
    input: {
      kind: "transcript",
      transcript: { text: "帮我查下明天天气", language: "zh-CN", source: "local", durationMs: 1200 },
    },
    profileId: "default",
    preprocess: { kind: "polish", prompt: { id: "voice.polish.spoken-text", version: "1" }, required: true },
  };
}

/** 用固定脚本喂事件，记录每一段收到的 inputs。 */
function scriptedOpener(scripts: RawStreamEvent[][]): {
  opener: StreamOpener;
  calls: Record<string, unknown>[];
} {
  const calls: Record<string, unknown>[] = [];
  let index = 0;
  const opener: StreamOpener = (inputs) => {
    calls.push(inputs);
    const script = scripts[index] ?? [];
    index += 1;
    return (async function* () {
      for (const event of script) yield event;
    })();
  };
  return { opener, calls };
}

function ev(event: string, data: unknown): RawStreamEvent {
  return { event, data: JSON.stringify(data) };
}

function deps(opener: StreamOpener) {
  let id = 0;
  return { openStream: opener, now: () => 1_700_000_000_000, newId: () => `run-${++id}` };
}

async function drain(run: { events: AsyncIterable<{ type: string }> }): Promise<string[]> {
  const seen: string[] = [];
  for await (const event of run.events) seen.push(event.type);
  return seen;
}

describe("单段命令（转文本 / 翻译）", () => {
  test("跑完一条流并收敛出结果", async () => {
    const { opener, calls } = scriptedOpener([
      [
        ev("run_start", { runId: "r" }),
        ev("block_start", { blockId: "translate" }),
        ev("block_chunk", { blockId: "translate", chunk: "Tomorrow" }),
        ev("block_chunk", { blockId: "translate", chunk: " is sunny" }),
        ev("run_complete", {}),
      ],
    ]);
    const run = await createProcessor(deps(opener)).start(requestFor("translate"));
    const types = await drain(run);
    expect(types).toEqual(["run.started", "stage.started", "output.delta", "output.delta", "run.completed"]);

    const result = await run.result;
    expect(result.text).toBe("Tomorrow is sunny");
    expect(result.originalText).toBe("帮我查下明天天气");
    // 单段命令只发一次请求，且 phase 直接是 execute。
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ phase: "execute" });
  });
});

describe("Agent 的两段式确认", () => {
  const planScript = [
    ev("run_start", { runId: "r" }),
    ev("block_complete", { blockId: "plan", output: { title: "查天气", steps: ["检索", "汇总"] } }),
    ev("run_complete", {}),
  ];

  test("先出计划、等确认、再执行", async () => {
    const { opener, calls } = scriptedOpener([
      planScript,
      [ev("run_start", { runId: "r2" }), ev("block_chunk", { blockId: "answer", chunk: "晴" }), ev("run_complete", {})],
    ]);
    const run = await createProcessor(deps(opener)).start(requestFor("agent"));

    const seen: string[] = [];
    const reader = (async () => {
      for await (const event of run.events) {
        seen.push(event.type);
        // 收到计划才确认——这正是"确认必须是真实动作"的形状。
        if (event.type === "plan.proposed") await run.confirmPlan("user");
      }
    })();

    await reader;
    expect(seen).toContain("plan.proposed");
    expect(seen).toContain("plan.confirmed");
    const result = await run.result;
    expect(result.text).toBe("晴");

    // 两段请求：第一段只求计划，第二段带着计划执行。
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ phase: "plan" });
    expect(calls[1]).toMatchObject({ phase: "execute" });
    expect(calls[1].plan).toMatchObject({ title: "查天气" });
  });

  test("计划里的 autoStartMs 恒为 null——确认不能是超时默认值", async () => {
    // 第二段给一个正常的执行脚本：这个用例只关心计划的 autoStartMs，
    // 但空脚本会被"工作流没有返回结果"正确判成失败，反而遮住要测的东西。
    const { opener } = scriptedOpener([
      planScript,
      [ev("run_start", { runId: "r2" }), ev("block_chunk", { blockId: "answer", chunk: "晴" }), ev("run_complete", {})],
    ]);
    const run = await createProcessor(deps(opener)).start(requestFor("agent"));
    let proposed: { plan?: { autoStartMs: number | null } } | undefined;
    const reader = (async () => {
      for await (const event of run.events) {
        if (event.type === "plan.proposed") {
          proposed = event as never;
          await run.confirmPlan("user");
        }
      }
    })();
    await reader;
    expect(proposed?.plan?.autoStartMs).toBeNull();
  });

  test("计划解析不出就失败，绝不编一个让用户确认", async () => {
    const { opener, calls } = scriptedOpener([
      [ev("run_start", { runId: "r" }), ev("block_complete", { blockId: "plan", output: "不是对象" }), ev("run_complete", {})],
    ]);
    const run = await createProcessor(deps(opener)).start(requestFor("agent"));
    await drain(run);
    await expect(run.result).rejects.toThrow("没能生成可确认的计划");
    // 没形成计划就绝不能发第二段——用户什么都没授权。
    expect(calls).toHaveLength(1);
  });

  test("没确认就不会发第二段请求", async () => {
    const { opener, calls } = scriptedOpener([planScript, []]);
    const run = await createProcessor(deps(opener)).start(requestFor("agent"));
    const seen: string[] = [];
    const reader = (async () => {
      for await (const event of run.events) seen.push(event.type);
    })();
    // 故意不调 confirmPlan，改为取消。
    await run.cancel();
    await reader;
    expect(seen).toContain("run.cancelled");
    expect(calls).toHaveLength(1);
    // 回归：取消一个正等确认的运行，result 必须有终局。
    // 早先 confirmed 只由 confirmPlan 唤醒，这里会永久 pending ——
    // 而「弹出计划面板、用户按 Esc 走人」正是最常见的取消场景。
    await expect(run.result).rejects.toThrow("语音命令已取消");
  });
});

describe("不把失败包装成成功", () => {
  test("翻译一个 chunk 都没收到时判失败，而不是兜底成原文", async () => {
    // 端点 outputs 没把中间 block 声明为输出就会这样（计划 §2.1 点名会发生）。
    // 兜底成原文等于：用户说中文期望英文，拿到中文，系统还说"已写入"。
    const { opener } = scriptedOpener([[ev("run_start", { runId: "r" }), ev("run_complete", {})]]);
    const run = await createProcessor(deps(opener)).start(requestFor("translate"));
    await drain(run);
    await expect(run.result).rejects.toThrow("工作流没有返回结果");
  });

  test("纯转写没有后续步骤，兜底成原文是对的", async () => {
    // transcribe 要的就是原文，这条兜底不是降级而是正解。
    const { opener } = scriptedOpener([[ev("run_start", { runId: "r" }), ev("run_complete", {})]]);
    const run = await createProcessor(deps(opener)).start(requestFor("transcribe"));
    await drain(run);
    const result = await run.result;
    expect(result.text).toBe("帮我查下明天天气");
  });

  test("没收到润色稿时不能说润色改变了内容", async () => {
    // polishedText 兜底成原文、polishChanged 却为 true 的话，界面会显示一个
    // 两边一模一样的前后对比。
    const { opener } = scriptedOpener([
      [ev("run_start", { runId: "r" }), ev("block_chunk", { blockId: "translate", chunk: "Sunny" }), ev("run_complete", {})],
    ]);
    const run = await createProcessor(deps(opener)).start(requestFor("translate"));
    await drain(run);
    const result = await run.result;
    expect(result.trace.polishedText).toBe("帮我查下明天天气");
    expect(result.trace.polishChanged).toBe(false);
  });

  test("只有标题没有步骤的计划不推给用户确认", async () => {
    // 让人在不知道自己授权了什么的情况下点确认，和编一个计划是同一种问题。
    const { opener, calls } = scriptedOpener([
      [
        ev("run_start", { runId: "r" }),
        ev("block_complete", { blockId: "plan", output: { title: "删除旧文件", steps: [42, null] } }),
        ev("run_complete", {}),
      ],
    ]);
    const run = await createProcessor(deps(opener)).start(requestFor("agent"));
    const seen = await drain(run);
    expect(seen).not.toContain("plan.proposed");
    await expect(run.result).rejects.toThrow("没能生成可确认的计划");
    expect(calls).toHaveLength(1);
  });
});

describe("取消", () => {
  test("取消会发出 run.cancelled 并结束事件流", async () => {
    const { opener } = scriptedOpener([[ev("run_start", { runId: "r" })]]);
    const run = await createProcessor(deps(opener)).start(requestFor("transcribe"));
    await run.cancel();
    const types = await drain(run);
    expect(types).toContain("run.cancelled");
    // 取消必须有终局，不能留一个永远 pending 的 result 把闭包和队列钉在内存里。
    await expect(run.result).rejects.toThrow();
  });
});
