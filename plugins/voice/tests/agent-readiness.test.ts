import { describe, expect, test } from "bun:test";
import type { AgentBackendStatus } from "@reai/app-sdk/v1";
import { agentReadiness } from "../src/agent-readiness";
import manifest from "../app.manifest.json";

const status = (backend: AgentBackendStatus["backend"], available = false, downloadRequired = true): AgentBackendStatus =>
  ({ backend, available, downloadRequired, detail: "" });

describe("Voice respects Host selection and per-app runtime access", () => {
  test("a shared Pi process cannot pass readiness without Voice access; remediation uses Host DSH-first order", () => {
    const dsh = status("dsh");
    expect(agentReadiness("auto", { backends: [status("pi", true), dsh] })).toEqual({ kind: "blocked", status: dsh });
  });

  test("auto can use one ready backend without requiring every optional runtime", () => {
    expect(agentReadiness("auto", { backends: [status("pi"), status("dsh", true, false), status("codex")] }))
      .toEqual({ kind: "ready", backend: "dsh" });
  });

  test("Host's explicit default cannot silently fall back to another ready runtime", () => {
    const pi = status("pi");
    const backends = [pi, status("dsh", true, false), status("codex")];
    expect(agentReadiness("auto", { backends, defaultBackend: "pi" })).toEqual({ kind: "blocked", status: pi });
    expect(agentReadiness("dsh", { backends, defaultBackend: "pi" })).toEqual({ kind: "ready", backend: "dsh" });
  });

  test("corrupt Host preferences block auto, but do not override an explicit plugin selection", () => {
    const snapshot = { backends: [status("dsh", true, false)], defaultBackendError: "AGENT_PREFERENCE_INVALID" };
    expect(agentReadiness("auto", snapshot)).toEqual({ kind: "preference-invalid" });
    expect(agentReadiness("dsh", snapshot)).toEqual({ kind: "ready", backend: "dsh" });
  });

  test("Codex default has a consent-gated optional requirement so the Host can grant Voice access", () => {
    const codex = status("codex");
    expect(agentReadiness("auto", { backends: [status("dsh", true, false), codex], defaultBackend: "codex" }))
      .toEqual({ kind: "blocked", status: codex });
    const requirement = manifest.requirements.find((item) => item.provision.resourceId === "com.reai.runtime.codex");
    expect(requirement).toMatchObject({
      required: false,
      requiredFor: ["capability:agent.session@1", "capability:agent.session@2"],
      provision: { installPolicy: "optional_on_demand", requiresConsent: true },
    });
    expect(agentReadiness("auto", { backends: [status("codex", true, false)], defaultBackend: "codex" }))
      .toEqual({ kind: "ready", backend: "codex" });
  });

  test("unknown or absent backend status stays blocked; a runtime fault is not recast as installation", () => {
    expect(agentReadiness("dsh", { backends: [status("pi", true, false)] })).toEqual({ kind: "blocked", status: undefined });
    expect(agentReadiness("auto", { backends: [] })).toEqual({ kind: "blocked", status: undefined });
    const broken = status("dsh", false, false);
    expect(agentReadiness("dsh", { backends: [broken, status("pi")] })).toEqual({ kind: "blocked", status: broken });
  });
});
