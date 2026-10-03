/**
 * Agent 对话界面的数据形态。
 *
 * 字段对稿 `design/VoiceType_UI_Designs.html` 的 TASKS[].chat.msgs（`from` / `text` /
 * `ts` / `card`）与 `cardHTML` 的三种卡；也与 `@reai/agent-ui` 的 `Card`
 * （type/icon/name/meta/alt/dur）一一对应，二期 agent-ui 内部改调本包时不用改数据。
 */

export type ChatAttachment =
  | {
      kind: "file";
      /** 卡左侧的图标，通常是一个 emoji（稿：📄 / 📊）；缺省 📄。 */
      icon?: string;
      name: string;
      /** 「Plain text · 0.3 KB」一类的说明行。 */
      meta?: string;
    }
  | {
      kind: "image";
      /** 占位说明（稿里图片卡只画占位与文字，没有真图）。 */
      alt: string;
    }
  | {
      kind: "audio";
      durationMs: number;
      /**
       * 波形条高度（px，3–17 之间），缺省按 `durationMs` 做稳定种子生成——
       * 同一条每次打开必须一模一样，随机数会让「这就是那段录音」这件事不可信。
       */
      waveform?: number[];
    };

export interface ChatMessage {
  from: "user" | "ai";
  /** 正文；允许为空（只有附件的消息）。AI 默认解析 Markdown，用户保持原文。 */
  text: string;
  /** 系统提示保持纯文本与 locale 绑定，不作为模型回复解析。 */
  format?: "plain";
  /** 时间：ISO 字符串 / 毫秒 / Date。渲染成稿的 `2:47 PM` 短格式。 */
  at: number | string | Date;
  attachments?: ChatAttachment[];
  card?: ChatStatusCard;
  runtime?: "dsh" | "pi" | "codex";
  channel?: "external-brain";
  usage?: { complete: boolean; inputTokens?: number; outputTokens?: number; totalTokens?: number };
  /** Legacy field: insufficient evidence of complete turn usage, never displayed. */
  totalTokens?: number;
}

/** 一次工具调用的明细行（tool-group 卡展开后逐行显示，失败尝试保留）。 */
export interface ChatToolCallEntry {
  callId?: string;
  tool: string;
  status: "running" | "completed" | "failed" | "unknown";
  at: string;
  durationMs?: number;
  errorLabel?: string;
  /** 明细行显示名（本地化后的「联网搜索」一类）；缺省显示 `tool`。 */
  label?: string;
  /** 联网 / 网页类工具用地球仪图标：运行中表面横向转动，结束后停住。 */
  icon?: "globe";
}

export type ChatStatusCard =
  | {
      kind: "tool";
      tool: "web_search" | "web_fetch";
      status: "running" | "completed" | "failed";
      label: string;
    }
  | {
      /**
       * 每个回合一条过程折叠（稿 `.voice-process`）：摘要行 = 状态图标 + 在做 / 做了什么 +
       * 右侧补充（用时、失败码）+ 展开箭头；点开逐次调用明细（含失败重试）。
       */
      kind: "tool-group";
      status: "running" | "completed" | "failed" | "unknown";
      label: string;
      /** 摘要行右侧的补充说明；运行中的已用时间由 `renderToolGroupMeta` 提供活节点。 */
      meta?: string;
      /** 回合里有联网 / 网页类工具时，摘要行用地球仪图标。 */
      icon?: "globe";
      calls: ChatToolCallEntry[];
      totalCalls?: number;
      failedCalls?: number;
      omittedCalls?: number;
    }
  | {
      kind: "capability-required";
      capability: "browser-web-access";
      title: string;
      detail: string;
      actionId: "install-browser-web-access";
      actionLabel: string;
    }
  | {
      kind: "auth-required";
      title: string;
      detail: string;
    };

/** 语音气泡波形条数：稿取 20 根（cardHTML），卡宽 240px 再多也摆不下。 */
export const CHAT_WAVEFORM_BARS = 20;
