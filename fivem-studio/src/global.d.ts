export {};

export interface StudioConfig {
  txDataPath: string | null;
  selectedProfile: string | null;
  activeCfxTarget: CfxTarget;
  legacyFivemExePath: string | null;
  enhancedFivemExePath: string | null;
  redmClientExePath: string | null;
  legacyFxServerExePath: string | null;
  enhancedFxServerExePath: string | null;
  redmFxServerExePath: string | null;
  legacyArtifactTrack: "recommended" | "latest";
  redmArtifactTrack: "recommended" | "latest";
  consoleRefreshIntervalMs: number;
  editor: EditorPreferences;
  agentProvider: "anthropic" | "openai";
  openaiBaseUrl: string;
  openaiModel: string;
}

export interface EditorPreferences {
  fontSize: number;
  wordWrap: boolean;
  minimap: boolean;
  stickyScroll: boolean;
  formatOnSave: boolean;
  luaIntelligence: "off" | "balanced" | "full";
}

export interface EditorProblem {
  path: string;
  severity: "error" | "warning" | "info" | "hint";
  message: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  source?: string;
  code?: string;
}

export interface AppUpdateStatus {
  currentVersion: string;
  latestVersion: string;
  releaseUrl: string;
  updateAvailable: boolean;
}

export type CfxTarget = "legacy" | "enhanced" | "redm";

export interface DirEntry {
  name: string;
  path: string;
  isDirectory: boolean;
}

export interface ProfileInfo {
  name: string;
  hasServerCfg: boolean;
  hasResources: boolean;
}

export interface ResolvedProfile {
  profileRoot: string;
  resourcesPath: string | null;
  serverCfgPath: string | null;
}

export interface LocalWorkspace {
  name: string;
  profileRoot: string;
  resourcesPath: string;
  serverCfgPath: string;
}

export interface EditorContext {
  path: string | null;
  selectedText: string;
  startLine: number;
  endLine: number;
}

export interface FileSnapshot {
  content: string;
  revision: string;
}

export interface RuntimeIdentity {
  contractVersion: string;
  mcp: { name: string; version: string };
  runtime: {
    serverData: { workspacePath: string; configPath: string };
    txAdmin: { dataDirectory: string | null; controlProfile: string | null };
    rcon: { host: string; port: number; configured: boolean };
  };
  capabilities: {
    console: boolean;
    resourceLifecycle: boolean;
  };
}

export interface RuntimeWorkspaceMatch {
  ok: boolean;
  reason?: string;
}

/** Mirrors TurnUsage in electron/providers/types.ts — one API response's tokens. */
export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  contextTokens: number;
  contextWindow?: number;
  costUsd?: number;
}

export type AgentEvent =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; name: string; content: string; isError: boolean }
  | {
      type: "approval_request";
      approvalId: string;
      toolCallId: string;
      name: string;
      input: unknown;
      risk: "write" | "dangerous";
      summary: string;
      filePreview?: AgentFilePreview;
      previewError?: string;
    }
  | { type: "approval_resolved"; approvalId: string; approved: boolean; reason?: string }
  | { type: "usage"; usage: TurnUsage }
  | { type: "done" }
  | { type: "error"; message: string };

export interface AgentFilePreview {
  path: string;
  originalContent: string;
  modifiedContent: string;
  originalLabel: string;
  modifiedLabel: string;
  warning?: string;
}

export interface WindowCandidate {
  id: string;
  title: string;
  processName: string;
  pid: number;
}

export interface AttachResult {
  ok: boolean;
  error?: string;
}

export interface McpToolSummary {
  name: string;
  description?: string;
}

export interface McpConnectResult {
  ok: boolean;
  error?: string;
  tools?: McpToolSummary[];
  runtimeIdentity?: RuntimeIdentity;
  workspaceMatch?: RuntimeWorkspaceMatch;
}

export interface RepoInfo {
  owner: string;
  repo: string;
  fullName: string;
  description: string | null;
  stars: number;
  language: string | null;
  license: string | null;
  htmlUrl: string;
  defaultBranch: string;
}

export interface RepoSearchResult {
  owner: string;
  repo: string;
  fullName: string;
  description: string | null;
  stars: number;
  language: string | null;
}

export interface OrganizationRepoListing {
  organization: string;
  repositories: RepoSearchResult[];
  truncated: boolean;
}

export interface CloneResult {
  ok: boolean;
  destPath?: string;
  error?: string;
}

export interface ArtifactStatus {
  flavor: "legacy" | "enhanced";
  track: "recommended" | "latest";
  build: number;
  displayName: string;
  downloadUrl: string;
  archiveSize: number | null;
  publishedAt: string | null;
  installedBuild: number | null;
  updateAvailable: boolean | null;
  recoveryNotice?: string;
}

export interface ArtifactUpdateResult extends ArtifactStatus {
  sha256: string;
  backupPath: string;
  installedAt: string;
  warning?: string;
}

// Mirrors electron/preload.ts's exposeInMainWorld("api", ...) shape.
// Kept as a hand-written duplicate (not a cross-import from electron/)
// since the renderer and electron main process are separate TS projects
// with different module targets.
declare global {
  interface Window {
    api: {
      config: {
        get(): Promise<StudioConfig>;
        set(config: StudioConfig): Promise<StudioConfig>;
      };
      fs: {
        listDir(dirPath: string): Promise<DirEntry[]>;
        readFile(filePath: string): Promise<FileSnapshot>;
        writeFile(filePath: string, content: string, expectedRevision: string): Promise<string>;
        rename(oldPath: string, newName: string): Promise<string>;
        delete(targetPath: string): Promise<void>;
        watchRoot(dirPath: string | null): Promise<void>;
        onChanged(callback: () => void): () => void;
      };
      txdata: {
        listProfiles(txDataPath: string): Promise<ProfileInfo[]>;
        resolveProfile(txDataPath: string, profile: string): Promise<ResolvedProfile>;
        createLocalWorkspace(txDataPath: string, name: string, port: number, target: CfxTarget): Promise<LocalWorkspace>;
      };
      windowEmbed: {
        listCandidates(): Promise<WindowCandidate[]>;
        attach(candidateId: string): Promise<AttachResult>;
        detach(): Promise<void>;
        setRect(x: number, y: number, width: number, height: number, visible: boolean): Promise<void>;
      };
      dialog: {
        chooseFolder(): Promise<string | null>;
        chooseExe(target: CfxTarget): Promise<string | null>;
        chooseFxServerExe(target: CfxTarget): Promise<string | null>;
      };
      mcp: {
        connect(): Promise<McpConnectResult>;
        disconnect(): Promise<void>;
        status(): Promise<{
          connected: boolean;
          url: string | null;
          runtimeIdentity: RuntimeIdentity | null;
          workspaceMatch: RuntimeWorkspaceMatch;
        }>;
        callTool(name: string, args: Record<string, unknown>): Promise<string>;
        onDropped(callback: () => void): () => void;
      };
      github: {
        fetchRepoInfo(input: string): Promise<RepoInfo>;
        searchRepos(input: string): Promise<RepoSearchResult[]>;
        listOrgRepos(input: string): Promise<OrganizationRepoListing | null>;
        cloneRepo(repoUrl: string, projectRoot: string): Promise<CloneResult>;
      };
      cfx: {
        launch(target: CfxTarget): Promise<{ ok: boolean; target: CfxTarget }>;
      };
      server: {
        status(): Promise<{ running: boolean; pids: number[]; target: CfxTarget }>;
        launch(): Promise<{ pid: number; controlProfile: string | null; alreadyRunning: boolean; target: CfxTarget; recoveryNotice?: string }>;
        stop(target: CfxTarget): Promise<{ stoppedPids: number[]; alreadyStopped: boolean; target: CfxTarget }>;
      };
      artifacts: {
        check(target: CfxTarget, track: "recommended" | "latest"): Promise<ArtifactStatus>;
        update(target: CfxTarget, track: "recommended" | "latest"): Promise<ArtifactUpdateResult>;
        recoveryNotice(): Promise<string | null>;
      };
      app: {
        setDirtyCount(count: number): Promise<void>;
        checkForUpdate(): Promise<AppUpdateStatus | null>;
      };
      lua: {
        start(): Promise<
          | {
              ok: true;
              mode: "balanced" | "full";
              workspaceRoot: string;
              libraryRoot: string;
              version: string;
            }
          | { ok: false; mode: "off" | "balanced" | "full"; error: string }
        >;
        stop(): Promise<void>;
        send(message: unknown): void;
        onMessage(callback: (message: unknown) => void): () => void;
        onStatus(callback: (status: { state: "stopped" | "error"; message?: string }) => void): () => void;
      };
      agent: {
        setApiKey(key: string): Promise<void>;
        hasApiKey(): Promise<boolean>;
        setProviderKey(baseUrl: string, key: string): Promise<void>;
        hasProviderKey(baseUrl: string): Promise<boolean>;
        listModels(
          baseUrl: string,
          keyOverride?: string,
        ): Promise<{ ok: boolean; models?: string[]; toolCapable?: Record<string, boolean>; error?: string }>;
        send(message: string): Promise<void>;
        cancel(): Promise<void>;
        respondToApproval(approvalId: string, approved: boolean): Promise<{ ok: true }>;
        reset(): Promise<void>;
        setEditorContext(context: EditorContext): Promise<void>;
        onFileWritten(callback: (absolutePath: string) => void): () => void;
        onEvent(callback: (event: AgentEvent) => void): () => void;
      };
      shell: {
        openExternal(url: string): Promise<void>;
        showItemInFolder(targetPath: string): Promise<void>;
      };
    };
  }
}
