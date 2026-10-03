/**
 * 诊断助手的界面层：薄壳——全部状态在 `doctor-model.ts`，这里只把快照渲染出来。
 * 复用 `packages/agent-ui`（对话流 / 工作卡 / 状态药丸 / 输入框），不新写对话 UI。
 */

import {
  createStatusPill,
  element,
  mountAgentComposer,
  mountConversationStream,
  type ConversationStream,
} from "@reai/agent-ui";
import type { DoctorSnapshot } from "./doctor-model";

export interface DoctorView {
  render(snapshot: DoctorSnapshot): void;
  /** 流式续文：原地更新最后一条助手气泡，不全量重建对话流。 */
  appendToLastMessage(text: string): void;
  dispose(): void;
}

export function mountDoctorView(
  root: HTMLElement,
  options: {
    placeholder: string;
    onSend(text: string): void;
    onCancel(): void;
  },
): DoctorView {
  const frame = element("section", "plugin-main-frame");
  const stage = element("section", "main-body agent-ui device-doctor");
  frame.appendChild(stage);

  const header = element("header", "device-doctor-header");
  const noteRow = element("div", "device-doctor-note-row");
  const note = element("p", "device-doctor-note");
  note.textContent =
    "只读查看设备与权限状态，不写文件、不执行命令。回答需要分析时，会把脱敏后的日志摘要发到云端。";
  const pillHost = element("span", "device-doctor-pill");
  noteRow.append(note, pillHost);
  header.append(noteRow);

  const conversation = element("div", "device-doctor-conversation");
  const dock = element("div", "device-doctor-dock");
  const cancel = element("button", "device-doctor-cancel");
  cancel.type = "button";
  cancel.textContent = "停止";
  cancel.hidden = true;
  cancel.addEventListener("click", options.onCancel);
  dock.append(cancel);

  stage.append(header, conversation, dock);
  root.append(frame);

  const stream: ConversationStream = mountConversationStream(conversation, {
    agent: {
      id: "com.reai.device-doctor",
      kind: "agent",
      ava: "诊",
      name: "设备诊断助手",
      status: "idle",
      time: "",
      last: "",
      stream: [],
    },
    items: [],
  });

  const composer = mountAgentComposer(dock, {
    placeholder: options.placeholder,
    scrollContainer: stream.element,
    onSend(text) {
      const trimmed = text.trim();
      if (trimmed) options.onSend(trimmed);
    },
  });

  const render = (snapshot: DoctorSnapshot) => {
    stream.render(snapshot.agent.stream, snapshot.agent);
    pillHost.replaceChildren(createStatusPill(snapshot.agent.status));
    composer.input.disabled = snapshot.busy;
    composer.input.placeholder = snapshot.busy
      ? "助手正在检查…"
      : options.placeholder;
    cancel.hidden = !snapshot.busy;
  };

  return {
    render,
    appendToLastMessage(text: string) {
      stream.updateLastMessage(text);
    },
    dispose() {
      composer.dispose();
      stream.element.remove();
      stage.remove();
    },
  };
}
