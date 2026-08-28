import { useEffect, useState, useCallback } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";

import TopBar from "./components/TopBar";
import SettingsModal from "./components/SettingsModal";
import ResourceTree from "./components/ResourceTree";
import GithubImportPanel from "./components/GithubImportPanel";
import CenterPane, { type CenterTab } from "./components/CenterPane";
import ChatPanel from "./components/ChatPanel";
import type { ResolvedProfile, RuntimeIdentity, RuntimeWorkspaceMatch, StudioConfig } from "./global";

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
  fivemExePath: null,
  agentProvider: "openai",
  openaiBaseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",
  openaiModel: "gemini-3.7-flash",
};

const EMPTY_PROFILE: ResolvedProfile = { profileRoot: "", resourcesPath: null, serverCfgPath: null };

export default function App() {
  const [config, setConfig] = useState<StudioConfig>(DEFAULT_CONFIG);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [connected, setConnected] = useState(false);
  const [configLoaded, setConfigLoaded] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [runtimeIdentity, setRuntimeIdentity] = useState<RuntimeIdentity | null>(null);
  const [workspaceMatch, setWorkspaceMatch] = useState<RuntimeWorkspaceMatch | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const [sidebarTab, setSidebarTab] = useState<SidebarTab>("resources");
  const [treeRefreshKey, setTreeRefreshKey] = useState(0);

  const [resolved, setResolved] = useState<ResolvedProfile>(EMPTY_PROFILE);

  const [openFiles, setOpenFiles] = useState<OpenFile[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  // Viewport, not editor: with no files open yet, defaulting to "editor" leaves the
  // tab strip with nothing highlighted and an empty pane, which reads as a broken state.
  const [centerTab, setCenterTab] = useState<CenterTab>("viewport");
  const [selection, setSelection] = useState({ selectedText: "", startLine: 0, endLine: 0 });

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
    setConfig(saved);
    if (profileChanged) {
      setOpenFiles([]);
      setActivePath(null);
      setCenterTab("viewport");
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

  async function openFile(path: string) {
    setActivePath(path);
    setCenterTab("editor");
    if (openFiles.some((f) => f.path === path)) return;
    try {
      const snapshot = await window.api.fs.readFile(path);
      setOpenFiles((files) => [...files, { path, ...snapshot, dirty: false }]);
    } catch (err) {
      alert((err as Error).message);
    }
  }

  function closeTab(path: string) {
    const file = openFiles.find((f) => f.path === path);
    if (file?.dirty && !confirm(`${path.split(/[/\\]/).pop()} has unsaved changes.\n\nClose it and discard them?`)) {
      return;
    }
    setOpenFiles((files) => files.filter((f) => f.path !== path));
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
    setTreeRefreshKey((k) => k + 1);
  }

  function handlePathDeleted(deletedPath: string) {
    const affected = (p: string) => p === deletedPath || p.startsWith(deletedPath + "\\") || p.startsWith(deletedPath + "/");
    const remaining = openFiles.filter((f) => !affected(f.path));
    setOpenFiles(remaining);
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

  async function launchFivem() {
    if (!config.fivemExePath) return;
    try {
      await window.api.fivem.launch(config.fivemExePath);
    } catch (err) {
      alert((err as Error).message);
    }
  }

  return (
    <div className="app-shell">
      <TopBar
        connected={connected}
        runtimeIdentity={runtimeIdentity}
        workspaceMatch={workspaceMatch}
        onOpenSettings={() => setSettingsOpen(true)}
        onLaunchFivem={launchFivem}
        fivemExePath={config.fivemExePath}
      />

      {configLoaded && (!config.txDataPath || !config.selectedProfile) && (
        <div className="warning-banner setup-banner" role="alert">
          Choose a local txData root and server-data workspace before coding.
          <button className="btn small" onClick={() => setSettingsOpen(true)}>
            Open Settings
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
        <PanelGroup direction="horizontal">
          <Panel defaultSize={20} minSize={14}>
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

          <PanelResizeHandle className="resize-handle resize-handle-h" />

          <Panel defaultSize={55} minSize={30}>
            <CenterPane
              connected={connected}
              runtimeWritable={connected && workspaceMatch?.ok === true && runtimeIdentity?.capabilities.resourceLifecycle === true}
              consoleAvailable={connected && workspaceMatch?.ok === true ? (runtimeIdentity?.capabilities.console ?? null) : null}
              resourceLifecycleAvailable={runtimeIdentity?.capabilities.resourceLifecycle ?? null}
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
            />
          </Panel>

          <PanelResizeHandle className="resize-handle resize-handle-h" />

          <Panel defaultSize={25} minSize={18}>
            <ChatPanel
              key={`${config.txDataPath ?? ""}|${config.selectedProfile ?? ""}`}
              connected={connected}
              config={config}
              workspaceMatch={workspaceMatch}
              selection={selection.selectedText ? { ...selection, path: activePath } : null}
            />
          </Panel>
        </PanelGroup>
      </div>

      {settingsOpen && <SettingsModal config={config} onSave={handleSaveSettings} onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}
