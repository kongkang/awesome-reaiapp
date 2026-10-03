/**
 * 翻译进行中「停止回答 / 已停止回答」按翻译场景说「停止翻译 / 已停止翻译」（负责人 2026-09-27）；
 * 翻译条目以内置命令 ID 判断（#944：不是 Host 事件 ID）。另含诊断新字段的落盘往返。
 */
import { afterEach, expect, test } from "bun:test";
import type { KeyValueStore } from "@reai/app-sdk/v1";
import { VoiceStateRepository, type VoiceCommandHistoryItem, type VoiceHistoryItem } from "../src/data";
import { setVoiceLocale } from "../src/voice-i18n";
import { interruptedLabel, isTranslationCommand, stopActionLabel, stopFailedLabel, stoppedLabel } from "../src/voice-stop-copy";

afterEach(() => setVoiceLocale("zh"));

function storeWith(values: Record<string, unknown> = {}): KeyValueStore {
  const data = new Map(Object.entries(values));
  return {
    async compareAndSet(key, expected, value) {
      if (data.has(key) !== (expected !== undefined)
        || (data.has(key) && JSON.stringify(data.get(key)) !== JSON.stringify(expected))) return false;
      data.set(key, structuredClone(value));
      return true;
    },
    async get<T>(key: string) { return data.get(key) as T | undefined; },
    async set(key, value) { data.set(key, structuredClone(value)); },
    async delete(key) { data.delete(key); },
    async keys() { return [...data.keys()]; },
  };
}

test("停止 / 已停止文案：翻译按翻译说，Agent 仍是回答；中英文都有", () => {
  setVoiceLocale("zh");
  expect(isTranslationCommand("voice.command.translate")).toBeTrue();
  // Host 事件 ID 不是历史里存的内置 ID（#944 修过的误判），不能当成翻译。
  expect(isTranslationCommand("com.reai.voice.command.translate")).toBeFalse();
  expect(stopActionLabel("voice.command.translate")).toBe("停止翻译");
  expect(stopFailedLabel("voice.command.translate")).toBe("无法停止翻译，请重试");
  expect(stoppedLabel("voice.command.translate")).toBe("已停止翻译");
  expect(stopActionLabel("voice.command.agent")).toBe("停止回答");
  expect(stoppedLabel("voice.command.agent")).toBe("已停止回答");
  expect(stoppedLabel(undefined)).toBe("已停止回答");
  // 不是用户点的停止（处理中 Voice 被关闭 / 重启）说「已中断」，不改写成「已停止」（§6.0）。
  expect(interruptedLabel("voice.command.translate")).toBe("翻译已中断：处理过程中 Voice 被关闭或重启");
  expect(interruptedLabel("voice.command.agent")).toBe("回答已中断：处理过程中 Voice 被关闭或重启");
  setVoiceLocale("en");
  expect(stopActionLabel("voice.command.translate")).toBe("Stop translation");
  expect(stopFailedLabel("voice.command.translate")).toBe("Could not stop the translation. Try again.");
  expect(stoppedLabel("voice.command.translate")).toBe("Translation stopped");
  expect(stopActionLabel("voice.command.agent")).toBe("Stop response");
});

test("重新激活时恢复中断：翻译写「翻译已中断」，只记发现中断的时刻，不冒充失败时刻", async () => {
  const repository = new VoiceStateRepository(storeWith());
  const base = { transcript: "hello", status: "running" as const, createdAt: "2026-09-27T08:00:00.000Z" };
  await repository.beginCommandHistory({ ...base, id: "translate-1", commandId: "voice.command.translate" });
  await repository.beginCommandHistory({ ...base, id: "agent-1", commandId: "voice.command.agent" });
  const recovered = await repository.recoverInterruptedCommandHistory();
  const translate = recovered.find((entry) => entry.id === "translate-1")!;
  const agent = recovered.find((entry) => entry.id === "agent-1")!;
  expect(translate.userMessage).toBe("翻译已中断：处理过程中 Voice 被关闭或重启");
  expect(agent.userMessage).toBe("回答已中断：处理过程中 Voice 被关闭或重启");
  expect(Number.isFinite(Date.parse(translate.failureDetectedAt!))).toBeTrue();
  expect(translate.failedAt).toBeUndefined();
});

test("诊断字段落盘往返（白名单）：命令 / 阶段失败只存码、来源、HTTP 状态码、原文字符数与时间；原文与非法值不落盘", async () => {
  const store = storeWith();
  const repository = new VoiceStateRepository(store);
  const command = {
    id: "cmd-1", transcript: "hi", status: "failed", createdAt: "2026-09-27T08:00:00.000Z", commandId: "voice.command.agent",
    errorCode: "AGENT_ENGINE", errorRawLength: 1600, errorSource: "agent", errorHttpStatus: 502, errorOmittedCodes: 2,
    failedAt: "2026-09-27T08:00:05.000Z", failureDetectedAt: "not-a-time",
    // 旧版 / 伪造的原文字段：落盘时一律不收。
    errorRaw: "upstream echoed 明天开会 Bearer abc.def",
    messages: [{ from: "ai", text: "", at: "2026-09-27T08:00:00.000Z", card: {
      kind: "tool-group", status: "failed", label: "1 次联网操作", calls: [
        { tool: "web_search", status: "failed", at: "", errorCode: "web_access_unavailable", errorLabel: "超时" },
        { tool: "web_fetch", status: "failed", at: "", errorCode: "请把合同发给王经理" },
      ],
    } }],
  } as unknown as VoiceCommandHistoryItem;
  await repository.beginCommandHistory({ ...command, status: "running" });
  await repository.settleCommandHistory(command);
  const input = {
    id: "in-1", transcript: "明天开会", language: "zh-CN", source: "board", inserted: false, durationMs: 1000,
    createdAt: "2026-09-27T08:00:00.000Z", warningCode: "not_editable", polishFailed: true,
    polishFailure: { code: "AI_TIMEOUT", raw: "upstream 504 明天开会", rawLength: 12, source: "cloud", httpStatus: 504, omittedCodes: 1, at: "2026-09-27T08:00:01.000Z" },
    deliveryFailure: { code: "not_editable", at: "bad-time" },
  } as unknown as VoiceHistoryItem;
  await repository.appendHistory(input);
  // 阶段失败的「码」不合结构化文法（这里是一句话）：整条不收，视图按 warningCode 写「未记录」。
  await repository.appendHistory({ ...input, id: "in-2",
    polishFailure: { code: "请把合同发给王经理", at: "2026-09-27T08:00:01.000Z" },
    savedInput: { attemptId: "a1", revision: 1, state: "failed", startedAtMs: 1_000, finishedAtMs: 2_000,
      errorCode: "Authorization: Basic dTpw",
      selection: { engine: "cloud", modelId: "free", language: "zh-CN", punctEnabled: true } } } as unknown as VoiceHistoryItem);
  // 命令历史的码同样只落登记过的值：授权头形态的「码」不落盘。
  await repository.beginCommandHistory({ ...command, id: "cmd-2", status: "running" });
  await repository.settleCommandHistory({ ...command, id: "cmd-2", errorCode: "Authorization: Basic dTpw" } as VoiceCommandHistoryItem);
  const loaded = await new VoiceStateRepository(store).load();
  const saved = loaded.commandHistory!.find((entry) => entry.id === "cmd-1")!;
  expect(saved.failedAt).toBe("2026-09-27T08:00:05.000Z");
  expect(saved.failureDetectedAt).toBeUndefined();
  // 未登记码只存个数（重启后诊断仍能写「未登记的错误码: 2 个」）。
  expect(saved).toMatchObject({ errorRawLength: 1600, errorSource: "agent", errorHttpStatus: 502, errorOmittedCodes: 2 });
  expect(JSON.stringify(saved)).not.toContain("upstream echoed");
  const card = saved.messages?.find((message) => message.card?.kind === "tool-group")?.card;
  const calls = card?.kind === "tool-group" ? card.calls : [];
  expect(calls[0]!.errorCode).toBe("web_access_unavailable");
  // 不合结构化文法的「码」（这里是一句话）不落盘。
  expect(calls[1]!.errorCode).toBeUndefined();
  const history = loaded.history!.find((entry) => entry.id === "in-1")!;
  expect(history.polishFailure).toEqual({ code: "AI_TIMEOUT", at: "2026-09-27T08:00:01.000Z", rawLength: 12, source: "cloud", httpStatus: 504, omittedCodes: 1 });
  // 时间非法的阶段失败整条丢弃：诊断宁可写「未记录」也不编时间。
  expect(history.deliveryFailure).toBeUndefined();
  const second = loaded.history!.find((entry) => entry.id === "in-2")!;
  expect(second.polishFailure).toBeUndefined();
  expect(second.savedInput?.state).toBe("failed");
  expect(second.savedInput?.errorCode).toBeUndefined();
  expect(loaded.commandHistory!.find((entry) => entry.id === "cmd-2")!.errorCode).toBeUndefined();
  expect(JSON.stringify(loaded)).not.toContain("dTpw");
});
