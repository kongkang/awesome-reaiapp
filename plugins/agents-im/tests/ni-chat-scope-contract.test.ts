import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

function readTypeScriptTree(path: string): string {
  const absolute = join(root, path);
  return readdirSync(absolute, { withFileTypes: true })
    .flatMap((entry) => {
      const relative = join(path, entry.name);
      if (entry.isDirectory()) return readTypeScriptTree(relative);
      return entry.isFile() && entry.name.endsWith(".ts") ? [read(relative)] : [];
    })
    .join("\n");
}

describe("ni.chat 纯 IM 客户端范围合同", () => {
  test("manifest 只承诺 ni.chat IM 客户端，不承诺 Agent runtime 或任务入口", () => {
    const manifest = JSON.parse(read("app.manifest.json"));
    const productCopy = JSON.stringify({
      description: manifest.description,
      storeListing: manifest.storeListing,
      contributes: manifest.contributes,
    });

    expect(manifest.appId).toBe("com.reai.agents-im");
    expect(manifest.name).toBe("Agents · IM");
    expect(manifest.contributes.surfaces[0].title).toBe("Agents · IM");
    expect(manifest.contributes.sidebarItems[0].label).toBe("Agents · IM");
    expect(manifest.runtime.components[0].activation).toBe("on-demand");
    expect(manifest.network.endpoints).toEqual([]);
    expect(manifest.permissions).toEqual([]);
    expect(productCopy).not.toMatch(/本机 agent|任务锚点|工作中|provider|runtime|Agents · 任务/i);
  });

  test("客户端源码不扫描或运行 Agent，也不导入任务领域模型", () => {
    const source = [
      readTypeScriptTree("src"),
      readTypeScriptTree("packages/ni-chat-ui/src"),
    ].join("\n");

    expect(source).toContain("@reai/ni-chat-ui");
    expect(source).not.toContain("@reai/agent-ui");
    expect(source).not.toMatch(/AgentTask|StreamAnchor|createDemoAgentState|node:child_process|\bpty\b|provider session/);
  });

  test("Agent 使用到的标准 IM part 都有显式客户端类型", () => {
    const model = read("packages/ni-chat-ui/src/model.ts");
    for (const kind of [
      "text", "thinking", "tool_call", "tool_result", "image", "audio",
      "video", "file", "webpage", "interaction_ref", "unknown",
    ]) {
      expect(model).toContain(`kind: \"${kind}\"`);
    }
    expect(model).toContain('export type ProfileType = "user" | "agent" | "system"');
    expect(model).toContain('export type TransientStatusKind = "typing" | "thinking" | "tool_calling"');
  });
});

describe("ni.chat 跨 App intent：attach-context（A3-24「发给 agent」的承接侧）", () => {
  test("manifest 声明 attach-context intent，负载必填呈现名与正文", () => {
    const manifest = JSON.parse(read("app.manifest.json"));
    const intent = manifest.contributes.intents.find((item: { id: string }) => item.id === "attach-context");
    expect(intent.version).toBe("1.0.0");
    expect(intent.opens).toBe("surface:main");
    expect(intent.inputSchema.required).toEqual(["label", "text"]);
    expect(intent.inputSchema.additionalProperties).toBe(false);
  });

  test("app.ts 冷启动补发 initialIntent 并订阅后续投递；残缺负载宁可忽略也不进输入侧", () => {
    const app = read("src/app.ts");
    const view = read("src/agents-im-view.ts");
    // 先挂视图再注册（codex-link 同款次序）：SDK 的 pendingIntent 会补发最后一条。
    expect(app).toContain("applyIntent(surface.initialIntent)");
    expect(app).toContain("surface.onIntent(applyIntent)");
    expect(app).toContain("view.attachExternalContext({");
    // 字段级把关在客户端补：Host 侧 payload 校验只到「必须是对象」。
    expect(view).toContain("export function isAttachContextIntent");
  });

  test("open-conversation intent（B6-26「在 IM 里看上下文」）：manifest 提供合同、客户端收窄守卫", async () => {
    const manifest = JSON.parse(read("app.manifest.json"));
    const intent = manifest.contributes.intents.find((item: { id: string }) => item.id === "open-conversation");
    expect(intent.version).toBe("1.0.0");
    expect(intent.inputSchema.required).toEqual(["agentName"]);

    const { isOpenConversationIntent } = await import("../src/agents-im-view");
    expect(isOpenConversationIntent({ agentName: "Claude Code", agentId: "cc" })).toBe(true);
    expect(isOpenConversationIntent({ agentName: "Claude Code" })).toBe(true);
    // 残缺负载宁可忽略也不乱跳：缺 agentName、agentId 类型不对都不放行。
    expect(isOpenConversationIntent({ agentId: "cc" })).toBe(false);
    expect(isOpenConversationIntent({ agentName: "", agentId: "cc" })).toBe(false);
    expect(isOpenConversationIntent({ agentName: "x", agentId: 1 })).toBe(false);
    expect(isOpenConversationIntent(null)).toBe(false);
  });

  test("ni-chat-ui 提供 attachExternalContext 落点与 external_context part 呈现", () => {
    const ui = read("packages/ni-chat-ui/src/view.ts");
    const model = read("packages/ni-chat-ui/src/model.ts");
    expect(ui).toContain("attachExternalContext(attachment: { label: string; text: string }): boolean");
    expect(model).toContain('kind: "external-context"');
    expect(model).toContain('kind: "external_context"');
  });
});
