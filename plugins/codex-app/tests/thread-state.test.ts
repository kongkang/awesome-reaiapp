import { afterEach, describe, expect, test } from "bun:test";

import { setLocale, resolveText } from "../src/i18n";
afterEach(() => setLocale("zh"));

import {
  FIRST_TURN_READ_GRACE_MS,
  buildThreadDetail,
  createGraceClock,
  emptyThreadPlaceholder,
  isFirstTurnReadWithinGrace,
  mergeThreadsWithPending,
  normalizeListedThreads,
  normalizeStartedThread,
  openFirstTurnReadGrace,
} from "../src/thread-state";

describe("Codex App 新工作空线程", () => {
  test("thread/start 成功后立即保留真实 id 与 cwd，不等 thread/list 出现", () => {
    const pending = normalizeStartedThread(
      {
        thread: {
          id: "019fffff-1111-7111-8111-111111111111",
          cwd: "/work/project",
          status: { type: "idle" },
        },
      },
      "/work/project",
      1234,
    );

    expect({ ...pending, name: resolveText(pending!.name) }).toEqual({
      id: "019fffff-1111-7111-8111-111111111111",
      cwd: "/work/project",
      name: "新工作",
      updatedAt: 1234,
      statusHint: "notStarted",
      needsDecision: false,
    });
    expect(mergeThreadsWithPending([], pending)).toEqual({
      threads: [pending!],
      pending,
    });
  });

  test("官方 thread/list 出现同一个线程后由官方快照接管", () => {
    const pending = {
      id: "019fffff-1111-7111-8111-111111111111",
      cwd: "/work/project",
      name: "新工作",
      updatedAt: 1234,
      statusHint: "idle",
      needsDecision: false,
    };
    const official = { ...pending, name: "真实任务标题", updatedAt: 5678 };

    expect(mergeThreadsWithPending([official], pending)).toEqual({
      threads: [official],
      pending: undefined,
    });
  });

  test("thread/start 没有返回真实 thread id 时拒绝制造本地假任务", () => {
    expect(normalizeStartedThread({}, "/work/project", 1234)).toBeUndefined();
  });
});

describe("Codex app-server 线程与对话归一化", () => {
  test("thread/list 使用 preview 作为标题，并把 Unix 秒转成毫秒", () => {
    expect(
      normalizeListedThreads({
        data: [
          {
            id: "019fffff-2222-7222-8222-222222222222",
            cwd: "/work/project",
            name: null,
            preview: "实现真实 Agent 对话",
            createdAt: 1_780_000_000,
            updatedAt: 1_780_000_123,
            status: { type: "active", activeFlags: [] },
            turns: [],
          },
        ],
      }),
    ).toEqual([
      {
        id: "019fffff-2222-7222-8222-222222222222",
        cwd: "/work/project",
        name: "实现真实 Agent 对话",
        updatedAt: 1_780_000_123_000,
        statusHint: "active",
        needsDecision: false,
      },
    ]);
  });

  test("thread/read 读取真实 userMessage、agentMessage、资料与 changes[]", () => {
    const thread = {
      id: "019fffff-2222-7222-8222-222222222222",
      cwd: "/work/project",
      name: "真实任务",
      updatedAt: 1_780_000_123_000,
      statusHint: "idle",
      needsDecision: false,
    };
    expect(
      buildThreadDetail(
        {
          thread: {
            turns: [
              {
                id: "turn-1",
                status: "completed",
                items: [
                  {
                    id: "user-1",
                    type: "userMessage",
                    content: [
                      { type: "text", text: "检查真实任务" },
                      { type: "mention", name: "CLAUDE.md", path: "/work/project/CLAUDE.md" },
                      { type: "localImage", path: "/work/project/design.png" },
                    ],
                  },
                  { id: "search-1", type: "webSearch", query: "Codex app-server protocol" },
                  { id: "agent-1", type: "agentMessage", text: "已经检查完成。" },
                  {
                    id: "change-1",
                    type: "fileChange",
                    status: "completed",
                    changes: [
                      {
                        path: "/work/project/src/main.ts",
                        kind: { type: "update" },
                        diff: "@@ -1 +1 @@",
                      },
                      {
                        path: "/work/project/src/new.ts",
                        kind: { type: "add" },
                        diff: "@@ -0,0 +1 @@",
                      },
                    ],
                  },
                ],
              },
            ],
          },
        },
        thread,
      ),
    ).toEqual({
      stream: [
        { kind: "user", text: "检查真实任务\n@CLAUDE.md\n图片：/work/project/design.png" },
        { kind: "agent", body: "网页搜索：Codex app-server protocol" },
        { kind: "agent", body: "已经检查完成。" },
        {
          kind: "source",
          chips: [
            { icon: "file-text", label: "main.ts" },
            { icon: "file-text", label: "new.ts" },
          ],
        },
      ],
      fileChanges: [
        { path: "/work/project/src/main.ts", label: "已更新" },
        { path: "/work/project/src/new.ts", label: "新增" },
      ],
      materials: [
        { icon: "file-text", title: "CLAUDE.md", sub: "/work/project/CLAUDE.md" },
        { icon: "file-text", title: "design.png", sub: "/work/project/design.png" },
        { icon: "globe", title: "网页搜索", sub: "Codex app-server protocol" },
      ],
      running: false,
      activeTurnId: undefined,
    });
  });

  test("进行中的 turn 暴露真实 turn id，供 steer 与 interrupt 使用", () => {
    const detail = buildThreadDetail(
      {
        thread: {
          status: { type: "active" },
          turns: [
            { id: "turn-complete", status: "completed", items: [] },
            { id: "turn-active", status: "inProgress", items: [] },
          ],
        },
      },
      undefined,
    );
    expect(detail.running).toBe(true);
    expect(detail.activeTurnId).toBe("turn-active");
  });
});

describe("CODEXAPP-01 首 turn 后的首次权威详情读取宽限", () => {
  test("占位详情在首 turn 前是 idle，首 turn 已被接受后是 active（防并发开第二个 turn）", () => {
    const before = emptyThreadPlaceholder(false);
    expect(before).toEqual({ thread: { turns: [], status: { type: "idle" } } });
    expect(buildThreadDetail(before, undefined).running).toBe(false);

    const duringGrace = emptyThreadPlaceholder(true);
    expect(duringGrace).toEqual({ thread: { turns: [], status: { type: "active" } } });
    const projected = buildThreadDetail(duringGrace, undefined);
    expect(projected.running).toBe(true);
    expect(projected.activeTurnId).toBeUndefined();
  });

  test("宽限窗口只在首 turn 已被接受、线程匹配且未超时时生效", () => {
    const guard = {
      pendingThreadId: "thread-new",
      turnStarted: true,
      graceDeadline: 10_000,
    };
    // 窗口内：静默降级，不把暂时性读取失败闪成 m110。
    expect(isFirstTurnReadWithinGrace(guard, "thread-new", 9_999)).toBe(true);
    expect(isFirstTurnReadWithinGrace(guard, "thread-new", 0)).toBe(true);
    // 超时：恢复真实失败路径（有界，不能无限吞 UNAVAILABLE）。
    expect(isFirstTurnReadWithinGrace(guard, "thread-new", 10_000)).toBe(false);
    expect(isFirstTurnReadWithinGrace(guard, "thread-new", 60_000)).toBe(false);
    // 首 turn 尚未被接受：维持原有空线程占位保护，不进入宽限逻辑。
    expect(
      isFirstTurnReadWithinGrace(
        { ...guard, turnStarted: false },
        "thread-new",
        9_999,
      ),
    ).toBe(false);
    // 用户切到别的线程 / 线程已由官方列表接管：无宽限。
    expect(isFirstTurnReadWithinGrace(guard, "thread-other", 9_999)).toBe(false);
    expect(
      isFirstTurnReadWithinGrace(
        { ...guard, pendingThreadId: undefined },
        "thread-new",
        9_999,
      ),
    ).toBe(false);
    // 权威详情已成功落地（deadline 清零）：无宽限。
    expect(
      isFirstTurnReadWithinGrace(
        { ...guard, graceDeadline: 0 },
        "thread-new",
        9_999,
      ),
    ).toBe(false);
    expect(isFirstTurnReadWithinGrace(guard, "", 9_999)).toBe(false);
  });

  test("宽限时长有界且覆盖多个 2 秒轮询周期", () => {
    expect(FIRST_TURN_READ_GRACE_MS).toBe(10_000);
  });

  test("宽限窗口每个首 turn 周期只设定一次：后续发送不得重开或延长", () => {
    // 首 turn 被接受：从当前单调时刻开窗。
    expect(openFirstTurnReadGrace(false, 0, 1_000)).toEqual({
      turnStarted: true,
      graceDeadline: 11_000,
    });
    // 窗口仍在等待时的后续发送：保持原 deadline，不延长。
    expect(openFirstTurnReadGrace(true, 11_000, 5_000)).toEqual({
      turnStarted: true,
      graceDeadline: 11_000,
    });
    // 权威详情落地收窗（deadline=0）后、官方列表接管 pending 前的盲区内再发：
    // 不得重开——否则该线程随后的真实读取失败会被静默吞掉 ≤10s。
    expect(openFirstTurnReadGrace(true, 0, 9_000)).toEqual({
      turnStarted: true,
      graceDeadline: 0,
    });
  });

  test("宽限时钟：有 performance.now 的环境直接透传（单调递增）", () => {
    const clock = createGraceClock(() => 42.5);
    expect(clock()).toBe(42.5);
    expect(clock()).toBe(42.5);
  });

  test("宽限时钟：无 performance 的环境用「时间不回退」钳制，回拨墙钟不延长窗口", () => {
    let wall = 100_000;
    const clock = createGraceClock(undefined, () => wall);
    const opened = openFirstTurnReadGrace(false, 0, clock());
    expect(opened).toEqual({ turnStarted: true, graceDeadline: 110_000 });
    // 系统时钟回拨：钳制后的 now 停在已见最大值，窗口不被回拨拉长。
    wall = 90_000;
    expect(clock()).toBe(100_000);
    expect(
      isFirstTurnReadWithinGrace(
        { pendingThreadId: "thread-new", ...opened },
        "thread-new",
        clock(),
      ),
    ).toBe(true);
    // 墙钟追回并越过 deadline：窗口照常到期，保持有界。
    wall = 111_000;
    expect(
      isFirstTurnReadWithinGrace(
        { pendingThreadId: "thread-new", ...opened },
        "thread-new",
        clock(),
      ),
    ).toBe(false);
  });
});

test("locale projection keeps supplied task names and content distinct from generated fallbacks", () => {
  const listed = normalizeListedThreads({ data: [
    { id: "raw", cwd: "/用户/项目", name: "未命名任务" },
    { id: "fallback", cwd: "/用户/项目" },
  ] });
  const pending = normalizeStartedThread({ id: "new" }, "/用户/项目")!;
  const detail = { thread: { turns: [{ status: "completed", items: [
    { type: "userMessage", content: [{ type: "text", text: "运行命令：用户原文" }] },
    { type: "agentMessage", text: "已完成用户内容" },
    { type: "commandExecution", command: "echo 用户", aggregatedOutput: "原始输出" },
    { type: "fileChange", changes: [{ path: "/用户/文件.txt", kind: "add" }] },
  ] }] } };
  setLocale("en");
  expect(resolveText(listed.find(row => row.id === "raw")!.name)).toBe("未命名任务");
  expect(resolveText(listed.find(row => row.id === "fallback")!.name)).toBe("Untitled task");
  expect(resolveText(pending.name)).toBe("New work");
  const english = buildThreadDetail(detail, listed[0]);
  expect(english.stream).toEqual(expect.arrayContaining([
    { kind: "user", text: "运行命令：用户原文" },
    { kind: "agent", body: "已完成用户内容" },
    { kind: "agent", body: "Running command: echo 用户\n原始输出" },
  ]));
  expect(english.fileChanges).toEqual([{ path: "/用户/文件.txt", label: "Added" }]);
  setLocale("zh");
  expect(buildThreadDetail(detail, listed[0]).fileChanges).toEqual([{ path: "/用户/文件.txt", label: "新增" }]);
});
