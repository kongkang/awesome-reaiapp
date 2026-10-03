import { t } from "./voice-i18n";
import type { VoiceDiagnosticToken } from "./voice-diagnostics";

/**
 * 诊断里的模型白名单（设计规范 §6.0 #waiting-failure-minimum「复制的诊断不含用户原文 / 个人信息」
 * 与 2.14.1 的白名单约定）：内置或云端的标准模型 ID 不算隐私，可以原样写进复制诊断；用户自定义 /
 * 本地导入的模型 ID 与名字可能是含用户名的文件路径或用户自取的名字，复制诊断、落盘诊断、日志与
 * 交给 Host 的诊断字段里一律只写固定标签「自定义模型」（可附来源类别 local / cloud），不写名字或路径。
 *
 * 登记表只收插件自己的模型目录 / 常量（测试逐项钉住，改常量不改这里会变红）：
 * - 本地：Host 内置本地识别模型目录里的 `sensevoice-small-int8`（data.ts `DEFAULT_MODEL_ID`）。
 * - 云端文本：润色与当日总结用的档位 `text-default`（voice-polish `POLISH_MODEL`、voice-digest `DIGEST_MODEL`）。
 * - 云端转写：后台公开配置的默认选项 `transcribe-free`（docs/driver-transcription-config.md），
 *   以及旧版保留 ID `transcribe-default`（cloud-selection 里的拒收常量，旧回执里可能还有）。
 * 后台以后新增的云端转写选项没登记前在诊断里写「自定义模型 (cloud)」；要原样显示就在这里登记。
 *
 * 界面上用户自己看的位置（设置页模型行、输入详情的识别方式、诊断区的显示值）不经过这里。
 */
interface KnownVoiceModel {
  /**
   * 步骤文案里用的名称（只有本地下载步骤需要）；不给就用 ID。与 Host 内置模型目录的显示名一致
   * （tests/repo-contracts/voice-model-registry-names.test.ts 对照 driver-v2 voice/model.rs）。
   * 来源类别（local / cloud）不在表里：诊断标签的来源后缀由调用处按上下文传入。
   */
  name?: string;
}

const KNOWN_VOICE_MODELS: ReadonlyMap<string, Readonly<KnownVoiceModel>> = new Map<string, KnownVoiceModel>([
  ["sensevoice-small-int8", { name: "SenseVoice Small" }],
  ["text-default", {}],
  ["transcribe-free", {}],
  ["transcribe-default", {}],
]);

/** 登记表的只读快照（给测试钉住整表用）。 */
export function knownVoiceModelIds(): string[] {
  return [...KNOWN_VOICE_MODELS.keys()];
}

/** 是否登记：只认登记表里的 ID（`Map` 查找，不会被 `constructor` 之类的原型键骗过）。 */
export function isKnownVoiceModelId(id: unknown): id is string {
  return typeof id === "string" && KNOWN_VOICE_MODELS.has(id);
}

function sourceKind(source: unknown): "local" | "cloud" | undefined {
  return source === "local" || source === "cloud" ? source : undefined;
}

/**
 * 复制诊断里的模型值：已登记 → ID 原样；其余（含路径、用户自取的名字）→ 固定标签「自定义模型」，
 * 只附来源类别。没有模型（undefined / null / 空串）照旧写「无」。
 */
export function diagnosticModelToken(id: unknown, source?: unknown): VoiceDiagnosticToken {
  if (id === undefined || id === null || id === "") return undefined;
  if (isKnownVoiceModelId(id)) return id;
  const kind = sourceKind(source);
  return kind ? { fixedLabel: "customModel", source: kind } : { fixedLabel: "customModel" };
}

/**
 * 步骤文案（会随复制诊断一起出去）里的模型名：已登记 → 登记名（没有就用 ID）；其余 → 「自定义模型」。
 * 不用 Host 给的显示名：显示名是自由文本，登记的只是 ID。
 */
export function diagnosticModelName(id: unknown): string {
  if (isKnownVoiceModelId(id)) return KNOWN_VOICE_MODELS.get(id)!.name ?? id;
  return t("diagnostics.customModel");
}
