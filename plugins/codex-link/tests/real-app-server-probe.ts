import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Message = Record<string, unknown>;

class JsonLineClient {
  private readonly process = Bun.spawn([process.env.REAI_AGENT_CODEX_BINARY ?? "codex", "app-server", "--stdio"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "reai_codex_link_probe" },
  });
  private readonly messages: Message[] = [];
  private readonly waiters = new Set<() => void>();
  private nextId = 1;
  private pumpError: unknown;

  async start(): Promise<void> {
    void this.pumpStdout();
    void this.drainStderr();
    await this.request("initialize", {
      clientInfo: { name: "reai-codex-link-probe", title: "ReAI Codex Link Probe", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    this.notify("initialized", {});
  }

  notify(method: string, params: unknown): void {
    this.write({ method, params });
  }

  async request(method: string, params: unknown, timeoutMs = 20_000): Promise<Message> {
    const id = this.nextId++;
    this.write({ id, method, params });
    const response = await this.waitFor(
      (message) => message.id === id && ("result" in message || "error" in message),
      timeoutMs,
    );
    if (response.error) throw new Error(`${method} failed: ${JSON.stringify(response.error)}`);
    return response;
  }

  async waitFor(predicate: (message: Message) => boolean, timeoutMs: number): Promise<Message> {
    const find = () => this.messages.find(predicate);
    const existing = find();
    if (existing) return existing;
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      if (this.pumpError) throw this.pumpError;
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          this.waiters.delete(wake);
          resolve();
        }, Math.min(250, timeoutMs));
        const wake = () => {
          clearTimeout(timeout);
          this.waiters.delete(wake);
          resolve();
        };
        this.waiters.add(wake);
      });
      const found = find();
      if (found) return found;
    }
    throw new Error(`timed out after ${timeoutMs}ms; last messages=${JSON.stringify(this.messages.slice(-8))}`);
  }

  allMessages(): readonly Message[] {
    return this.messages;
  }

  async stop(): Promise<void> {
    this.process.kill();
    await Promise.race([this.process.exited, Bun.sleep(2_000)]);
  }

  private write(message: Message): void {
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
    this.process.stdin.flush();
  }

  private async pumpStdout(): Promise<void> {
    const reader = this.process.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line) {
            this.messages.push(JSON.parse(line) as Message);
            for (const wake of [...this.waiters]) wake();
          }
          newline = buffer.indexOf("\n");
        }
      }
    } catch (cause) {
      this.pumpError = cause;
      for (const wake of [...this.waiters]) wake();
    }
  }

  private async drainStderr(): Promise<void> {
    const reader = this.process.stderr.getReader();
    while (!(await reader.read()).done) {
      // app-server diagnostics are intentionally drained so the child cannot block on stderr.
    }
  }
}

async function listThreads(): Promise<void> {
  const client = new JsonLineClient();
  try {
    await client.start();
    const response = await client.request("thread/list", { limit: 10 });
    const modes = await client.request("collaborationMode/list", {});
    const data = (response.result as { data?: unknown[] } | undefined)?.data ?? [];
    console.log(
      JSON.stringify(
        {
          probe: "thread-list",
          count: data.length,
          threads: data.map((thread) => {
            const value = thread as { id?: string; updatedAt?: number; cwd?: string; preview?: string };
            return { id: value.id, updatedAt: value.updatedAt, cwd: value.cwd, preview: value.preview?.slice(0, 80) };
          }),
          collaborationModes: modes.result,
        },
        null,
        2,
      ),
    );
  } finally {
    await client.stop();
  }
}

async function listModels(): Promise<void> {
  const client = new JsonLineClient();
  try {
    await client.start();
    const response = await client.request("model/list", { limit: 100, includeHidden: false });
    const rows = (response.result as { data?: unknown[] } | undefined)?.data ?? [];
    console.log(JSON.stringify({ probe: "model-list", models: rows }, null, 2));
  } finally {
    await client.stop();
  }
}

async function readAccountState(): Promise<void> {
  const client = new JsonLineClient();
  try {
    await client.start();
    const accountResponse = await client.request("account/read", { refreshToken: false });
    const rateLimits = await client.request("account/rateLimits/read", {});
    const usage = await client.request("account/usage/read", {});
    const account = (accountResponse.result as { account?: Record<string, unknown> | null } | undefined)?.account;
    console.log(
      JSON.stringify({
        probe: "account-state",
        loggedIn: Boolean(account),
        accountType: account?.type ?? null,
        planType: account?.planType ?? null,
        rateLimitsAvailable: Boolean(rateLimits.result),
        usageAvailable: Boolean(usage.result),
      }),
    );
  } finally {
    await client.stop();
  }
}

async function interruptWaitingTurn(): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), "reai-codex-interrupt-probe-"));
  const client = new JsonLineClient();
  try {
    await client.start();
    const threadResponse = await client.request("thread/start", {
      cwd,
      ephemeral: true,
      approvalPolicy: "never",
      sandbox: "read-only",
      developerInstructions:
        "Protocol probe only. Do not inspect or modify files. Immediately call request_user_input with one yes/no question, then wait.",
    });
    const threadId = (threadResponse.result as { thread?: { id?: string } }).thread?.id;
    if (!threadId) throw new Error(`thread/start missing thread.id: ${JSON.stringify(threadResponse)}`);

    const turnResponse = await client.request("turn/start", {
      threadId,
      collaborationMode: {
        mode: "plan",
        settings: {
          model: "gpt-5.6-sol",
          reasoning_effort: "low",
          developer_instructions:
            "Protocol probe only. Immediately call request_user_input with one yes/no question. Do not inspect files or answer directly.",
        },
      },
      input: [
        {
          type: "text",
          text: "Codex Link interrupt probe. Immediately ask one blocking request_user_input question. Do nothing else.",
        },
      ],
    });
    const turnId = (turnResponse.result as { turn?: { id?: string } }).turn?.id;
    if (!turnId) throw new Error(`turn/start missing turn.id: ${JSON.stringify(turnResponse)}`);

    const pending = await client.waitFor(
      (message) =>
        message.method === "item/tool/requestUserInput" &&
        (message.params as { threadId?: string } | undefined)?.threadId === threadId,
      90_000,
    );
    const serverRequestId = pending.id;
    const interruptResponse = await client.request("turn/interrupt", { threadId, turnId }, 20_000);

    let completed: Message | undefined;
    let resolved: Message | undefined;
    try {
      completed = await client.waitFor(
        (message) =>
          message.method === "turn/completed" &&
          (message.params as { threadId?: string; turn?: { id?: string } } | undefined)?.threadId === threadId &&
          (message.params as { turn?: { id?: string } } | undefined)?.turn?.id === turnId,
        15_000,
      );
    } catch {
      // Absence is an explicit probe result, not a harness failure.
    }
    try {
      resolved = await client.waitFor(
        (message) =>
          message.method === "serverRequest/resolved" &&
          (message.params as { requestId?: unknown } | undefined)?.requestId === serverRequestId,
        2_000,
      );
    } catch {
      // Absence is an explicit probe result, not a harness failure.
    }

    console.log(
      JSON.stringify(
        {
          probe: "interrupt-waiting-turn",
          threadId,
          turnId,
          serverRequestId,
          interruptRpc: interruptResponse.result ?? null,
          requestResolved: Boolean(resolved),
          terminalNotification: completed?.params ?? null,
          disposition: completed
            ? "rpc-and-terminal-notification"
            : "rpc-success-without-terminal-notification",
        },
        null,
        2,
      ),
    );
  } finally {
    await client.stop();
    await rm(cwd, { recursive: true, force: true });
  }
}

const mode = process.argv[2];
if (mode === "list") {
  await listThreads();
} else if (mode === "models") {
  await listModels();
} else if (mode === "account") {
  await readAccountState();
} else if (mode === "interrupt") {
  await interruptWaitingTurn();
} else {
  console.error("usage: bun tests/real-app-server-probe.ts <list|models|account|interrupt>");
  process.exitCode = 2;
}
