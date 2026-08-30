import { useEffect, useState, useCallback, useRef } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";

import TopBar from "./components/TopBar";
import SettingsModal from "./components/SettingsModal";
import ResourceTree from "./components/ResourceTree";
import SearchPanel from "./components/SearchPanel";
import GithubImportPanel from "./components/GithubImportPanel";
import CenterPane, { type CenterTab } from "./components/CenterPane";
import ChatPanel from "./components/ChatPanel";
import StatusArea, { type StatusItem } from "./components/StatusArea";
import WhatsNewPanel from "./components/WhatsNewPanel";
import { t } from "./i18n";
import { lastConsoleLines } from "./consoleText";
import type {
  AppUpdateStatus,
  CfxTarget,
  CrashTriageContext,
  EditorProblem,
  ResolvedProfile,
  ResolvedTheme,
  RecentWorkspaceSummary,
  ResourceContext,
  ResourceDependencyGraph,
  ResourceStatusResult,
  RuntimeIdentity,
  RuntimeWorkspaceMatch,
  StudioConfig,
  WhatsNewState,
} from "./global";

export interface OpenFile {
  path: string;
  content: string;
  revision: string;
  dirty: boolean;
}

export interface FileChangeReview {
  id: number;
  path: string;
  kind: "agent" | "conflict";
  originalContent: string;
  modifiedContent: string;
  originalLabel: string;
  modifiedLabel: string;
  diskRevision: string;
}

type SidebarTab = "resources" | "search" | "github";

const DEFAULT_CONFIG: StudioConfig = {
  txDataPath: null,
  selectedProfile: null,
  theme: "system",
  uiScale: 1,
  activeCfxTarget: "legacy",
  legacyFivemExePath: null,
  enhancedFivemExePath: null,
  redmClientExePath: null,
  legacyFxServerExePath: null,
  enhancedFxServerExePath: null,
  redmFxServerExePath: null,
  legacyArtifactTrack: "recommended",
  redmArtifactTrack: "recommended",
  consoleRefreshIntervalMs: 2_000,
  notifyOnServerExit: true,
  agentSpendWarningUsd: 5,
  editor: {
    fontSize: 13,
    wordWrap: false,
    minimap: false,
    stickyScroll: true,
    formatOnSave: false,
    restartResourceOnSave: false,
    luaIntelligence: "balanced",
  },
  agentProvider: "openai",
  openaiBaseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",
  openaiModel: "gemini-3.7-flash",
};

const EMPTY_PROFILE: ResolvedProfile = { profileRoot: "", resourcesPath: null, serverCfgPath: null };

function cfxTargetLabel(target: CfxTarget): string {
  if (target === "legacy") return "FiveM Legacy";
  if (target === "enhanced") return "FiveM Enhanced";
  return "RedM";
}

function serverExeFor(config: StudioConfig, target: CfxTarget): string | null {
  if (target === "legacy") return config.legacyFxServerExePath;
  if (target === "enhanced") return config.enhancedFxServerExePath;
  return config.redmFxServerExePath;
}

function clientExeFor(config: StudioConfig, target: CfxTarget): string | null {
  if (target === "legacy") return config.legacyFivemExePath;
  if (target === "enhanced") return config.enhancedFivemExePath;
  return config.redmClientExePath;
}

export default function App() {
  const [config, setConfig] = useState<StudioConfig>(DEFAULT_CONFIG);
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>("dark");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [connected, setConnected] = useState(false);
  const [configLoaded, setConfigLoaded] = useState(false);
  const [recentWorkspaces, setRecentWorkspaces] = useState<RecentWorkspaceSummary[]>([]);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [runtimeIdentity, setRuntimeIdentity] = useState<RuntimeIdentity | null>(null);
  const [workspaceMatch, setWorkspaceMatch] = useState<RuntimeWorkspaceMatch | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [serverAction, setServerAction] = useState<"starting" | "stopping" | null>(null);
  const [serverRunning, setServerRunning] = useState(false);
  const [serverPids, setServerPids] = useState<number[]>([]);
  const [serverTarget, setServerTarget] = useState<CfxTarget>("legacy");
  const [serverStartedAt, setServerStartedAt] = useState<number | null>(null);
  const [serverStatusError, setServerStatusError] = useState<string | null>(null);
  const [serverNotice, setServerNotice] = useState<{ message: string; error: boolean } | null>(null);
  const [artifactNotice, setArtifactNotice] = useState<string | null>(null);
  const [availableUpdate, setAvailableUpdate] = useState<AppUpdateStatus | null>(null);
  const [whatsNew, setWhatsNew] = useState<WhatsNewState | null>(null);
  const serverStatusEpoch = useRef(0);
  const observedServerRunning = useRef<boolean | null>(null);
  const intentionalServerStop = useRef(false);
  const latestConsoleOutput = useRef("");
  const [crashTriage, setCrashTriage] = useState<CrashTriageContext | null>(null);
  const [agentPrompt, setAgentPrompt] = useState<{ text: string; nonce: number } | null>(null);

  const [sidebarTab, setSidebarTab] = useState<SidebarTab>("resources");
  const [treeRefreshKey, setTreeRefreshKey] = useState(0);
  const [resourceStatuses, setResourceStatuses] = useState<ResourceStatusResult>({
    resources: [],
    serverStateAvailable: false,
  });
  const [dependencyGraph, setDependencyGraph] = useState<ResourceDependencyGraph>({ nodes: [] });
  const [resourceAction, setResourceAction] = useState<string | null>(null);
  const [resourceNotice, setResourceNotice] = useState<{ message: string; error: boolean } | null>(null);
  const [activeResourceContext, setActiveResourceContext] = useState<ResourceContext | null>(null);
  const [consoleRefreshSignal, setConsoleRefreshSignal] = useState<{ resource: string; nonce: number } | null>(null);
  const resourceStatusRequest = useRef<{ scope: string; promise: Promise<void> } | null>(null);
  const resourceStatusSequence = useRef(0);

  const [resolved, setResolved] = useState<ResolvedProfile>(EMPTY_PROFILE);

  const [openFiles, setOpenFiles] = useState<OpenFile[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  // Viewport, not editor: with no files open yet, defaulting to "editor" leaves the
  // tab strip with nothing highlighted and an empty pane, which reads as a broken state.
  const [centerTab, setCenterTab] = useState<CenterTab>("viewport");
  const [selection, setSelection] = useState({ selectedText: "", startLine: 0, endLine: 0 });
  const [editorProblems, setEditorProblems] = useState<Record<string, EditorProblem[]>>({});
  const [editorReveal, setEditorReveal] = useState<{ path: string; line: number; column: number; nonce: number } | null>(null);
  const [changeReviews, setChangeReviews] = useState<Record<string, FileChangeReview>>({});
  const [reviewPath, setReviewPath] = useState<string | null>(null);
  const reviewNonce = useRef(0);
  const activeServerPath = serverExeFor(config, config.activeCfxTarget);
  const activeClientPath = clientExeFor(config, config.activeCfxTarget);
  const activeTargetLabel = cfxTargetLabel(config.activeCfxTarget);
  const runtimeReadable = connected && workspaceMatch?.ok === true;
  const runtimeWritable = runtimeReadable && runtimeIdentity?.capabilities.resourceLifecycle === true;
  const resourceStates = Object.fromEntries(
    resourceStatuses.resources.map((resource) => [resource.name.toLowerCase(), resource.state]),
  ) as Record<string, "started" | "stopped">;
  const resourceStatusScope = [
    connected ? "connected" : "disconnected",
    config.txDataPath ?? "",
    config.selectedProfile ?? "",
    runtimeIdentity?.runtime.serverData.workspacePath ?? "",
  ].join("|");
  const resourceStatusScopeRef = useRef(resourceStatusScope);
  resourceStatusScopeRef.current = resourceStatusScope;

  const connect = useCallback(async () => {
    setConnectError(null);
    try {
      const result = await window.api.mcp.connect();
      setConnected(result.ok);
      setRuntimeIdentity(result.runtimeIdentity ?? null);
      setWorkspaceMatch(result.workspaceMatch ?? null);
      if (!result.ok) setConnectError(result.error ?? "Could not connect");
      return result.ok;
    } catch (err) {
      setConnected(false);
      setRuntimeIdentity(null);
      setWorkspaceMatch(null);
      setConnectError((err as Error).message || "Could not connect");
      return false;
    }
  }, []);

  const refreshResourceStatuses = useCallback((force = false): Promise<void> => {
    if (!connected || workspaceMatch?.ok !== true) return Promise.resolve();
    const existing = resourceStatusRequest.current;
    if (!force && existing?.scope === resourceStatusScope) return existing.promise;

    const sequence = ++resourceStatusSequence.current;
    const request = window.api.resources.listStatuses()
      .then((status) => {
        if (resourceStatusScopeRef.current === resourceStatusScope && resourceStatusSequence.current === sequence) {
          setResourceStatuses(status);
        }
      })
      .catch(() => {
        // Connection state owns the visible failure. Status polling stays quiet
        // while the runtime is starting or the local server is temporarily down.
      })
      .finally(() => {
        if (resourceStatusRequest.current?.promise === request) resourceStatusRequest.current = null;
      });
    resourceStatusRequest.current = { scope: resourceStatusScope, promise: request };
    return request;
  }, [connected, resourceStatusScope, workspaceMatch?.ok]);

  // Load saved config, then try connecting automatically.
  useEffect(() => {
    void window.api.config
      .get()
      .then((saved) => {
        setConfig(saved);
        setConfigLoaded(true);
        void window.api.recents.list().then(setRecentWorkspaces).catch(() => setRecentWorkspaces([]));
        void window.api.artifacts.recoveryNotice().then((notice) => notice && setArtifactNotice(notice));
        if (saved.txDataPath && saved.selectedProfile) {
          void connect();
        } else {
          setSettingsOpen(true);
        }
      })
      .catch((err) => {
        setConfigLoaded(true);
        setConnectError(`Could not load settings: ${(err as Error).message}`);
      });
  }, [connect]);

  useEffect(() => {
    let cancelled = false;
    const applySystemTheme = (theme: "dark" | "light") => {
      if (!cancelled && config.theme === "system") setResolvedTheme(theme);
    };
    if (config.theme === "system") {
      void window.api.theme.system().then(applySystemTheme).catch(() => applySystemTheme("dark"));
    } else {
      setResolvedTheme(config.theme);
    }
    const unsubscribe = window.api.theme.onSystemChanged(applySystemTheme);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [config.theme]);

  useEffect(() => {
    document.documentElement.dataset.theme = resolvedTheme;
    document.documentElement.style.colorScheme = resolvedTheme === "light" ? "light" : "dark";
  }, [resolvedTheme]);

  // This is intentionally notification-only. Installation remains an explicit
  // choice on the signed GitHub release page, and development builds skip the request.
  useEffect(() => {
    let cancelled = false;
    void window.api.app.checkForUpdate()
      .then((status) => {
        if (!cancelled && status?.updateAvailable) setAvailableUpdate(status);
      })
      .catch(() => {
        // Updates are advisory; offline/rate-limited starts must remain quiet and usable.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    void window.api.app.consumeWhatsNew().then(setWhatsNew).catch(() => setWhatsNew(null));
  }, []);

  const refreshServerStatus = useCallback(async (
    expectedEpoch = serverStatusEpoch.current,
    shouldApply: () => boolean = () => true,
  ) => {
    const isCurrent = () => shouldApply() && expectedEpoch === serverStatusEpoch.current;
    if (!config.legacyFxServerExePath && !config.enhancedFxServerExePath && !config.redmFxServerExePath) {
      if (!isCurrent()) return;
      setServerRunning(false);
      setServerPids([]);
      setServerTarget(config.activeCfxTarget);
      setServerStatusError(null);
      return;
    }
    try {
      const status = await window.api.server.status();
      if (!isCurrent()) return;
      const wasRunning = observedServerRunning.current;
      observedServerRunning.current = status.running;
      if (status.running && wasRunning !== true) setServerStartedAt(Date.now());
      if (!status.running) setServerStartedAt(null);
      if (wasRunning === true && !status.running) {
        const wasIntentional = intentionalServerStop.current;
        intentionalServerStop.current = false;
        if (!wasIntentional) {
          const consoleTail = lastConsoleLines(latestConsoleOutput.current, 50);
          void window.api.server.crashReport()
            .then((report) => setCrashTriage({ report, consoleTail, detectedAt: new Date().toISOString() }))
            .catch(() => setCrashTriage({ report: null, consoleTail, detectedAt: new Date().toISOString() }));
          void window.api.server.notifyUnexpectedExit(status.target).catch(() => {
            // Desktop notifications are advisory; the in-app crash context remains available.
          });
          setServerNotice({ message: `${cfxTargetLabel(status.target)} FXServer stopped unexpectedly. Review the crash context in Console.`, error: true });
        }
      }
      setServerRunning(status.running);
      setServerPids(status.pids);
      setServerTarget(status.target);
      setServerStatusError(null);
    } catch (err) {
      if (!isCurrent()) return;
      setServerStatusError((err as Error).message || "Server status is unavailable.");
    }
  }, [config.activeCfxTarget, config.legacyFxServerExePath, config.enhancedFxServerExePath, config.redmFxServerExePath]);

  // FXServer runs in the background. Poll the exact configured executable so
  // the top-bar control remains truthful after a restart or a stop initiated
  // in txAdmin.
  useEffect(() => {
    if (!configLoaded) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      const expectedEpoch = serverStatusEpoch.current;
      await refreshServerStatus(expectedEpoch, () => !cancelled);
      if (!cancelled) timer = setTimeout(poll, 5_000);
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [configLoaded, refreshServerStatus]);

  // The server is often started after Studio, so a failed connect can't be
  // terminal — keep retrying quietly in the background until it comes up.
  useEffect(() => {
    if (!configLoaded || connected || !config.txDataPath || !config.selectedProfile) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const retry = async () => {
      if (cancelled) return;
      const ok = await connect();
      if (!cancelled && !ok) timer = setTimeout(retry, 3000);
    };
    timer = setTimeout(retry, 3000);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [configLoaded, config.txDataPath, config.selectedProfile, connected, connect]);

  // If the transport drops (server stopped), flip back to disconnected — which
  // re-arms the retry loop above.
  useEffect(() => {
    return window.api.mcp.onDropped(() => {
      setConnected(false);
      setRuntimeIdentity(null);
      setWorkspaceMatch(null);
      setResourceStatuses({ resources: [], serverStateAvailable: false });
      setConnectError("Lost connection to the bundled coding runtime.");
    });
  }, []);

  // Resource state is shared by the tree and editor controls. Keep one
  // visibility-aware poll rather than letting each view query FXServer itself.
  useEffect(() => {
    if (!runtimeReadable) {
      setResourceStatuses({ resources: [], serverStateAvailable: false });
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      if (document.visibilityState !== "hidden") await refreshResourceStatuses();
      if (!cancelled) timer = setTimeout(poll, 5_000);
    };
    const onVisibilityChange = () => {
      if (document.visibilityState !== "hidden") void refreshResourceStatuses();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [refreshResourceStatuses, runtimeReadable]);

  // Resolve the selected profile's resources/ and server.cfg paths whenever
  // the txData root or chosen profile changes, and point the live filesystem
  // watcher at that profile's folder so external changes (Explorer moves,
  // renames, etc.) get picked up automatically.
  useEffect(() => {
    if (!config.txDataPath || !config.selectedProfile) {
      setResolved(EMPTY_PROFILE);
      window.api.fs.watchRoot(null);
      return;
    }
    window.api.txdata.resolveProfile(config.txDataPath, config.selectedProfile).then((r) => {
      setResolved(r);
      window.api.fs.watchRoot(r.profileRoot);
    });
  }, [config.txDataPath, config.selectedProfile]);

  useEffect(() => {
    if (!resolved.resourcesPath) {
      setDependencyGraph({ nodes: [] });
      return;
    }
    let cancelled = false;
    void window.api.resources.dependencyGraph()
      .then((graph) => { if (!cancelled) setDependencyGraph(graph); })
      .catch(() => { if (!cancelled) setDependencyGraph({ nodes: [] }); });
    return () => { cancelled = true; };
  }, [resolved.resourcesPath, treeRefreshKey]);

  // Bump the tree refresh token whenever the watcher reports a change.
  useEffect(() => {
    return window.api.fs.onChanged(() => {
      setTreeRefreshKey((k) => k + 1);
      void refreshResourceStatuses();
    });
  }, [refreshResourceStatuses]);

  useEffect(() => {
    let cancelled = false;
    if (!activePath) {
      setActiveResourceContext(null);
      return;
    }
    void window.api.resources.context(activePath)
      .then((context) => {
        if (!cancelled) setActiveResourceContext(context);
      })
      .catch(() => {
        if (!cancelled) setActiveResourceContext(null);
      });
    return () => {
      cancelled = true;
    };
  }, [activePath, resolved.resourcesPath]);

  // Keep the main process informed about unsaved work so it can warn on quit.
  useEffect(() => {
    window.api.app.setDirtyCount(openFiles.filter((f) => f.dirty).length);
  }, [openFiles]);

  // A selection belongs to one editor model. Switching files or leaving the editor
  // must not leave a stale snippet attached to the next agent request.
  useEffect(() => {
    setSelection({ selectedText: "", startLine: 0, endLine: 0 });
  }, [activePath, centerTab]);

  // Keep the agent's view of the editor current: which file is open and what's selected.
  // Non-editor tabs deliberately expose neither a path nor a previous selection.
  useEffect(() => {
    void window.api.agent.setEditorContext({ path: centerTab === "editor" ? activePath : null, ...selection }).catch(() => {
      // Context is advisory; a later editor move will retry it and chat remains usable.
    });
  }, [activePath, centerTab, selection]);

  // The agent can edit files directly. Reload a clean open buffer and retain a
  // reviewable before/after snapshot. If the user also has unsaved edits, leave
  // both versions untouched and open an explicit conflict review.
  useEffect(() => {
    return window.api.agent.onFileWritten(async (absolutePath) => {
      setTreeRefreshKey((k) => k + 1);
      const open = openFiles.find((f) => f.path === absolutePath);
      if (!open) return;
      try {
        const snapshot = await window.api.fs.readFile(absolutePath);
        if (snapshot.content === open.content) {
          if (!open.dirty) {
            setOpenFiles((files) => files.map((f) => f.path === absolutePath ? { ...f, revision: snapshot.revision } : f));
          }
          return;
        }
        const review: FileChangeReview = {
          id: ++reviewNonce.current,
          path: absolutePath,
          kind: open.dirty ? "conflict" : "agent",
          originalContent: open.content,
          modifiedContent: snapshot.content,
          originalLabel: open.dirty ? "Your unsaved editor version" : "Before agent change",
          modifiedLabel: open.dirty ? "Agent version on disk" : "Agent change now in editor",
          diskRevision: snapshot.revision,
        };
        setChangeReviews((current) => ({ ...current, [absolutePath]: review }));
        if (open.dirty) {
          setActivePath(absolutePath);
          setCenterTab("editor");
          setReviewPath(absolutePath);
        } else {
          setOpenFiles((files) => files.map((f) =>
            f.path === absolutePath ? { ...f, ...snapshot, dirty: false } : f,
          ));
        }
      } catch {
        // file may have been removed again — the tree refresh above covers it
      }
    });
  }, [openFiles]);

  async function handleSaveSettings(next: StudioConfig) {
    const profileChanged = next.txDataPath !== config.txDataPath || next.selectedProfile !== config.selectedProfile;
    const dirtyCount = openFiles.filter((file) => file.dirty).length;
    if (
      profileChanged &&
      dirtyCount > 0 &&
      !confirm(
        `Switch profiles and discard unsaved changes in ${dirtyCount} open ${dirtyCount === 1 ? "file" : "files"}?`,
      )
    ) {
      throw new Error("Profile switch cancelled; your unsaved editor tabs are still open.");
    }
    const saved = await window.api.config.set(next);
    if (
      saved.activeCfxTarget !== config.activeCfxTarget ||
      saved.legacyFxServerExePath !== config.legacyFxServerExePath ||
      saved.enhancedFxServerExePath !== config.enhancedFxServerExePath ||
      saved.redmFxServerExePath !== config.redmFxServerExePath ||
      saved.txDataPath !== config.txDataPath ||
      saved.selectedProfile !== config.selectedProfile
    ) {
      serverStatusEpoch.current += 1;
    }
    setConfig(saved);
    void window.api.recents.list().then(setRecentWorkspaces).catch(() => setRecentWorkspaces([]));
    if (profileChanged) {
      setOpenFiles([]);
      setActivePath(null);
      setCenterTab("viewport");
      setEditorProblems({});
      setEditorReveal(null);
      setChangeReviews({});
      setReviewPath(null);
    }
    setTreeRefreshKey((k) => k + 1);
    if (saved.txDataPath && saved.selectedProfile) {
      await connect();
    } else {
      setConnected(false);
      setRuntimeIdentity(null);
      setWorkspaceMatch(null);
      setConnectError(null);
    }
  }

  async function handleConsoleRefreshIntervalChange(intervalMs: number) {
    const saved = await window.api.config.set({ ...config, consoleRefreshIntervalMs: intervalMs });
    setConfig(saved);
  }

  async function switchRecentWorkspace(id: string) {
    const dirtyCount = openFiles.filter((file) => file.dirty).length;
    const allowDiscard = dirtyCount > 0 && confirm(
      `Switch workspaces and discard unsaved changes in ${dirtyCount} open ${dirtyCount === 1 ? "file" : "files"}?`,
    );
    if (dirtyCount > 0 && !allowDiscard) return;
    try {
      serverStatusEpoch.current += 1;
      const saved = await window.api.recents.select(id, allowDiscard);
      setConfig(saved);
      setConnected(false);
      setRuntimeIdentity(null);
      setWorkspaceMatch(null);
      setOpenFiles([]);
      setActivePath(null);
      setCenterTab("viewport");
      setEditorProblems({});
      setEditorReveal(null);
      setChangeReviews({});
      setReviewPath(null);
      setTreeRefreshKey((key) => key + 1);
      setRecentWorkspaces(await window.api.recents.list());
      await connect();
    } catch (error) {
      setSaveError(`Could not switch workspaces: ${(error as Error).message}`);
    }
  }

  async function openFile(path: string): Promise<boolean> {
    if (openFiles.some((f) => f.path === path)) {
      setActivePath(path);
      setCenterTab("editor");
      return true;
    }
    try {
      const snapshot = await window.api.fs.readFile(path);
      setOpenFiles((files) => [...files, { path, ...snapshot, dirty: false }]);
      setActivePath(path);
      setCenterTab("editor");
      return true;
    } catch (err) {
      alert((err as Error).message);
      return false;
    }
  }

  function handleEditorProblems(path: string, problems: EditorProblem[]) {
    setEditorProblems((current) => {
      if (problems.length === 0) {
        if (!(path in current)) return current;
        const next = { ...current };
        delete next[path];
        return next;
      }
      const previous = current[path];
      if (
        previous?.length === problems.length &&
        previous.every((problem, index) => {
          const next = problems[index];
          return problem.severity === next.severity && problem.message === next.message &&
            problem.line === next.line && problem.column === next.column &&
            problem.endLine === next.endLine && problem.endColumn === next.endColumn &&
            problem.source === next.source && problem.code === next.code;
        })
      ) return current;
      return { ...current, [path]: problems };
    });
  }

  async function openEditorLocation(path: string, line: number, column: number) {
    if (!await openFile(path)) return;
    setEditorReveal((current) => ({
      path,
      line,
      column,
      nonce: (current?.nonce ?? 0) + 1,
    }));
  }

  function revealEditorProblem(problem: EditorProblem) {
    void openEditorLocation(problem.path, problem.line, problem.column);
  }

  function closeTab(path: string) {
    const file = openFiles.find((f) => f.path === path);
    if (file?.dirty && !confirm(`${path.split(/[/\\]/).pop()} has unsaved changes.\n\nClose it and discard them?`)) {
      return;
    }
    setOpenFiles((files) => files.filter((f) => f.path !== path));
    setChangeReviews((current) => {
      if (!(path in current)) return current;
      const next = { ...current };
      delete next[path];
      return next;
    });
    if (reviewPath === path) setReviewPath(null);
    setEditorProblems((current) => {
      if (!(path in current)) return current;
      const next = { ...current };
      delete next[path];
      return next;
    });
    if (activePath === path) {
      const remaining = openFiles.filter((f) => f.path !== path);
      setActivePath(remaining.length ? remaining[remaining.length - 1].path : null);
      // Closing the last file would otherwise leave the editor selected with nothing
      // in it and no tab highlighted — fall back to the viewport instead.
      if (remaining.length === 0) setCenterTab("viewport");
    }
  }

  function updateContent(path: string, content: string) {
    setOpenFiles((files) => files.map((f) => (f.path === path ? { ...f, content, dirty: true } : f)));
  }

  async function runResourceLifecycle(
    kind: "start" | "stop" | "restart",
    name: string,
    source: "manual" | "save" = "manual",
  ): Promise<boolean> {
    if (!runtimeWritable || resourceAction) return false;
    if (kind === "stop") {
      const dependents = dependencyGraph.nodes.find((node) => node.name.toLowerCase() === name.toLowerCase())?.dependents ?? [];
      const message = dependents.length > 0
        ? t("resource.confirmStopDependents", { resource: name, dependents: dependents.join(", ") })
        : t("resource.confirmStop", { resource: name });
      if (!confirm(message)) return false;
    }

    setResourceAction(`${kind}:${name}`);
    setResourceNotice(null);
    try {
      const tool = kind === "start" ? "start_resource" : kind === "stop" ? "stop_resource" : "restart_resource";
      await window.api.mcp.callTool(tool, { name });
      await refreshResourceStatuses(true);
      const action = kind === "start" ? "started" : kind === "stop" ? "stopped" : "restarted";
      setResourceNotice({
        message: source === "save" && kind === "restart"
          ? t("editor.savedAndRestarted", { resource: name })
          : t("resource.actionSuccess", { resource: name, action }),
        error: false,
      });
      if (kind === "restart") {
        setConsoleRefreshSignal((current) => ({ resource: name, nonce: (current?.nonce ?? 0) + 1 }));
        setCenterTab("console");
      }
      return true;
    } catch (err) {
      setResourceNotice({
        message: t("resource.actionFailure", {
          resource: name,
          action: kind,
          message: (err as Error).message || "Unknown error",
        }),
        error: true,
      });
      return false;
    } finally {
      setResourceAction(null);
    }
  }

  // A rename/delete from the resource tree can affect a path that's the exact
  // match (a file itself) or an ancestor (a folder containing open tabs) —
  // handle both so open tabs stay in sync with what's on disk.
  function remapPath(p: string, oldPath: string, newPath: string): string | null {
    if (p === oldPath) return newPath;
    if (p.startsWith(oldPath + "\\") || p.startsWith(oldPath + "/")) return newPath + p.slice(oldPath.length);
    return null;
  }

  function handlePathRenamed(oldPath: string, newPath: string) {
    setOpenFiles((files) => files.map((f) => {
      const remapped = remapPath(f.path, oldPath, newPath);
      return remapped ? { ...f, path: remapped } : f;
    }));
    setActivePath((p) => (p ? (remapPath(p, oldPath, newPath) ?? p) : p));
    setReviewPath((p) => (p ? (remapPath(p, oldPath, newPath) ?? p) : p));
    setChangeReviews((current) => Object.fromEntries(
      Object.entries(current).map(([reviewedPath, review]) => {
        const remapped = remapPath(reviewedPath, oldPath, newPath) ?? reviewedPath;
        return [remapped, { ...review, path: remapPath(review.path, oldPath, newPath) ?? review.path }];
      }),
    ));
    setEditorProblems((current) => Object.fromEntries(
      Object.entries(current).map(([problemPath, problems]) => {
        const remapped = remapPath(problemPath, oldPath, newPath) ?? problemPath;
        return [remapped, problems.map((problem) => ({
          ...problem,
          path: remapPath(problem.path, oldPath, newPath) ?? problem.path,
        }))];
      }),
    ));
    setTreeRefreshKey((k) => k + 1);
  }

  function handlePathDeleted(deletedPath: string) {
    const affected = (p: string) => p === deletedPath || p.startsWith(deletedPath + "\\") || p.startsWith(deletedPath + "/");
    const remaining = openFiles.filter((f) => !affected(f.path));
    setOpenFiles(remaining);
    setChangeReviews((current) => Object.fromEntries(
      Object.entries(current).filter(([reviewedPath]) => !affected(reviewedPath)),
    ));
    if (reviewPath && affected(reviewPath)) setReviewPath(null);
    setEditorProblems((current) => Object.fromEntries(
      Object.entries(current).filter(([problemPath]) => !affected(problemPath)),
    ));
    if (activePath && affected(activePath)) {
      setActivePath(remaining.length ? remaining[remaining.length - 1].path : null);
      if (remaining.length === 0) setCenterTab("viewport");
    }
    setTreeRefreshKey((k) => k + 1);
  }

  async function deleteEntry(path: string, name: string): Promise<boolean> {
    const affected = (candidate: string) =>
      candidate === path || candidate.startsWith(path + "\\") || candidate.startsWith(path + "/");
    const dirtyCount = openFiles.filter((file) => affected(file.path) && file.dirty).length;
    const unsavedWarning = dirtyCount
      ? `\n\n${dirtyCount} open ${dirtyCount === 1 ? "file has" : "files have"} unsaved changes that will be discarded.`
      : "";
    if (!confirm(`Move "${name}" to the Recycle Bin?${unsavedWarning}`)) return false;
    try {
      await window.api.fs.delete(path);
      handlePathDeleted(path);
      return true;
    } catch (err) {
      alert((err as Error).message);
      return false;
    }
  }

  async function saveFile(path: string, content: string, expectedRevision: string) {
    setSaveError(null);
    try {
      const revision = await window.api.fs.writeFile(path, content, expectedRevision);
      setOpenFiles((files) => files.map((f) => (f.path === path ? { ...f, content, revision, dirty: false } : f)));

      if (config.editor.restartResourceOnSave && runtimeWritable) {
        const context = await window.api.resources.context(path).catch(() => null);
        if (context && resourceStates[context.name.toLowerCase()] === "started") {
          await runResourceLifecycle("restart", context.name, "save");
        }
      }
    } catch (err) {
      const message = `Could not save ${path.split(/[/\\]/).pop()}: ${(err as Error).message}`;
      setSaveError(message);
      if ((err as Error).message.includes("changed on disk")) {
        try {
          const disk = await window.api.fs.readFile(path);
          const review: FileChangeReview = {
            id: ++reviewNonce.current,
            path,
            kind: "conflict",
            originalContent: content,
            modifiedContent: disk.content,
            originalLabel: "Your unsaved editor version",
            modifiedLabel: "Current version on disk",
            diskRevision: disk.revision,
          };
          setChangeReviews((current) => ({ ...current, [path]: review }));
          setReviewPath(path);
          setActivePath(path);
          setCenterTab("editor");
        } catch {
          // Preserve the original save failure when the changed file also vanished.
        }
      }
      throw new Error(message);
    }
  }

  function openChangeReview(path: string) {
    if (!changeReviews[path]) return;
    setActivePath(path);
    setCenterTab("editor");
    setReviewPath(path);
  }

  function clearChangeReview(path: string) {
    setChangeReviews((current) => {
      if (!(path in current)) return current;
      const next = { ...current };
      delete next[path];
      return next;
    });
    setReviewPath((current) => current === path ? null : current);
  }

  async function useDiskVersion(review: FileChangeReview) {
    try {
      const latest = await window.api.fs.readFile(review.path);
      setOpenFiles((files) => files.map((file) => file.path === review.path ? {
        ...file,
        ...latest,
        dirty: false,
      } : file));
      setSaveError(null);
      clearChangeReview(review.path);
    } catch (error) {
      setSaveError(`Could not reload ${review.path.split(/[/\\]/).pop()}: ${(error as Error).message}`);
    }
  }

  async function saveEditorVersion(review: FileChangeReview) {
    const open = openFiles.find((file) => file.path === review.path);
    if (!open) return;
    try {
      await saveFile(review.path, open.content, review.diskRevision);
      clearChangeReview(review.path);
    } catch {
      // saveFile refreshed the conflict review if the disk changed again.
    }
  }

  async function launchCfxClient() {
    if (!activeClientPath) return;
    try {
      await window.api.cfx.launch(config.activeCfxTarget);
    } catch (err) {
      alert((err as Error).message);
    }
  }

  async function launchServer() {
    if (!activeServerPath || !config.txDataPath || !config.selectedProfile || serverAction) return;
    serverStatusEpoch.current += 1;
    setServerAction("starting");
    setServerNotice(null);
    try {
      const result = await window.api.server.launch();
      if (result.recoveryNotice) setArtifactNotice(result.recoveryNotice);
      setServerRunning(true);
      observedServerRunning.current = true;
      setServerStartedAt(Date.now());
      setServerPids([result.pid]);
      setServerTarget(result.target);
      setServerStatusError(null);
      setServerNotice({
        message: result.alreadyRunning
          ? `The ${cfxTargetLabel(result.target)} local server is already running.`
          : `${cfxTargetLabel(result.target)} local server started. Use Stop server here or stop it in txAdmin.`,
        error: false,
      });
    } catch (err) {
      setServerNotice({ message: `Could not start the local server: ${(err as Error).message}`, error: true });
    } finally {
      const settledEpoch = ++serverStatusEpoch.current;
      await refreshServerStatus(settledEpoch);
      setServerAction(null);
    }
  }

  async function stopServer() {
    if (serverAction) return;
    serverStatusEpoch.current += 1;
    intentionalServerStop.current = true;
    setServerAction("stopping");
    setServerNotice(null);
    try {
      const result = await window.api.server.stop(serverTarget);
      setServerRunning(false);
      observedServerRunning.current = false;
      setServerStartedAt(null);
      setServerPids([]);
      setServerStatusError(null);
      setServerNotice({
        message: result.alreadyStopped
          ? `The ${cfxTargetLabel(result.target)} local server is already stopped.`
          : `Stopped the ${cfxTargetLabel(result.target)} local server.`,
        error: false,
      });
    } catch (err) {
      intentionalServerStop.current = false;
      setServerNotice({ message: `Could not stop the local server: ${(err as Error).message}`, error: true });
    } finally {
      const settledEpoch = ++serverStatusEpoch.current;
      await refreshServerStatus(settledEpoch);
      setServerAction(null);
    }
  }

  const statusItems: StatusItem[] = [];
  if (saveError) statusItems.push({ id: "save", tone: "error", content: saveError, onDismiss: () => setSaveError(null) });
  if (serverNotice) statusItems.push({
    id: "server",
    tone: serverNotice.error ? "error" : "info",
    content: serverNotice.message,
    onDismiss: () => setServerNotice(null),
  });
  if (resourceNotice) statusItems.push({
    id: "resource",
    tone: resourceNotice.error ? "error" : "info",
    content: resourceNotice.message,
    onDismiss: () => setResourceNotice(null),
  });
  if (connected && workspaceMatch && !workspaceMatch.ok) statusItems.push({
    id: "workspace-mismatch",
    tone: "error",
    content: `Bundled runtime is read-only: ${workspaceMatch.reason} Resource refresh actions are blocked until the workspace identity matches.`,
  });
  if (configLoaded && (!config.txDataPath || !config.selectedProfile)) statusItems.push({
    id: "setup",
    tone: "warning",
    content: "Choose a local txData root and server-data workspace before coding.",
    actions: <button className="btn small" onClick={() => setSettingsOpen(true)}>Open Settings</button>,
  });
  if (!connected && connectError) statusItems.push({
    id: "connection",
    tone: "warning",
    content: `Local coding runtime unavailable: ${connectError} — retrying automatically.`,
  });
  if (artifactNotice) statusItems.push({
    id: "artifact",
    tone: "warning",
    content: artifactNotice,
    onDismiss: () => setArtifactNotice(null),
  });
  if (availableUpdate) statusItems.push({
    id: "update",
    tone: "info",
    content: `QB Studio ${availableUpdate.latestVersion} is available.`,
    actions: <button className="btn small" onClick={() => void window.api.shell.openExternal(availableUpdate.releaseUrl)}>View release</button>,
    onDismiss: () => setAvailableUpdate(null),
  });

  return (
    <div className="app-shell">
      <TopBar
        connected={connected}
        runtimeIdentity={runtimeIdentity}
        workspaceMatch={workspaceMatch}
        onOpenSettings={() => setSettingsOpen(true)}
        onLaunchServer={launchServer}
        onStopServer={stopServer}
        onLaunchClient={launchCfxClient}
        onOpenWorkspace={() => resolved.profileRoot && void window.api.shell.showItemInFolder(resolved.profileRoot)}
        activeTarget={config.activeCfxTarget}
        serverTarget={serverTarget}
        activeServerPath={activeServerPath}
        serverConfigured={Boolean(config.txDataPath && config.selectedProfile)}
        serverAction={serverAction}
        serverRunning={serverRunning}
        serverPids={serverPids}
        serverStartedAt={serverStartedAt}
        serverStatusError={serverStatusError}
        activeClientPath={activeClientPath}
        workspacePath={resolved.profileRoot || null}
        recentWorkspaces={recentWorkspaces}
        onSelectRecentWorkspace={(id) => void switchRecentWorkspace(id)}
      />

      <StatusArea items={statusItems} />

      <div style={{ flex: 1, minHeight: 0 }}>
        <Group orientation="horizontal">
          <Panel defaultSize="20" minSize="14">
            <div className="pane">
              <div className="tabbar" role="tablist" aria-label="Sidebar views">
                <button
                  className={`tab ${sidebarTab === "resources" ? "active" : ""}`}
                  role="tab"
                  aria-selected={sidebarTab === "resources"}
                  onClick={() => setSidebarTab("resources")}
                >
                  Resources
                </button>
                <button
                  className={`tab ${sidebarTab === "search" ? "active" : ""}`}
                  role="tab"
                  aria-selected={sidebarTab === "search"}
                  onClick={() => setSidebarTab("search")}
                >
                  {t("search.tab")}
                </button>
                <button
                  className={`tab ${sidebarTab === "github" ? "active" : ""}`}
                  role="tab"
                  aria-selected={sidebarTab === "github"}
                  onClick={() => setSidebarTab("github")}
                >
                  GitHub
                </button>
              </div>
              <div className="pane-body">
                {sidebarTab === "resources" ? (
                  <>
                    {resolved.serverCfgPath && (
                      <button
                        className={`tree-node pinned-entry ${activePath === resolved.serverCfgPath ? "selected" : ""}`}
                        style={{ paddingLeft: 8 }}
                        onClick={() => openFile(resolved.serverCfgPath!)}
                      >
                        <span className="icon">📄</span>
                        <span>server.cfg</span>
                      </button>
                    )}
                    <ResourceTree
                      rootPath={resolved.resourcesPath}
                      selectedPath={activePath}
                      onOpenFile={openFile}
                      refreshKey={treeRefreshKey}
                      onPathRenamed={handlePathRenamed}
                      onDeleteEntry={deleteEntry}
                      resourceStates={resourceStates}
                      serverStateAvailable={resourceStatuses.serverStateAvailable}
                      runtimeWritable={runtimeWritable}
                      resourceAction={resourceAction}
                      onResourceAction={runResourceLifecycle}
                    />
                  </>
                ) : sidebarTab === "search" ? (
                  <SearchPanel
                    workspaceRoot={resolved.resourcesPath}
                    activeResource={activeResourceContext}
                    resolvedTheme={resolvedTheme}
                    editorPreferences={config.editor}
                    onOpenLocation={(path, line, column) => void openEditorLocation(path, line, column)}
                    onFilesChanged={() => setTreeRefreshKey((key) => key + 1)}
                  />
                ) : (
                  <GithubImportPanel projectRoot={resolved.resourcesPath} onImported={() => setTreeRefreshKey((k) => k + 1)} />
                )}
              </div>
            </div>
          </Panel>

          <Separator className="resize-handle resize-handle-h" />

          <Panel defaultSize="55" minSize="30">
            <CenterPane
              connected={connected}
              runtimeReadable={runtimeReadable}
              runtimeWritable={runtimeWritable}
              consoleAvailable={connected && workspaceMatch?.ok === true ? (runtimeIdentity?.capabilities.console ?? null) : null}
              consoleRefreshIntervalMs={config.consoleRefreshIntervalMs}
              onConsoleRefreshIntervalChange={handleConsoleRefreshIntervalChange}
              resourceLifecycleAvailable={runtimeIdentity?.capabilities.resourceLifecycle ?? null}
              clientLabel={activeTargetLabel}
              editorPreferences={config.editor}
              resolvedTheme={resolvedTheme}
              editorProblems={editorProblems}
              editorReveal={editorReveal}
              changeReviews={changeReviews}
              reviewPath={reviewPath}
              centerTab={centerTab}
              onSelectCenterTab={setCenterTab}
              openFiles={openFiles}
              activePath={activePath}
              activeResourceContext={activeResourceContext}
              activeResourceState={activeResourceContext && resourceStatuses.serverStateAvailable
                ? resourceStates[activeResourceContext.name.toLowerCase()]
                : undefined}
              resourceAction={resourceAction}
              onResourceAction={runResourceLifecycle}
              consoleRefreshSignal={consoleRefreshSignal}
              crashTriage={crashTriage}
              onDismissCrashTriage={() => setCrashTriage(null)}
              onSendCrashTriage={(text) => setAgentPrompt({ text, nonce: Date.now() })}
              onConsoleOutputChange={(output) => { latestConsoleOutput.current = output; }}
              onAgentPrompt={(text) => setAgentPrompt({ text, nonce: Date.now() })}
              dependencyGraph={dependencyGraph}
              onSelectFileTab={setActivePath}
              onCloseFileTab={closeTab}
              onChange={updateContent}
              onSave={saveFile}
              onSelectionChange={(selectedText, startLine, endLine) =>
                setSelection({ selectedText, startLine, endLine })
              }
              onProblemsChange={handleEditorProblems}
              onRevealProblem={revealEditorProblem}
              onOpenEditorLocation={(path, line, column) => void openEditorLocation(path, line, column)}
              onOpenReview={openChangeReview}
              onCloseReview={() => setReviewPath(null)}
              onDismissReview={(review) => clearChangeReview(review.path)}
              onUseDiskVersion={(review) => void useDiskVersion(review)}
              onSaveEditorVersion={(review) => void saveEditorVersion(review)}
            />
          </Panel>

          <Separator className="resize-handle resize-handle-h" />

          <Panel defaultSize="25" minSize="18">
            <ChatPanel
              key={`${config.txDataPath ?? ""}|${config.selectedProfile ?? ""}`}
              connected={connected}
              config={config}
              resolvedTheme={resolvedTheme}
              workspaceMatch={workspaceMatch}
              selection={selection.selectedText ? { ...selection, path: activePath } : null}
              suggestedPrompt={agentPrompt}
              activePath={activePath}
              activeResourceName={activeResourceContext?.name ?? null}
            />
          </Panel>
        </Group>
      </div>

      {settingsOpen && <SettingsModal config={config} onSave={handleSaveSettings} onClose={() => setSettingsOpen(false)} />}
      {whatsNew && <WhatsNewPanel currentVersion={whatsNew.currentVersion} onClose={() => setWhatsNew(null)} />}
    </div>
  );
}
