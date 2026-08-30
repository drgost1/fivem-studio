import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FileChangeReview, OpenFile } from "../App";
import { languageForPath } from "../editorLanguage";
import type { EditorPreferences, EditorProblem, ResourceContext, WindowCandidate } from "../global";
import { t } from "../i18n";
import type { LuaServiceStatus } from "../luaLanguageService";

export type CenterTab = "viewport" | "console" | "resources" | "editor";

const CodeEditor = lazy(() => import("./CodeEditor"));
const ChangeReview = lazy(() => import("./ChangeReview"));

/**
 * Tab labels, disambiguated by parent folder when bare filenames collide — near-universal
 * in a Cfx.re resource tree, where every resource has its own fxmanifest.lua, client/main.lua, etc.
 * Without this, several tabs read identically with no way to tell which is which.
 */
function tabLabels(openFiles: OpenFile[]): Map<string, string> {
  const counts = new Map<string, number>();
  for (const f of openFiles) {
    const name = f.path.split(/[/\\]/).pop() ?? f.path;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }

  const labels = new Map<string, string>();
  for (const f of openFiles) {
    const parts = f.path.split(/[/\\]/);
    const name = parts.pop() ?? f.path;
    const parent = parts.pop();
    labels.set(f.path, (counts.get(name) ?? 0) > 1 && parent ? `${parent}/${name}` : name);
  }
  return labels;
}

interface CenterPaneProps {
  connected: boolean;
  runtimeReadable: boolean;
  runtimeWritable: boolean;
  consoleAvailable: boolean | null;
  consoleRefreshIntervalMs: number;
  onConsoleRefreshIntervalChange: (intervalMs: number) => Promise<void>;
  resourceLifecycleAvailable: boolean | null;
  clientLabel: string;
  editorPreferences: EditorPreferences;
  editorProblems: Record<string, EditorProblem[]>;
  editorReveal: { path: string; line: number; column: number; nonce: number } | null;
  changeReviews: Record<string, FileChangeReview>;
  reviewPath: string | null;
  centerTab: CenterTab;
  onSelectCenterTab: (tab: CenterTab) => void;
  openFiles: OpenFile[];
  activePath: string | null;
  activeResourceContext: ResourceContext | null;
  activeResourceState: "started" | "stopped" | undefined;
  resourceAction: string | null;
  onResourceAction: (kind: "start" | "stop" | "restart", name: string) => Promise<boolean>;
  consoleRefreshSignal: { resource: string; nonce: number } | null;
  onSelectFileTab: (path: string) => void;
  onCloseFileTab: (path: string) => void;
  onChange: (path: string, content: string) => void;
  onSave: (path: string, content: string, expectedRevision: string) => Promise<void>;
  onSelectionChange: (selectedText: string, startLine: number, endLine: number) => void;
  onProblemsChange: (path: string, problems: EditorProblem[]) => void;
  onRevealProblem: (problem: EditorProblem) => void;
  onOpenEditorLocation: (path: string, line: number, column: number) => void;
  onOpenReview: (path: string) => void;
  onCloseReview: () => void;
  onDismissReview: (review: FileChangeReview) => void;
  onUseDiskVersion: (review: FileChangeReview) => void;
  onSaveEditorVersion: (review: FileChangeReview) => void;
}

export default function CenterPane({
  connected,
  runtimeReadable,
  runtimeWritable,
  consoleAvailable,
  consoleRefreshIntervalMs,
  onConsoleRefreshIntervalChange,
  resourceLifecycleAvailable,
  clientLabel,
  editorPreferences,
  editorProblems,
  editorReveal,
  changeReviews,
  reviewPath,
  centerTab,
  onSelectCenterTab,
  openFiles,
  activePath,
  activeResourceContext,
  activeResourceState,
  resourceAction,
  onResourceAction,
  consoleRefreshSignal,
  onSelectFileTab,
  onCloseFileTab,
  onChange,
  onSave,
  onSelectionChange,
  onProblemsChange,
  onRevealProblem,
  onOpenEditorLocation,
  onOpenReview,
  onCloseReview,
  onDismissReview,
  onUseDiskVersion,
  onSaveEditorVersion,
}: CenterPaneProps) {
  const activeFile = openFiles.find((f) => f.path === activePath);
  const activeReview = activeFile && reviewPath === activeFile.path ? changeReviews[activeFile.path] : undefined;
  const labels = tabLabels(openFiles);
  const openPathKey = openFiles.map((file) => file.path).join("\0");
  // Content edits replace OpenFile objects, but the Monaco lifecycle depends
  // only on the tab paths. Keep this array stable while the tab set is stable.
  const openPaths = useMemo(() => openFiles.map((file) => file.path), [openPathKey]);
  const [problemsOpen, setProblemsOpen] = useState(false);
  const [luaService, setLuaService] = useState<{ status: LuaServiceStatus; message?: string }>({ status: "stopped" });
  const handleLuaStatusChange = useCallback((status: LuaServiceStatus, message?: string) => {
    setLuaService((current) => current.status === status && current.message === message ? current : { status, message });
  }, []);
  const problems = Object.values(editorProblems)
    .flat()
    .sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.column - b.column);
  const errorCount = problems.filter((problem) => problem.severity === "error").length;
  const warningCount = problems.filter((problem) => problem.severity === "warning").length;

  return (
    <div className="pane" style={{ height: "100%" }}>
      <div className="editor-tabbar" role="tablist" aria-label="QB Studio views">
        <button
          className={`editor-tab pinned ${centerTab === "viewport" ? "active" : ""}`}
          role="tab"
          aria-selected={centerTab === "viewport"}
          onClick={() => onSelectCenterTab("viewport")}
        >
          <span className="icon">🎮</span>
          <span>Viewport</span>
        </button>
        <button
          className={`editor-tab pinned ${centerTab === "console" ? "active" : ""}`}
          role="tab"
          aria-selected={centerTab === "console"}
          onClick={() => onSelectCenterTab("console")}
        >
          <span className="icon">📟</span>
          <span>Console</span>
        </button>
        <button
          className={`editor-tab pinned ${centerTab === "resources" ? "active" : ""}`}
          role="tab"
          aria-selected={centerTab === "resources"}
          onClick={() => onSelectCenterTab("resources")}
        >
          <svg className="tab-icon" viewBox="0 0 16 16" aria-hidden="true">
            <rect x="1.5" y="2" width="5" height="5" rx="1" />
            <rect x="9.5" y="2" width="5" height="5" rx="1" />
            <rect x="5.5" y="9" width="5" height="5" rx="1" />
          </svg>
          <span>Resources</span>
        </button>
        {openFiles.map((f) => (
          <div
            key={f.path}
            className={`editor-tab file-tab ${centerTab === "editor" && f.path === activePath ? "active" : ""}`}
            title={f.path}
          >
            <button
              type="button"
              className="file-tab-select"
              role="tab"
              aria-selected={centerTab === "editor" && f.path === activePath}
              onClick={() => {
                onSelectFileTab(f.path);
                onSelectCenterTab("editor");
              }}
            >
              {f.dirty && <span className="dirty-dot" />}
              <span>{labels.get(f.path)}</span>
              {(editorProblems[f.path]?.length ?? 0) > 0 && (
                <span className="problem-badge" aria-label={`${editorProblems[f.path].length} problems`}>
                  {editorProblems[f.path].length}
                </span>
              )}
              {changeReviews[f.path] && (
                <span className={`change-badge ${changeReviews[f.path].kind}`} aria-label="Changes available to review">
                  Δ
                </span>
              )}
            </button>
            <button
              type="button"
              className="close"
              aria-label={`Close ${labels.get(f.path)}`}
              onClick={(e) => {
                e.stopPropagation();
                onCloseFileTab(f.path);
              }}
            >
              ✕
            </button>
          </div>
        ))}
      </div>

      <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
        {/* Sections stay mounted, toggled with CSS — this is what lets the
            embedded Cfx.re client window (and the console's fetched output) survive switching
            to/from a file tab instead of being torn down and rebuilt every time. */}
        <div style={{ flex: 1, minHeight: 0, display: centerTab === "viewport" ? "flex" : "none" }}>
          <ViewportSection active={centerTab === "viewport"} clientLabel={clientLabel} />
        </div>
        <div style={{ flex: 1, minHeight: 0, display: centerTab === "console" ? "flex" : "none" }}>
          <ConsoleSection
            active={centerTab === "console"}
            connected={connected}
            available={consoleAvailable}
            refreshIntervalMs={consoleRefreshIntervalMs}
            onRefreshIntervalChange={onConsoleRefreshIntervalChange}
            refreshSignal={consoleRefreshSignal}
          />
        </div>
        <div style={{ flex: 1, minHeight: 0, display: centerTab === "resources" ? "flex" : "none" }}>
          <ResourcesSection
            connected={connected}
            runtimeReadable={runtimeReadable}
            runtimeWritable={runtimeWritable}
            resourceLifecycleAvailable={resourceLifecycleAvailable}
          />
        </div>
        <div className="editor-workbench" style={{ flex: 1, minHeight: 0, display: centerTab === "editor" ? "flex" : "none" }}>
          {activeFile ? (
            <>
              <div className="editor-surface" style={{ display: activeReview ? "none" : "flex" }}>
                {activeResourceContext && (
                  <div className={`editor-resource-bar ${activeResourceState ?? "unknown"}`} role="status">
                    <span className={`resource-state-dot ${activeResourceState ?? "unknown"}`} aria-hidden="true" />
                    <strong>{activeResourceContext.name}</strong>
                    <span className="editor-resource-message">
                      {activeResourceState === "stopped"
                        ? t("editor.resourceStopped", { resource: activeResourceContext.name })
                        : t(`resource.state.${activeResourceState ?? "unknown"}`)}
                    </span>
                    {activeResourceState === "started" && (
                      <button
                        type="button"
                        className="btn small"
                        disabled={!runtimeWritable || resourceAction !== null}
                        onClick={() => void onResourceAction("restart", activeResourceContext.name)}
                      >
                        {resourceAction === `restart:${activeResourceContext.name}` ? t("common.restarting") : t("editor.restartResource")}
                      </button>
                    )}
                    {activeResourceState === "stopped" && (
                      <button
                        type="button"
                        className="btn small primary"
                        disabled={!runtimeWritable || resourceAction !== null}
                        onClick={() => void onResourceAction("start", activeResourceContext.name)}
                      >
                        {resourceAction === `start:${activeResourceContext.name}` ? t("common.starting") : t("editor.startResource")}
                      </button>
                    )}
                  </div>
                )}
                <div className="editor-monaco-surface">
                  <Suspense fallback={<div className="editor-empty">Loading editor…</div>}>
                    <CodeEditor
                      file={activeFile}
                      openPaths={openPaths}
                      language={languageForPath(activeFile.path)}
                      preferences={editorPreferences}
                      luaActive={openFiles.some((openFile) => languageForPath(openFile.path) === "lua")}
                      reveal={editorReveal}
                      onChange={onChange}
                      onSave={onSave}
                      onSelectionChange={onSelectionChange}
                      onProblemsChange={onProblemsChange}
                      onOpenLocation={onOpenEditorLocation}
                      onLuaStatusChange={handleLuaStatusChange}
                    />
                  </Suspense>
                </div>
              </div>
              {activeReview && (
                <div className="change-review-surface">
                  <Suspense fallback={<div className="editor-empty">Loading change review…</div>}>
                    <ChangeReview
                      review={activeReview.kind === "conflict" ? { ...activeReview, originalContent: activeFile.content } : activeReview}
                      language={languageForPath(activeReview.path)}
                      preferences={editorPreferences}
                      onBack={onCloseReview}
                      onDismiss={() => onDismissReview(activeReview)}
                      onUseDisk={() => onUseDiskVersion(activeReview)}
                      onSaveEditor={() => onSaveEditorVersion(activeReview)}
                    />
                  </Suspense>
                </div>
              )}
              {problemsOpen && !activeReview && (
                <section className="problems-panel" aria-label="Problems">
                  {problems.length === 0 ? (
                    <div className="problems-empty">No problems detected in open files.</div>
                  ) : problems.map((problem, index) => (
                    <button
                      key={`${problem.path}:${problem.line}:${problem.column}:${problem.message}:${index}`}
                      className={`problem-row ${problem.severity}`}
                      type="button"
                      onClick={() => onRevealProblem(problem)}
                    >
                      <span className="problem-severity" aria-hidden="true">
                        {problem.severity === "error" ? "×" : problem.severity === "warning" ? "!" : "i"}
                      </span>
                      <span className="problem-message">{problem.message}</span>
                      <span className="problem-location">
                        {problem.path.split(/[/\\]/).pop()}:{problem.line}:{problem.column}
                      </span>
                    </button>
                  ))}
                </section>
              )}
              <div className="editor-statusbar">
                <span>{languageForPath(activeFile.path)}</span>
                {languageForPath(activeFile.path) === "lua" && (
                  <span
                    className={`lua-service-status ${luaService.status}`}
                    title={luaService.message}
                  >
                    Lua: {luaService.status}
                  </span>
                )}
                {changeReviews[activeFile.path] && !activeReview && (
                  <button type="button" className="has-review" onClick={() => onOpenReview(activeFile.path)}>
                    Review changes
                  </button>
                )}
                <button
                  type="button"
                  className={problems.length > 0 ? "has-problems" : ""}
                  onClick={() => setProblemsOpen((open) => !open)}
                  aria-expanded={problemsOpen}
                >
                  Problems: {errorCount} errors, {warningCount} warnings
                </button>
              </div>
            </>
          ) : (
            <div className="editor-empty">
              <div>No file open</div>
              <div style={{ fontSize: 11 }}>Pick a file from the resource tree on the left.</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const CONSOLE_REFRESH_OPTIONS = [
  { value: 0, label: "Off" },
  { value: 1_000, label: "Every second" },
  { value: 2_000, label: "Every 2 seconds" },
  { value: 5_000, label: "Every 5 seconds" },
  { value: 10_000, label: "Every 10 seconds" },
  { value: 30_000, label: "Every 30 seconds" },
] as const;

function ConsoleSection({
  active,
  connected,
  available,
  refreshIntervalMs,
  onRefreshIntervalChange,
  refreshSignal,
}: {
  active: boolean;
  connected: boolean;
  available: boolean | null;
  refreshIntervalMs: number;
  onRefreshIntervalChange: (intervalMs: number) => Promise<void>;
  refreshSignal: { resource: string; nonce: number } | null;
}) {
  return (
    <div style={{ flex: 1, minHeight: 0 }}>
      <ConsoleTab
        active={active}
        connected={connected}
        available={available}
        refreshIntervalMs={refreshIntervalMs}
        onRefreshIntervalChange={onRefreshIntervalChange}
        refreshSignal={refreshSignal}
      />
    </div>
  );
}

function ConsoleTab({
  active,
  connected,
  available,
  refreshIntervalMs,
  onRefreshIntervalChange,
  refreshSignal,
}: {
  active: boolean;
  connected: boolean;
  available: boolean | null;
  refreshIntervalMs: number;
  onRefreshIntervalChange: (intervalMs: number) => Promise<void>;
  refreshSignal: { resource: string; nonce: number } | null;
}) {
  const [output, setOutput] = useState("");
  const [loading, setLoading] = useState(false);
  const [savingInterval, setSavingInterval] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pageVisible, setPageVisible] = useState(() => document.visibilityState !== "hidden");
  const [refreshNotice, setRefreshNotice] = useState<string | null>(null);
  const requestRef = useRef<Promise<void> | null>(null);
  const outputRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);

  const refresh = useCallback((showLoading: boolean): Promise<void> => {
    if (requestRef.current) return requestRef.current;
    const view = outputRef.current;
    stickToBottomRef.current = !view || view.scrollHeight - view.scrollTop - view.clientHeight < 32;
    if (showLoading) setLoading(true);
    setError(null);
    const request = window.api.mcp
      .callTool("get_console_output", { lines: 200 })
      .then(setOutput)
      .catch((err) => setError((err as Error).message))
      .finally(() => {
        requestRef.current = null;
        if (showLoading) setLoading(false);
      });
    requestRef.current = request;
    return request;
  }, []);

  useEffect(() => {
    const onVisibilityChange = () => setPageVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, []);

  useEffect(() => {
    if (!active || !pageVisible || !connected || available !== true || refreshIntervalMs === 0) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      await refresh(false);
      if (!cancelled) timer = setTimeout(poll, refreshIntervalMs);
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [active, available, connected, pageVisible, refresh, refreshIntervalMs]);

  useEffect(() => {
    if (stickToBottomRef.current && outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [output]);

  useEffect(() => {
    if (!refreshSignal || !connected || available !== true) return;
    setRefreshNotice(t("console.refreshAfterRestart", { resource: refreshSignal.resource }));
    const timer = setTimeout(() => {
      void refresh(false).finally(() => setRefreshNotice(null));
    }, 600);
    return () => clearTimeout(timer);
  }, [available, connected, refresh, refreshSignal]);

  async function changeRefreshInterval(intervalMs: number) {
    setSavingInterval(true);
    setError(null);
    try {
      await onRefreshIntervalChange(intervalMs);
    } catch (err) {
      setError(`Could not save the console refresh interval: ${(err as Error).message}`);
    } finally {
      setSavingInterval(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", width: "100%" }}>
      <div style={{ display: "flex", gap: 6, padding: 6, borderBottom: "1px solid var(--border)" }}>
        <button className="btn small" onClick={() => void refresh(true)} disabled={loading || !connected || available !== true}>
          {loading ? "Refreshing…" : "Refresh"}
        </button>
        <label className="console-refresh-control">
          <span>Auto-refresh</span>
          <select
            aria-label="Console auto-refresh interval"
            value={refreshIntervalMs}
            onChange={(event) => void changeRefreshInterval(Number(event.target.value))}
            disabled={savingInterval}
          >
            {CONSOLE_REFRESH_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
        {refreshNotice && <span className="console-refresh-notice" aria-live="polite">{refreshNotice}</span>}
      </div>
      {connected && available === false && (
        <div className="operations-empty" role="status">
          Console tailing requires exactly one txAdmin control profile whose <code>config.json</code> {" "}
          <code>server.dataPath</code> points to this workspace. Start FXServer, then open Settings and Save again to rescan.
        </div>
      )}
      {error && <div className="error-text" style={{ padding: "0 8px" }}>{error}</div>}
      <div
        ref={outputRef}
        className="console-lines"
        style={{ flex: 1, overflow: "auto" }}
        aria-live={refreshIntervalMs === 0 ? "polite" : "off"}
      >
        {output || (available === false
          ? "(console not attached yet)"
          : refreshIntervalMs === 0
            ? "(no output yet — click Refresh)"
            : "(waiting for console output…)" )}
      </div>
    </div>
  );
}

function ResourcesSection({
  connected,
  runtimeReadable,
  runtimeWritable,
  resourceLifecycleAvailable,
}: {
  connected: boolean;
  runtimeReadable: boolean;
  runtimeWritable: boolean;
  resourceLifecycleAvailable: boolean | null;
}) {
  const [output, setOutput] = useState("");
  const [resourceName, setResourceName] = useState("");
  const [loading, setLoading] = useState(false);
  const [action, setAction] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      setOutput(await window.api.mcp.callTool("list_resources", {}));
    } catch (err) {
      setError((err as Error).message || "Could not list local resources.");
    } finally {
      setLoading(false);
    }
  }

  async function runLifecycle(kind: "start" | "stop" | "restart", name: string) {
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Enter or select a resource name first.");
      return;
    }
    if (kind === "stop" && !confirm(`Stop resource "${trimmed}"?`)) return;
    setAction(`${kind}:${trimmed}`);
    setError(null);
    setMessage(null);
    try {
      const tool = kind === "start" ? "start_resource" : kind === "stop" ? "stop_resource" : "restart_resource";
      const result = await window.api.mcp.callTool(tool, { name: trimmed });
      setMessage(result || `Sent ${kind} for ${trimmed}.`);
      await refresh();
    } catch (err) {
      setError((err as Error).message || `Could not ${kind} ${trimmed}.`);
    } finally {
      setAction(null);
    }
  }

  return (
    <section className="operations-view" aria-labelledby="resources-heading">
      <div className="operations-toolbar">
        <div>
          <h2 id="resources-heading">Resources</h2>
          <div className="operations-source">Local coding runtime</div>
        </div>
        <button className="btn small" onClick={() => void refresh()} disabled={loading || !runtimeReadable}>
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>
      <div className="operations-action-row">
        <label className="sr-only" htmlFor="resource-name">Resource name</label>
        <input id="resource-name" value={resourceName} onChange={(e) => setResourceName(e.target.value)} placeholder="Resource name" />
        <button className="btn small" onClick={() => void runLifecycle("start", resourceName)} disabled={action !== null || !runtimeWritable}>Start</button>
        <button className="btn small primary" onClick={() => void runLifecycle("restart", resourceName)} disabled={action !== null || !runtimeWritable}>Restart</button>
        <button className="btn small danger-button" onClick={() => void runLifecycle("stop", resourceName)} disabled={action !== null || !runtimeWritable}>Stop</button>
      </div>
      {connected && resourceLifecycleAvailable === false && (
        <div className="operations-empty" role="status">
          Add <code>set rcon_password "..."</code> to <code>server.cfg</code> or an <code>exec</code>-loaded sibling
          config, restart FXServer, then open Settings and Save again. The password is not stored in Settings.
        </div>
      )}
      {error && <div className="error-text" role="alert">{error}</div>}
      {message && <pre className="operation-result" aria-live="polite">{message}</pre>}
      {output && <pre className="operation-result">{output}</pre>}
      {!connected && <div className="operations-empty">Choose a workspace to start the bundled local runtime.</div>}
      {!output && !loading && !error && runtimeReadable && <div className="operations-empty">Refresh to compare workspace resources with the local server's started resources.</div>}
    </section>
  );
}

interface ViewportSectionProps {
  active: boolean;
  clientLabel: string;
}

function ViewportSection({ active, clientLabel }: ViewportSectionProps) {
  const [attachedTitle, setAttachedTitle] = useState<string | null>(null);

  async function detach() {
    await window.api.windowEmbed.detach();
    setAttachedTitle(null);
  }

  return (
    <div className="viewport-frame" style={{ flex: 1, minHeight: 0 }}>
      {/* Kept well away from the embed target rect below, on purpose: a raw Win32 child window
          always paints on top of Chromium content in its screen rect — CSS z-index can't help —
          so any control that must stay clickable while attached needs to live structurally
          outside that rect, not just visually above it with a small margin. */}
      <div style={{ display: "flex", gap: 6, marginBottom: 8, alignItems: "center" }}>
        {attachedTitle && (
          <>
            <span style={{ fontSize: 12, color: "var(--text-dim)" }}>Attached: {attachedTitle}</span>
            <button className="btn small" onClick={detach}>
              Detach
            </button>
          </>
        )}
      </div>
      {attachedTitle ? (
        <EmbedSurface active={active} />
      ) : (
        <EmbedPicker clientLabel={clientLabel} onAttached={setAttachedTitle} />
      )}
    </div>
  );
}

/** Just the measured placeholder for the currently-attached native window — no text, no buttons,
 * nothing that a slightly-imprecise embed rect could end up covering. */
function EmbedSurface({ active }: { active: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null);

  // Measure only when layout can actually change. The old perpetual rAF loop sent 60 IPC calls
  // and repeated SetWindowPos/ShowWindow every second even for a completely static viewport.
  // ResizeObserver covers panel/layout changes; the window event covers DPI and host resizing.
  useEffect(() => {
    if (!active || !containerRef.current) {
      void window.api.windowEmbed.setRect(0, 0, 0, 0, false);
      return;
    }

    const container = containerRef.current;
    let frame: number | null = null;
    let lastMeasurement = "";
    const measure = () => {
      frame = null;
      const rect = container.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const values = [rect.x, rect.y, rect.width, rect.height].map((value) => Math.round(value * dpr));
      const measurement = values.join(":");
      if (measurement === lastMeasurement) return;
      lastMeasurement = measurement;
      void window.api.windowEmbed.setRect(values[0], values[1], values[2], values[3], true);
    };
    const scheduleMeasure = () => {
      if (frame === null) frame = requestAnimationFrame(measure);
    };

    const resizeObserver = new ResizeObserver(scheduleMeasure);
    resizeObserver.observe(container);
    window.addEventListener("resize", scheduleMeasure);
    scheduleMeasure();

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("resize", scheduleMeasure);
      if (frame !== null) cancelAnimationFrame(frame);
      void window.api.windowEmbed.setRect(0, 0, 0, 0, false);
    };
  }, [active]);

  // Safety net — the authoritative cleanup is main.ts's window-all-closed handler,
  // this just covers the component unmounting while the app stays alive.
  useEffect(() => {
    return () => {
      window.api.windowEmbed.detach();
    };
  }, []);

  return (
    // alignSelf/width here override .viewport-frame's `align-items: center` — without them this
    // flex item has no explicit cross-axis size and shrink-wraps to ~0 width while `flex: 1` still
    // lets it grow tall, which is exactly the "long, very very skinny" box that showed up.
    <div style={{ flex: 1, alignSelf: "stretch", width: "100%", minHeight: 0, border: "1px solid var(--border)", borderRadius: 4, padding: 1 }}>
      <div ref={containerRef} style={{ width: "100%", height: "100%" }} />
    </div>
  );
}

function EmbedPicker({ clientLabel, onAttached }: { clientLabel: string; onAttached: (title: string) => void }) {
  const [candidates, setCandidates] = useState<WindowCandidate[]>([]);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function scan() {
    setScanning(true);
    setError(null);
    try {
      const found = await window.api.windowEmbed.listCandidates();
      setCandidates(found);
      if (found.length === 0) setError(`No ${clientLabel} window found — make sure it's running in windowed/borderless mode, then scan again.`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setScanning(false);
    }
  }

  async function attachTo(candidate: WindowCandidate) {
    setError(null);
    const result = await window.api.windowEmbed.attach(candidate.id);
    if (result.ok) onAttached(candidate.title || candidate.processName);
    else setError(result.error ?? "Failed to attach to that window.");
  }

  return (
    <div>
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <button className="btn small primary" onClick={scan} disabled={scanning}>
          {scanning ? "Scanning…" : `Scan for ${clientLabel} window`}
        </button>
      </div>
      {error && <div className="error-text">{error}</div>}
      {candidates.length > 0 && (
        <div style={{ marginTop: 8 }}>
          {candidates.map((c) => (
            <div key={c.id} className="tree-node" style={{ paddingLeft: 8 }} onClick={() => attachTo(c)}>
              <span className="icon">🖥</span>
              <span>
                {c.title || "(untitled window)"} — {c.processName} (pid {c.pid})
              </span>
            </div>
          ))}
        </div>
      )}
      {candidates.length === 0 && !error && (
        <div style={{ fontSize: 12, marginTop: 8 }}>
          Docks the real, live {clientLabel} client window into this pane (Windows only).
          Launch it in windowed or borderless mode first, then scan.
        </div>
      )}
    </div>
  );
}
