import { useState } from "react";
import type { RepoInfo } from "../global";

interface GithubImportPanelProps {
  projectRoot: string | null;
  onImported: () => void;
}

export default function GithubImportPanel({ projectRoot, onImported }: GithubImportPanelProps) {
  const [input, setInput] = useState("");
  const [info, setInfo] = useState<RepoInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [cloning, setCloning] = useState(false);
  const [cloneMessage, setCloneMessage] = useState<string | null>(null);

  async function lookup() {
    if (!input.trim()) return;
    setLoading(true);
    setError(null);
    setInfo(null);
    setCloneMessage(null);
    try {
      setInfo(await window.api.github.fetchRepoInfo(input));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function clone() {
    if (!info || !projectRoot) return;
    setCloning(true);
    setCloneMessage(null);
    try {
      const result = await window.api.github.cloneRepo(info.htmlUrl, projectRoot);
      if (result.ok) {
        setCloneMessage(`Cloned into ${result.destPath}`);
        onImported();
      } else {
        setError(result.error ?? "Clone failed");
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setCloning(false);
    }
  }

  return (
    <div style={{ padding: 8 }}>
      <label className="field-label">GitHub repo (URL or owner/repo)</label>
      <div style={{ display: "flex", gap: 6 }}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && lookup()}
          placeholder="e.g. community/resource-name"
          style={{ flex: 1 }}
        />
        <button className="btn" onClick={lookup} disabled={loading}>
          {loading ? "Looking up…" : "Look up"}
        </button>
      </div>

      {error && <div className="error-text">{error}</div>}

      {info && (
        <div className="repo-card">
          <div className="repo-name">{info.fullName}</div>
          {info.description && <div className="repo-desc">{info.description}</div>}
          <div className="repo-meta">
            <span>⭐ {info.stars.toLocaleString()}</span>
            {info.language && <span>{info.language}</span>}
            {info.license && <span>{info.license}</span>}
          </div>
          <div style={{ marginTop: 8, display: "flex", gap: 6 }}>
            <button className="btn small" onClick={() => window.api.shell.openExternal(info.htmlUrl)}>
              View on GitHub
            </button>
            <button className="btn small primary" onClick={clone} disabled={cloning || !projectRoot}>
              {cloning ? "Cloning…" : "Clone into project"}
            </button>
          </div>
          {!projectRoot && <div className="error-text">Set a project folder in Settings before cloning.</div>}
          {cloneMessage && <div style={{ color: "var(--green)", fontSize: 12, marginTop: 6 }}>{cloneMessage}</div>}
        </div>
      )}
    </div>
  );
}
