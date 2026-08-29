import { lazy, Suspense, useEffect, useRef, useState } from "react";
import type { OpenFile } from "../App";
import type { WindowCandidate } from "../global";

export type CenterTab = "viewport" | "console" | "resources" | "editor";

const CodeEditor = lazy(() => import("./CodeEditor"));

function languageForPath(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "lua":
      return "lua";
    case "json":
      return "json";
    case "js":
    case "cjs":
    case "mjs":
      return "javascript";
    case "ts":
    case "tsx":
      return "typescript";
    case "md":
      return "markdown";
    case "yml":
    case "yaml":
      return "yaml";
    case "html":
      return "html";
    case "css":
      return "css";
    case "cfg":
      return "ini";
    default:
      return "plaintext";
  }
}

/**
 * Tab labels, disambiguated by parent folder when bare filenames collide — near-universal
 * in a FiveM tree, where every resource has its own fxmanifest.lua, client/main.lua, etc.
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
  resourceLifecycleAvailable: boolean | null;
  centerTab: CenterTab;
  onSelectCenterTab: (tab: CenterTab) => void;
  openFiles: OpenFile[];
  activePath: string | null;
  onSelectFileTab: (path: string) => void;
  onCloseFileTab: (path: string) => void;
  onChange: (path: string, content: string) => void;
  onSave: (path: string, content: string, expectedRevision: string) => Promise<void>;
  onSelectionChange: (selectedText: string, startLine: number, endLine: number) => void;
}

export default function CenterPane({
  connected,
  runtimeReadable,
  runtimeWritable,
  consoleAvailable,
  resourceLifecycleAvailable,
  centerTab,
  onSelectCenterTab,
  openFiles,
  activePath,
  onSelectFileTab,
  onCloseFileTab,
  onChange,
  onSave,
  onSelectionChange,
}: CenterPaneProps) {
  const activeFile = openFiles.find((f) => f.path === activePath);
  const labels = tabLabels(openFiles);

  return (
    <div className="pane" style={{ height: "100%" }}>
      <div className="editor-tabbar" role="tablist" aria-label="Ghz Workbench views">
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
            embedded FiveM window (and the console's fetched output) survive switching
            to/from a file tab instead of being torn down and rebuilt every time. */}
        <div style={{ flex: 1, minHeight: 0, display: centerTab === "viewport" ? "flex" : "none" }}>
          <ViewportSection active={centerTab === "viewport"} />
        </div>
        <div style={{ flex: 1, minHeight: 0, display: centerTab === "console" ? "flex" : "none" }}>
          <ConsoleSection connected={connected} available={consoleAvailable} />
        </div>
        <div style={{ flex: 1, minHeight: 0, display: centerTab === "resources" ? "flex" : "none" }}>
          <ResourcesSection
            connected={connected}
            runtimeReadable={runtimeReadable}
            runtimeWritable={runtimeWritable}
            resourceLifecycleAvailable={resourceLifecycleAvailable}
          />
        </div>
        <div style={{ flex: 1, minHeight: 0, display: centerTab === "editor" ? "block" : "none" }}>
          {activeFile ? (
            <Suspense fallback={<div className="editor-empty">Loading editor…</div>}>
              <CodeEditor
                file={activeFile}
                language={languageForPath(activeFile.path)}
                onChange={onChange}
                onSave={onSave}
                onSelectionChange={onSelectionChange}
              />
            </Suspense>
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

function ConsoleSection({ connected, available }: { connected: boolean; available: boolean | null }) {
  return (
    <div style={{ flex: 1, minHeight: 0 }}>
      <ConsoleTab connected={connected} available={available} />
    </div>
  );
}

function ConsoleTab({ connected, available }: { connected: boolean; available: boolean | null }) {
  const [output, setOutput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      setOutput(await window.api.mcp.callTool("get_console_output", { lines: 200 }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", width: "100%" }}>
      <div style={{ display: "flex", gap: 6, padding: 6, borderBottom: "1px solid var(--border)" }}>
        <button className="btn small" onClick={refresh} disabled={loading || !connected || available !== true}>
          Refresh
        </button>
      </div>
      {connected && available === false && (
        <div className="operations-empty" role="status">
          Console tailing requires exactly one txAdmin control profile whose <code>config.json</code> {" "}
          <code>server.dataPath</code> points to this workspace. Start FXServer, then open Settings and Save again to rescan.
        </div>
      )}
      {error && <div className="error-text" style={{ padding: "0 8px" }}>{error}</div>}
      <div className="console-lines" style={{ flex: 1, overflow: "auto" }} aria-live="polite">
        {output || (available === false ? "(console not attached yet)" : "(no output yet — click Refresh)")}
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
}

function ViewportSection({ active }: ViewportSectionProps) {
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
        <EmbedPicker onAttached={setAttachedTitle} />
      )}
    </div>
  );
}

/** Just the measured placeholder for the currently-attached native window — no text, no buttons,
 * nothing that a slightly-imprecise embed rect could end up covering. */
function EmbedSurface({ active }: { active: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null);

  // Keep the native window positioned over this div (or hidden, when this tab isn't the visible
  // one) every animation frame. The measured div itself carries no border/padding — decoration
  // lives on the wrapper around it — so nothing in the CSS box model can skew the physical rect.
  useEffect(() => {
    let raf: number;
    const tick = () => {
      if (active && containerRef.current) {
        const rect = containerRef.current.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        window.api.windowEmbed.setRect(rect.x * dpr, rect.y * dpr, rect.width * dpr, rect.height * dpr, true);
      } else {
        window.api.windowEmbed.setRect(0, 0, 0, 0, false);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
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

function EmbedPicker({ onAttached }: { onAttached: (title: string) => void }) {
  const [candidates, setCandidates] = useState<WindowCandidate[]>([]);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function scan() {
    setScanning(true);
    setError(null);
    try {
      const found = await window.api.windowEmbed.listCandidates();
      setCandidates(found);
      if (found.length === 0) setError("No FiveM window found — make sure it's running in windowed/borderless mode, then scan again.");
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
          {scanning ? "Scanning…" : "Scan for FiveM window"}
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
          Docks the real, live FiveM client window into this pane (Windows only).
          Launch FiveM in windowed or borderless mode first, then scan.
        </div>
      )}
    </div>
  );
}
