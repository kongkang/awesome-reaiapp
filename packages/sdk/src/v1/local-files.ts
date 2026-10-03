export interface LocalWorkspace {
  id: string;
  name: string;
  grantedAt: number;
}

export interface LocalDirectoryEntry {
  name: string;
  path: string;
  kind: "directory" | "file";
  size?: number;
  modifiedAt?: number;
}

export interface LocalTextDocument {
  workspaceId: string;
  path: string;
  content: string;
  revision: string;
  size: number;
  modifiedAt?: number;
}

export interface LocalFilesClient {
  pickWorkspace(): Promise<LocalWorkspace | undefined>;
  listWorkspaces(): Promise<LocalWorkspace[]>;
  revokeWorkspace(workspaceId: string): Promise<void>;
  listDirectory(
    workspaceId: string,
    path?: string,
  ): Promise<{ entries: LocalDirectoryEntry[]; truncated: boolean }>;
  readDocument(workspaceId: string, path: string): Promise<LocalTextDocument>;
  writeDocument(options: {
    workspaceId: string;
    path: string;
    content: string;
    expectedRevision: string;
  }): Promise<Omit<LocalTextDocument, "content">>;
  claimHandoff(token: string): Promise<{ workspaceId: string; path: string; expiresAt: number }>;
}
