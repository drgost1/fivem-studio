import { useEffect, useState, useCallback, useRef } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";

import TopBar from "./components/TopBar";
import SettingsModal from "./components/SettingsModal";
import ResourceTree from "./components/ResourceTree";
import GithubImportPanel from "./components/GithubImportPanel";
import CenterPane, { type CenterTab } from "./components/CenterPane";
import ChatPanel from "./components/ChatPanel";
import type { CfxTarget, EditorProblem, ResolvedProfile, RuntimeIdentity, RuntimeWorkspaceMatch, StudioConfig } from "./global";

export interface OpenFile {
  path: string;
  content: string;
  revision: string;
  dirty: boolean;
}

type SidebarTab = "resources" | "github";

const DEFAULT_CONFIG: StudioConfig = {
  txDataPath: null,
  selectedProfile: null,
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
  editor: {
    fontSize: 13,
    wordWrap: false,
    minimap: false,
    stickyScroll: true,
    formatOnSave: false,
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
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [connected, setConnected] = useState(false);
  const [configLoaded, setConfigLoaded] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [runtimeIdentity, setRuntimeIdentity] = useState<RuntimeIdentity | null>(null);
  const [workspaceMatch, setWorkspaceMatch] = useState<RuntimeWorkspaceMatch | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [serverAction, setServerAction] = useState<"starting" | "stopping" | null>(null);
  const [serverRunning, setServerRunning] = useState(false);
  const [serverPids, setServerPids] = useState<number[]>([]);
  const [serverTarget, setServerTarget] = useState<CfxTarget>("legacy");
  const [serverStatusError, setServerStatusError] = useState<string | null>(null);
  const [serverNotice, setServerNotice] = useState<{ message: string; error: boolean } | null>(null);
  const [artifactNotice, setArtifactNotice] = useState<string | null>(null);
  const serverStatusEpoch = useRef(0);

  const [sidebarTab, setSidebarTab] = useState<SidebarTab>("resources");
  const [treeRefreshKey, setTreeRefreshKey] = useState(0);

  const [resolved, setResolved] = useState<ResolvedProfile>(EMPTY_PROFILE);

  const [openFiles, setOpenFiles] = useState<OpenFile[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  // Viewport, not editor: with no files open yet, defaulting to "editor" leaves the
  // tab strip with nothing highlighted and an empty pane, which reads as a broken state.
  const [centerTab, setCenterTab] = useState<CenterTab>("viewport");
  const [selection, setSelection] = useState({ selectedText: "", startLine: 0, endLine: 0 });
  const [editorProblems, setEditorProblems] = useState<Record<string, EditorProblem[]>>({});
  const [editorReveal, setEditorReveal] = useState<{ path: string; line: number; column: number; nonce: number } | null>(null);
  const activeServerPath = serverExeFor(config, config.activeCfxTarget);
  const activeClientPath = clientExeFor(config, config.activeCfxTarget);
  const activeTargetLabel = cfxTargetLabel(config.activeCfxTarget);

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

  // Load saved config, then try connecting automatically.
  useEffect(() => {
    void window.api.config
      .get()
      .then((saved) => {
        setConfig(saved);
        setConfigLoaded(true);
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
      setConnectError("Lost connection to the bundled coding runtime.");
    });
  }, []);

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

  // Bump the tree refresh token whenever the watcher reports a change.
  useEffect(() => {
    return window.api.fs.onChanged(() => setTreeRefreshKey((k) => k + 1));
  }, []);

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

  // The agent can edit files directly. Reload a clean open buffer so the editor
  // shows the new content; leave a dirty one alone rather than discarding the
  // user's unsaved work, and say so instead of silently picking a winner.
  useEffect(() => {
    return window.api.agent.onFileWritten(async (absolutePath) => {
      setTreeRefreshKey((k) => k + 1);
      const open = openFiles.find((f) => f.path === absolutePath);
      if (!open) return;
      if (open.dirty) {
        alert(
          `The agent edited ${absolutePath.split(/[/\\]/).pop()}, but you have unsaved changes in that tab.\n\n` +
            `Your version is untouched on screen. A normal save will be refused until you reopen the file and merge the two versions.`,
        );
        return;
      }
      try {
        const snapshot = await window.api.fs.readFile(absolutePath);
        setOpenFiles((files) =>
          files.map((f) => (f.path === absolutePath ? { ...f, ...snapshot, dirty: false } : f)),
        );
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
    if (profileChanged) {
      setOpenFiles([]);
      setActivePath(null);
      setCenterTab("viewport");
      setEditorProblems({});
      setEditorReveal(null);
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
    } catch (err) {
      const message = `Could not save ${path.split(/[/\\]/).pop()}: ${(err as Error).message}`;
      setSaveError(message);
      throw new Error(message);
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
      setServerPids([result.pid]);
      setServerTarget(result.target);
      setServerStatusError(null);
      setServerNotice({
        message: result.alreadyRunning
          ? `The ${cfxTargetLabel(result.target)} local server is already running (process ${result.pid}).`
          : `${cfxTargetLabel(result.target)} local server started (process ${result.pid}). Use Stop server here or stop it in txAdmin.`,
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
    setServerAction("stopping");
    setServerNotice(null);
    try {
      const result = await window.api.server.stop(serverTarget);
      setServerRunning(false);
      setServerPids([]);
      setServerStatusError(null);
      setServerNotice({
        message: result.alreadyStopped
          ? `The ${cfxTargetLabel(result.target)} local server is already stopped.`
          : `Stopped the ${cfxTargetLabel(result.target)} local server${result.stoppedPids.length ? ` (process ${result.stoppedPids.join(", ")})` : ""}.`,
        error: false,
      });
    } catch (err) {
      setServerNotice({ message: `Could not stop the local server: ${(err as Error).message}`, error: true });
    } finally {
      const settledEpoch = ++serverStatusEpoch.current;
      await refreshServerStatus(settledEpoch);
      setServerAction(null);
    }
  }

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
        activeTarget={config.activeCfxTarget}
        serverTarget={serverTarget}
        activeServerPath={activeServerPath}
        serverConfigured={Boolean(config.txDataPath && config.selectedProfile)}
        serverAction={serverAction}
        serverRunning={serverRunning}
        serverPids={serverPids}
        serverStatusError={serverStatusError}
        activeClientPath={activeClientPath}
      />

      {configLoaded && (!config.txDataPath || !config.selectedProfile) && (
        <div className="warning-banner setup-banner" role="alert">
          Choose a local txData root and server-data workspace before coding.
          <button className="btn small" onClick={() => setSettingsOpen(true)}>
            Open Settings
          </button>
        </div>
      )}
      {artifactNotice && (
        <div className="warning-banner setup-banner" role="status">
          {artifactNotice}
          <button className="btn small" onClick={() => setArtifactNotice(null)}>
            Dismiss
          </button>
        </div>
      )}
      {serverNotice && (
        <div className={`warning-banner setup-banner ${serverNotice.error ? "error-banner" : ""}`} role={serverNotice.error ? "alert" : "status"}>
          {serverNotice.message}
          <button className="btn small" onClick={() => setServerNotice(null)}>
            Dismiss
          </button>
        </div>
      )}
      {!connected && connectError && (
        <div className="warning-banner">
          Local coding runtime unavailable: {connectError} — retrying automatically.
        </div>
      )}
      {connected && workspaceMatch && !workspaceMatch.ok && (
        <div className="warning-banner" role="alert">
          Bundled runtime is read-only: {workspaceMatch.reason} Resource refresh actions are blocked until the workspace identity matches.
        </div>
      )}
      {saveError && (
        <div className="warning-banner error-banner" role="alert">
          {saveError}
          <button className="banner-dismiss" onClick={() => setSaveError(null)} aria-label="Dismiss save error">
            ×
          </button>
        </div>
      )}

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
                    />
                  </>
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
              runtimeReadable={connected && workspaceMatch?.ok === true}
              runtimeWritable={connected && workspaceMatch?.ok === true && runtimeIdentity?.capabilities.resourceLifecycle === true}
              consoleAvailable={connected && workspaceMatch?.ok === true ? (runtimeIdentity?.capabilities.console ?? null) : null}
              consoleRefreshIntervalMs={config.consoleRefreshIntervalMs}
              onConsoleRefreshIntervalChange={handleConsoleRefreshIntervalChange}
              resourceLifecycleAvailable={runtimeIdentity?.capabilities.resourceLifecycle ?? null}
              clientLabel={activeTargetLabel}
              editorPreferences={config.editor}
              editorProblems={editorProblems}
              editorReveal={editorReveal}
              centerTab={centerTab}
              onSelectCenterTab={setCenterTab}
              openFiles={openFiles}
              activePath={activePath}
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
            />
          </Panel>

          <Separator className="resize-handle resize-handle-h" />

          <Panel defaultSize="25" minSize="18">
            <ChatPanel
              key={`${config.txDataPath ?? ""}|${config.selectedProfile ?? ""}`}
              connected={connected}
              config={config}
              workspaceMatch={workspaceMatch}
              selection={selection.selectedText ? { ...selection, path: activePath } : null}
            />
          </Panel>
        </Group>
      </div>

      {settingsOpen && <SettingsModal config={config} onSave={handleSaveSettings} onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}
