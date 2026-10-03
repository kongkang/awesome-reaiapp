/** Model-facing arguments for the Agent `run` tool; not a direct plugin exec API.
 * Requires macOS, a mounted workspace, yolo mode, and independently approved
 * `local.terminal.exec@1` capability + matching user permission.
 */
export interface AgentRunArguments {
  program: "awk" | "wc" | "sort" | "diff";
  /** Narrow flags + mirror-relative existing file paths. awk requires -f <script>. */
  args: string[];
  /** Mirror-relative directory, default ".". Traversal and symlinks are rejected. */
  cwdRelative?: string;
  /** 1..30000 milliseconds; default 10000. */
  timeoutMs?: number;
}
export interface AgentRunOutput {
  program: AgentRunArguments["program"];
  exitCode: number | null;
  /** Each stream is capped at 64 KiB. Overflow kills execution and returns failure. */
  stdout: string;
  stderr: string;
  truncated: false;
}
