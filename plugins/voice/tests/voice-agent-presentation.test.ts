/**
 * 负责人 rc.2.7 真机反馈 问题 3 / 4 的投影层：同一回合的全部工具调用并成一条过程折叠；
 * 回答在只显示纯文本的位置去掉 Markdown 标记。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { ChatMessage } from "@reai/chat-ui";
import { AGENT_CODES_WITH_TOOL_DETAIL, agentCodeLabel } from "../src/agent-failure-codes";
import { mergeToolProgress, plainReply, replyPreview, toolProgressSummary, trimToolCalls } from "../src/voice-agent-presentation";
import en from "../assets/locales/en.json";
import zh from "../assets/locales/zh.json";
import { setVoiceLocale, t } from "../src/voice-i18n";

let ownsDom = false;
beforeAll(() => {
  if (typeof document === "undefined") { GlobalRegistrator.register(); ownsDom = true; }
  setVoiceLocale("zh");
});
afterAll(() => { setVoiceLocale("zh"); if (ownsDom) GlobalRegistrator.unregister(); });

const AT = "2026-09-28T03:00:00.000Z";
const user: ChatMessage = { from: "user", text: "明天北京天气怎么样", at: AT };
const answer: ChatMessage = { from: "ai", text: "**天气：**晴", at: AT };
const legacy = (tool: "web_search" | "web_fetch", label: string): ChatMessage =>
  ({ from: "ai", text: "", at: AT, card: { kind: "tool", tool, status: "completed", label } });
type Call = { tool: string; status: "running" | "completed" | "failed" | "unknown"; at?: string; durationMs?: number; errorCode?: string };
const group = (status: "running" | "completed" | "failed" | "unknown", calls: Call[]): ChatMessage => ({
  from: "ai", text: "", at: AT,
  card: { kind: "tool-group", status, label: "旧标签", calls: calls.map((call) => ({ at: "", ...call })), totalCalls: calls.length },
});
const toolCards = (messages: ChatMessage[]) => messages.filter((message) => message.card);
const cardOf = (messages: ChatMessage[]) => {
  const card = toolCards(messages)[0]?.card;
  if (card?.kind !== "tool-group") throw new Error("merged card missing");
  return card;
};

describe("同一回合的工具调用并成一条过程折叠", () => {
  test("旧版每工具一张的卡（真机截图那两张）并成一条，回答与提问不动", () => {
    const merged = mergeToolProgress([user, legacy("web_search", "已使用浏览器插件完成联网搜索"),
      legacy("web_fetch", "已使用浏览器插件完成网页读取"), answer], "completed");
    expect(toolCards(merged)).toHaveLength(1);
    expect(merged).toHaveLength(3);
    expect(merged[0]).toBe(user);
    expect(merged[2]).toBe(answer);
    const card = cardOf(merged);
    expect(card.label).toBe("已调用 2 个工具：联网搜索、读取网页");
    expect(card.icon).toBe("globe");
    expect(card.calls.map((call) => [call.tool, call.label, call.status])).toEqual([
      ["web_search", "联网搜索", "completed"], ["web_fetch", "读取网页", "completed"]]);
  });

  test("不同类型工具（联网、浏览器、文件）同一条；运行中主句是当前步骤", () => {
    const running = cardOf(mergeToolProgress([user, group("running", [
      { tool: "web_search", status: "completed" }, { tool: "browser_navigate", status: "completed" }, { tool: "read", status: "running" },
    ])], "running"));
    expect(running.label).toBe("正在读取文件");
    expect(running.meta).toBeUndefined();
    expect(running.calls.map((call) => call.icon)).toEqual(["globe", "globe", undefined]);
    const done = cardOf(mergeToolProgress([user, group("completed", [
      { tool: "web_search", status: "failed", at: AT, durationMs: 1000 },
      { tool: "web_search", status: "completed", at: "2026-09-28T03:00:01.000Z", durationMs: 500 },
      { tool: "browser_click", status: "completed", at: "2026-09-28T03:00:02.000Z", durationMs: 1500 },
      { tool: "grep", status: "completed" }, { tool: "mcp.custom", status: "completed" },
    ])], "completed"));
    // 失败后同一工具重试成功：不判红，但摘要仍写明失败次数。
    expect(done.status).toBe("completed");
    expect(done.label).toBe("已调用 4 个工具（共 5 次）：联网搜索、点击网页、搜索文件内容等");
    expect(done.meta).toBe("1 次失败 · 用时 3 秒");
  });

  test("失败：主句给哪个工具没完成与真实原因，右侧给错误码；明细行带码", () => {
    const card = cardOf(mergeToolProgress([user, group("failed", [
      { tool: "web_search", status: "completed" },
      { tool: "web_fetch", status: "failed", errorCode: "web_access_unavailable" },
    ])], "failed"));
    const reason = t("agentErrors.message11");
    expect(card.label).toBe(`读取网页未完成：${reason}`);
    expect(card.meta).toBe("错误码 web_access_unavailable · 1 次失败");
    expect(card.calls[1]?.errorLabel).toBe(`${reason}（错误码 web_access_unavailable）`);
    const noCode = cardOf(mergeToolProgress([group("failed", [{ tool: "command", status: "failed" }])], "failed"));
    expect(noCode.label).toBe("运行命令未完成：调用失败");
    expect(noCode.meta).toBe("无错误码 · 1 次失败");
  });

  test("回合已结束却没收到结束信号的调用：如实写未确认，图标不再转", () => {
    const card = cardOf(mergeToolProgress([group("running", [
      { tool: "web_search", status: "completed" }, { tool: "web_fetch", status: "running" }])], "completed"));
    expect(card.status).toBe("unknown");
    expect(card.calls[1]?.status).toBe("unknown");
    expect(card.calls[1]?.errorLabel).toBe("没有收到结束信号，结果未确认");
    expect(card.meta).toBe("1 次未确认结束");
  });

  test("W2：非联网工具失败且没有重试成功，即使卡上记的是完成、Agent 已作答，也判红并写明次数、原因与码", () => {
    const code = "AGENT_TOOL_AUTHORIZATION_UNAVAILABLE";
    const card = cardOf(mergeToolProgress([user, group("completed", [
      { tool: "web_search", status: "completed" }, { tool: "read", status: "failed", errorCode: code },
    ]), answer], "completed"));
    expect(card.status).toBe("failed");
    expect(card.label).toBe("读取文件未完成：工具授权不可用");
    expect(card.meta).toBe(`错误码 ${code} · 1 次失败`);
    expect(card.calls[1]?.errorLabel).toBe(`工具授权不可用（错误码 ${code}）`);
    // 另一个工具的成功不算这个工具的重试。
    const other = cardOf(mergeToolProgress([group("completed", [
      { tool: "command", status: "failed" }, { tool: "grep", status: "completed" }])], "completed"));
    expect(other.status).toBe("failed");
    expect(other.meta).toBe("无错误码 · 1 次失败");
  });

  test("W2：工具 / 命令 / 确认 / 工作目录类码逐码给具体原因，不退回大类短句", () => {
    const timeout = cardOf(mergeToolProgress([group("completed", [
      { tool: "command", status: "failed", errorCode: "AGENT_EXEC_TIMEOUT" }])], "completed"));
    expect(timeout.label).toBe("运行命令未完成：命令执行超时");
    expect(timeout.label).not.toContain(agentCodeLabel("AGENT_EXEC_TIMEOUT")!);
    setVoiceLocale("en");
    expect(timeout.calls[0]?.errorLabel).toContain("Command timed out");
    setVoiceLocale("zh");
    expect(AGENT_CODES_WITH_TOOL_DETAIL).toHaveLength(42);
    for (const table of [zh, en]) {
      expect(Object.keys(table.chat.tools.codeReason).sort()).toEqual([...AGENT_CODES_WITH_TOOL_DETAIL].sort());
      for (const text of Object.values(table.chat.tools.codeReason)) expect(text.trim().length).toBeGreaterThan(0);
    }
  });

  test("W2：明细超上限时，没解决的失败和每个工具最近一次不被后面的调用挤掉", () => {
    const calls: Call[] = [{ tool: "read", status: "failed", errorCode: "AGENT_TOOL_NOT_GRANTED" },
      ...Array.from({ length: 20 }, (): Call => ({ tool: "grep", status: "completed" }))];
    const kept = trimToolCalls(calls.map((call) => ({ at: "", ...call })), 20);
    expect(kept).toHaveLength(20);
    expect(kept[0]?.tool).toBe("read");
    expect(kept.filter((call) => call.tool === "grep")).toHaveLength(19);
    // 失败后同一工具重试成功、再被 20 次别的调用淹没：工具个数仍是 2。
    const retried = trimToolCalls([{ at: "", tool: "read", status: "failed" as const },
      { at: "", tool: "read", status: "completed" as const }, ...calls.slice(1).map((call) => ({ at: "", ...call }))], 20);
    expect(new Set(retried.map((call) => call.tool)).size).toBe(2);
    expect(retried.find((call) => call.tool === "read")?.status).toBe("completed");
    // 工具种类比上限还多时，先保没解决的失败。
    const many = Array.from({ length: 25 }, (_, index) =>
      ({ at: "", tool: `mcp.t${index}`, status: index === 0 ? "failed" as const : "completed" as const }));
    const wide = trimToolCalls(many, 20);
    expect(wide).toHaveLength(20);
    expect(wide[0]?.tool).toBe("mcp.t0");
    // 没解决的失败最优先（被裁的在途调用有结果时由调用方按序号补回）；同一工具正在重试时，旧失败让位。
    const failedAll = Array.from({ length: 20 }, (_, index) => ({ at: "", tool: `mcp.t${index}`, status: "failed" as const }));
    const fresh = trimToolCalls([...failedAll, { at: "", tool: "mcp.new", status: "running" as const }], 20);
    expect(fresh).toEqual(failedAll);
    // 在途调用排在「每个工具最近一次」之前：同一工具并行的较早一次也保留。
    const parallel = trimToolCalls([{ at: "", tool: "grep", status: "running" as const, callId: "g-1" },
      { at: "", tool: "grep", status: "running" as const, callId: "g-2" },
      ...Array.from({ length: 20 }, (_, index) => ({ at: "", tool: "read", status: "completed" as const, callId: `r-${index}` }))], 20);
    expect(parallel.slice(0, 2).map((call) => call.callId)).toEqual(["g-1", "g-2"]);
    const retrying = trimToolCalls([...failedAll, { at: "", tool: "mcp.t5", status: "running" as const }], 20);
    expect(retrying.at(-1)).toMatchObject({ tool: "mcp.t5", status: "running" });
    expect(retrying.filter((call) => call.status === "failed").map((call) => call.tool)).not.toContain("mcp.t5");
    expect(trimToolCalls(calls.slice(0, 3).map((call) => ({ at: "", ...call })), 20)).toHaveLength(3);
  });

  test("W3：按工具标识计数；没登记显示名的工具带上标识，明细分得清", () => {
    const card = cardOf(mergeToolProgress([group("completed", [
      { tool: "computer_mouse_click", status: "completed" }, { tool: "computer_text_type", status: "completed" },
      { tool: "mcp.alpha", status: "completed" }, { tool: "mcp.beta", status: "completed" },
    ])], "completed"));
    expect(card.label).toBe("已调用 4 个工具：点击屏幕、输入文字、使用工具 mcp.alpha等");
    expect(card.calls.map((call) => call.label)).toEqual(["点击屏幕", "输入文字", "使用工具 mcp.alpha", "使用工具 mcp.beta"]);
    setVoiceLocale("en");
    expect(card.calls[3]?.label).toBe("Use tool mcp.beta");
    setVoiceLocale("zh");
  });

  test("W4：旧版失败卡的说明文字带进明细与摘要，没有码时显示原文而不只写「无错误码」", () => {
    const failed: ChatMessage = { from: "ai", text: "", at: AT,
      card: { kind: "tool", tool: "web_search", status: "failed", label: "权限不足，请登录" } };
    const card = cardOf(mergeToolProgress([user, failed, answer], "failed"));
    expect(card.status).toBe("failed");
    expect(card.label).toBe("联网搜索未完成：权限不足，请登录");
    expect(card.calls[0]?.errorLabel).toBe("权限不足，请登录（无错误码）");
    // 成功卡的文案不是原因，不进明细。
    expect(cardOf(mergeToolProgress([legacy("web_fetch", "已读取")], "completed")).calls[0]?.errorLabel).toBeUndefined();
  });

  test("语言切换即时生效；列表摘要与对话页同一口径", () => {
    const merged = mergeToolProgress([legacy("web_search", "x"), legacy("web_fetch", "y")], "completed");
    setVoiceLocale("en");
    expect(cardOf(merged).label).toBe("Used 2 tools: Web search, Read web page");
    setVoiceLocale("zh");
    expect(toolProgressSummary([legacy("web_search", "x"), legacy("web_fetch", "y")], "completed"))
      .toBe("已调用 2 个工具：联网搜索、读取网页");
    expect(toolProgressSummary([user, answer], "completed")).toBeUndefined();
    expect(mergeToolProgress([user, answer], "completed")).toEqual([user, answer]);
  });
});

describe("只显示纯文本的位置不露 Markdown 标记", () => {
  test("Host 结果面板正文与历史列表摘要", () => {
    const reply = "## 明天天气\n\n**天气：**多云\n- **气温：**18~26℃\n- 风力 3级";
    expect(plainReply(reply)).toBe("明天天气\n天气：多云\n• 气温：18~26℃\n• 风力 3级");
    expect(replyPreview(reply)).toBe("明天天气 天气：多云 • 气温：18~26℃ • 风力 3级");
    expect(replyPreview("")).toBe("");
    expect(plainReply("---")).toBe("---");
  });
});
