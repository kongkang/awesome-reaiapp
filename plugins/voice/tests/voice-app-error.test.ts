/**
 * 命令失败交回 SDK / Host 与上浮层的出口（§6.0 白名单，按出身认定）：只给登记码、声明为固定文案的
 * 插件主句与 retryable，不带 cause；外部同形对象、拼了上游文字的主句都不被信任。
 */
import { beforeEach, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { toWireError } from "@reai/app-sdk/v1";
import { setVoiceLocale, t } from "../src/voice-i18n";
import { VoiceAppError, commandWireError, constantUserMessage, trustedDiagnosticFields } from "../src/voice-app-error";
import { collectErrorFields, withOuterCode } from "../src/voice-error-fields";

beforeEach(() => setVoiceLocale("zh"));

const SECRET = "Authorization: Bearer SYNTHETIC_ONLY";

test("只有声明为固定文案的插件主句能离开插件界面；没声明的（含拼了上游文字的）与外部异常一律按码查表；都不带 cause", () => {
  const constant = new VoiceAppError({ code: "AGENT_BACKEND_UNAVAILABLE", userMessage: "请先在运行组件里允许 DSH", retryable: true },
    undefined, { constantMessage: true });
  expect(constantUserMessage(constant)).toBe("请先在运行组件里允许 DSH");
  expect(toWireError(commandWireError(constant))).toEqual({ code: "AGENT_BACKEND_UNAVAILABLE", userMessage: "请先在运行组件里允许 DSH", retryable: true });

  // 拼了上游文字的主句：不声明固定文案 → 不被信任（回执与浮层都按码查表）。
  const upstream = new VoiceAppError({ code: "com.reai.voice/CLOUD_TRANSCRIBE_FAILED", userMessage: `云端识别失败：${SECRET}`, retryable: true },
    withOuterCode(collectErrorFields({ code: "AI_UNAVAILABLE", message: SECRET }), "com.reai.voice/CLOUD_TRANSCRIBE_FAILED"));
  expect(constantUserMessage(upstream)).toBeUndefined();
  const wire = toWireError(commandWireError(upstream));
  expect(wire.code).toBe("com.reai.voice/CLOUD_TRANSCRIBE_FAILED");
  expect(JSON.stringify(wire)).not.toContain("SYNTHETIC_ONLY");
  expect(wire.diagnostic).toBeUndefined();

  // 就算外部对象伪装成插件错误（同名字段、同原型链之外），也拿不到「固定文案」身份。
  const lookalike = Object.assign(new Error(SECRET), { code: "AGENT_BACKEND_UNAVAILABLE", userMessage: SECRET, constantMessage: true });
  expect(constantUserMessage(lookalike)).toBeUndefined();
  const foreign = toWireError(commandWireError(Object.assign(new Error(SECRET), { code: "PRIVATE_ACCOUNT_DATA", userMessage: "Host said 13800138000", cause: SECRET })));
  expect(foreign).toEqual({ code: "com.reai.voice/VOICE_COMMAND_FAILED", userMessage: t("app.incompleteOpenForDetails"), retryable: false });
});

test("插件错误上挂的「已采集字段」按出身认定：外部同形对象不被信任，只取登记过的码", () => {
  const forged = { code: "AI_TIMEOUT", upstreamCodes: ["Authorization: Bearer SYNTHETIC_ONLY"], source: "phone-13800138000",
    httpStatus: 503, rawLength: 4500, raw: SECRET };
  const error = new VoiceAppError({ code: "com.reai.voice/SUMMARY_FAILED", userMessage: "x" }, forged as never);
  expect(trustedDiagnosticFields(error)).toBeUndefined();
  const genuine = new VoiceAppError({ code: "com.reai.voice/SUMMARY_FAILED", userMessage: "x" },
    withOuterCode(collectErrorFields({ code: "AI_TIMEOUT", status: 504 }), "com.reai.voice/SUMMARY_FAILED"));
  expect(trustedDiagnosticFields(genuine)).toMatchObject({ code: "com.reai.voice/SUMMARY_FAILED", upstreamCodes: ["AI_TIMEOUT"], httpStatus: 504 });
  // 外部对象交给 withOuterCode 也不会被「接着用」：只剩登记过的外层码。
  const rewrapped = withOuterCode(forged as never, "com.reai.voice/SUMMARY_FAILED");
  expect(rewrapped).toMatchObject({ code: "com.reai.voice/SUMMARY_FAILED", upstreamCodes: [] });
  for (const key of ["raw", "rawLength", "httpStatus"]) expect(rewrapped).not.toHaveProperty(key);
  expect(JSON.stringify(rewrapped)).not.toContain("13800138000");
});

/** 从 `start`（指向开括号）起做括号配平，返回配平后的片段。 */
function balanced(source: string, start: number, open: string, close: string): string {
  let depth = 0;
  for (let end = start; end < source.length; end += 1) {
    if (source[end] === open) depth += 1;
    else if (source[end] === close && --depth === 0) return source.slice(start, end + 1);
  }
  return source.slice(start);
}

/** 主句表达式：`get userMessage() { … }` 取配平后的函数体；`userMessage: …` 取到对象字面量里的下一个顶层逗号。 */
function messageExpression(call: string): string {
  const getter = call.indexOf("get userMessage()");
  if (getter >= 0) return balanced(call, call.indexOf("{", getter), "{", "}");
  const field = /userMessage\s*:/.exec(call);
  if (!field) return "";
  let depth = 0;
  for (let end = field.index + field[0].length; end < call.length; end += 1) {
    const char = call[end]!;
    if ("({[".includes(char)) depth += 1;
    else if (")}]".includes(char)) { if (depth === 0) return call.slice(field.index, end); depth -= 1; }
    else if (char === "," && depth === 0) return call.slice(field.index, end);
  }
  return call.slice(field.index);
}

/**
 * 主句里每个 `t(…)` 调用都要能按白名单形态解析（fail-closed）：第一参是双引号字面量 key；
 * 第二参要么没有，要么是一层对象字面量，且每一项只能是简写 `backend`（固定三元得出的 DSH / Codex / Pi）
 * 或 `seconds: 大写常量[ / 数字]`。反引号 key、变量第二参、嵌套对象、其余键一律不许。
 */
function interpolationsAllowed(message: string): boolean {
  for (let index = message.search(/(?<![\w$.])t\s*\(/); index >= 0; index = nextCall(message, index + 1)) {
    const call = balanced(message, message.indexOf("(", index), "(", ")");
    const inner = call.slice(1, -1).trim();
    const key = /^"[^"\\]+"/.exec(inner);
    if (!key) return false;
    const rest = inner.slice(key[0].length).trim();
    if (rest === "") continue;
    const object = /^,\s*\{([^{}]*)\}$/.exec(rest);
    if (!object) return false;
    for (const entry of object[1]!.split(",").map((item) => item.trim()).filter(Boolean)) {
      if (entry === "backend") continue;
      if (/^seconds\s*:\s*[A-Z][A-Z0-9_]*(?:\s*[/*]\s*\d+)?$/.test(entry)) continue;
      return false;
    }
  }
  return true;
}

/**
 * 主句里出现的函数调用只许是 i18n 的 `t` 与显式列名的固定文案 helper（逐个读过实现：只按码 / 类别 / 枚举返回
 * 固定文案，不把入参文字拼进返回值），以及判断用的数组 `.includes`；属性访问形态的 `x.t(` 不算 i18n。
 * 字符串拼接（`+`）、`.join(`、`.trim(` 之类同样不许——主句不在这个空间里就 fail-closed。
 */
const CONSTANT_TEXT_HELPERS = new Set([
  "t", "stoppedLabel", "interruptedLabel", "agentsImOpenError", "voiceRequestFailureMessage",
  "voiceHistorySaveFailureMessage", "scopeUnavailableMessage", "voiceAgentUnavailableMessage",
  "taskFailureLabel", "voiceRequestFailureReason",
]);
function callsAllowed(message: string): boolean {
  // 可选调用 `f?.(…)`、立即调用 `(…)(…)`、反引号（模板 / 标签模板）也一律不许。
  if (/\.\s*t\s*\(|\+(?!\+)|\.join\(|\.trim\(|\.concat\(|\.replace\(|\?\.\s*\(|\)\s*\(|\]\s*\(|`|return\s*\(\s*[A-Za-z_$][\w$.?]*\s*\)/.test(message.replace(/"[^"]*"/g, '""'))) return false;
  // scopeUnavailableMessage 在条件不成立时整段返回第二参：第二参必须是双引号 key 的 t(…)。
  for (const match of message.matchAll(/\bscopeUnavailableMessage\s*\(/g)) {
    const call = balanced(message, match.index! + match[0].length - 1, "(", ")");
    if (!/^\(\s*[\w$.?]+\s*,\s*t\(\s*"[^"]+"\s*\)\s*\)$/.test(call)) return false;
  }
  for (const match of message.matchAll(/(\.?)\b([A-Za-z_$][\w$]*)\s*\(/g)) {
    const [, dot, name] = match;
    if (dot === "." && name === "includes") continue;
    if (dot === "" && CONSTANT_TEXT_HELPERS.has(name!)) continue;
    if (dot === "" && (name === "if" || name === "return")) continue;
    return false;
  }
  return true;
}

function nextCall(message: string, from: number): number {
  const found = message.slice(from).search(/(?<![\w$.])t\s*\(/);
  return found < 0 ? -1 : from + found;
}

test("源码守卫：声明了固定文案的 VoiceAppError，主句里没有上游文字、异常字段、直接变量或 valueN 占位", () => {
  const dir = resolve(import.meta.dir, "../src");
  const wronglyTrusted: string[] = [];
  let trusted = 0;
  for (const name of readdirSync(dir).filter((file) => file.endsWith(".ts") && file !== "voice-app-error.ts")) {
    const source = readFileSync(resolve(dir, name), "utf8");
    for (let index = source.indexOf("new VoiceAppError("); index >= 0; index = source.indexOf("new VoiceAppError(", index + 1)) {
      const call = balanced(source, index + "new VoiceAppError".length, "(", ")");
      if (!call.includes("constantMessage: true")) continue;
      trusted += 1;
      const message = messageExpression(call);
      // 主句里不许有：上游文字 / 异常字段、直接返回或直接赋值一个变量、以及任何不在白名单形态里的插值参数。
      if (!message || /readableError\(|\.message\b|\.userMessage\b/.test(message)
        || /userMessage\s*:\s*[A-Za-z_$][\w$.?]*\s*$/.test(message)
        || /return\s+[A-Za-z_$][\w$.?]*\s*;/.test(message)
        // 模板字符串是最自然的运行时拼接写法：固定文案里一律不许出现 `${…}`。
        || /\$\{/.test(message)
        || !callsAllowed(message)
        || !interpolationsAllowed(message)) {
        wronglyTrusted.push(`${name}: ${message.replace(/\s+/g, " ").slice(0, 90)}`);
      }
    }
  }
  expect(trusted).toBeGreaterThanOrEqual(40);
  expect(wronglyTrusted).toEqual([]);
});

test("源码守卫：每个命令注册的处理函数都包了 guardCommand（失败交回 SDK 只给登记码与固定文案）", () => {
  const source = readFileSync(resolve(import.meta.dir, "../src/app.ts"), "utf8");
  const calls: string[] = [];
  for (let index = source.indexOf("ctx.commands.register("); index >= 0; index = source.indexOf("ctx.commands.register(", index + 1)) {
    calls.push(balanced(source, index + "ctx.commands.register".length, "(", ")"));
  }
  expect(calls.length).toBeGreaterThanOrEqual(6);
  expect(calls.filter((call) => !/^\([^,]+,\s*guardCommand\(/.test(call)).map((call) => call.slice(0, 80))).toEqual([]);
});

test("源码守卫：其余由 SDK 序列化异常的出口（服务处理函数、Surface 失败 / 报错）只在包好的位置出现且不挂 cause", () => {
  // SDK 的 toWireError 会把异常本身或它的 cause 转成 wire diagnostic 交给 Host（进 App 日志）。
  const dir = resolve(import.meta.dir, "../src");
  const sources = readdirSync(dir).filter((name) => name.endsWith(".ts"))
    .map((name) => ({ name, source: readFileSync(resolve(dir, name), "utf8") }));
  const hits = (pattern: RegExp) => sources.flatMap(({ name, source }) =>
    [...source.matchAll(pattern)].map((match) => ({ name, source, at: match.index! + match[0].length - 1 })));
  // 服务：只许在集中包裹的注册函数里 provide；catch 里重抛的 AppError 只有登记码与按码固定文案。
  const provides = hits(/\.provide\(/g);
  expect(provides.map((hit) => hit.name)).toEqual(["voice-service-registration.ts"]);
  const provided = balanced(provides[0]!.source, provides[0]!.at, "(", ")");
  expect(provided).toMatch(/catch \(error\) \{[\s\S]*throw new AppError\(\{ code, userMessage: voiceServiceMessage\(locale\(\), code\), retryable: [^}]*\}\);\s*\}/);
  expect(provided).not.toMatch(/\bcause\b/);
  // Surface 失败 / 报错：实参必须是插件自己的 VoiceAppError，构造参数里不挂 cause。
  const exits = hits(/\b(?:surface|handle)\.(?:fail|reportError)\(|\.reportError\(/g);
  expect(exits.length).toBeGreaterThanOrEqual(1);
  for (const exit of exits) {
    const argument = balanced(exit.source, exit.at, "(", ")").slice(1).replace(/^\s*(?:\/\/[^\n]*\n\s*)*/, "");
    expect(argument.startsWith("new VoiceAppError("), `${exit.name}: ${argument.slice(0, 60)}`).toBeTrue();
    const input = balanced(argument, argument.indexOf("{"), "{", "}");
    // 含简写 `{ cause }` / `cause,`：构造参数里出现 cause 一律拒绝。
    expect(input).not.toMatch(/\bcause\b/);
  }
});
