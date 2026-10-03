/** `terminal.session@1` —— Host 托管的交互式 Shell 会话。 */

export interface TerminalSessionInfo {
  id: string;
  sequence: number;
  cwd: string;
}

export interface TerminalAttachment {
  token: string;
  replayBase64: string;
  truncated: boolean;
  sequence: number;
}

export type TerminalSessionEvent =
  | {
      kind: "output";
      sessionId: string;
      attachmentToken: string;
      sequence: number;
      dataBase64: string;
    }
  | {
      kind: "output_lost";
      sessionId: string;
      attachmentToken: string;
      sequence: number;
      code: "TERMINAL_OUTPUT_LOST";
    }
  | {
      kind: "closed";
      sessionId: string;
      attachmentToken: string;
      sequence: number;
    };

export interface TerminalSessionClient {
  create(options: { rows: number; cols: number; cwd?: string }): Promise<TerminalSessionInfo>;
  list(): Promise<TerminalSessionInfo[]>;
  attach(sessionId: string): Promise<TerminalAttachment>;
  detach(sessionId: string, attachmentToken: string): Promise<void>;
  write(sessionId: string, data: Uint8Array): Promise<void>;
  resize(sessionId: string, rows: number, cols: number): Promise<void>;
  restart(sessionId: string, rows: number, cols: number): Promise<TerminalSessionInfo>;
  close(sessionId: string): Promise<void>;
  onEvent(handler: (event: TerminalSessionEvent) => void): void;
}
