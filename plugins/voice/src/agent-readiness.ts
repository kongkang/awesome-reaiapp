import type { AgentBackend, AgentBackendStatus, AgentSessionClient } from "@reai/app-sdk/v1";

type BackendSnapshot = Awaited<ReturnType<AgentSessionClient["backends"]>>;
export type AgentReadiness =
  | { kind: "ready"; backend: AgentBackendStatus["backend"] }
  | { kind: "preference-invalid" }
  | { kind: "blocked"; status?: AgentBackendStatus };

/** Match Host's new-session selection; shared installation alone never grants Voice access. */
export function agentReadiness(requested: AgentBackend, snapshot: BackendSnapshot): AgentReadiness {
  if (requested === "auto" && snapshot.defaultBackendError) return { kind: "preference-invalid" };
  const effective = requested === "auto" ? snapshot.defaultBackend ?? "auto" : requested;
  const candidates = effective === "auto"
    ? (["dsh", "pi", "codex"] as const).flatMap((backend) =>
      snapshot.backends.filter((status) => status.backend === backend))
    : snapshot.backends.filter((status) => status.backend === effective);
  const ready = candidates.find((status) => status.available && status.downloadRequired !== true);
  if (ready) return { kind: "ready", backend: ready.backend };
  return { kind: "blocked", status: candidates.find((status) => status.downloadRequired) ?? candidates[0] };
}
