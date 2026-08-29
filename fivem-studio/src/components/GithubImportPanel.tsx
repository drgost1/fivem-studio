import { useRef, useState } from "react";
import type { RepoInfo, RepoSearchResult } from "../global";

type ResultScope =
  | { kind: "search" }
  | { kind: "organization"; organization: string; truncated: boolean };

interface GithubImportPanelProps {
  projectRoot: string | null;
  onImported: () => void;
}

export default function GithubImportPanel({ projectRoot, onImported }: GithubImportPanelProps) {
  const [input, setInput] = useState("");
  const [info, setInfo] = useState<RepoInfo | null>(null);
  const [results, setResults] = useState<RepoSearchResult[]>([]);
  const [searched, setSearched] = useState(false);
  const [resultScope, setResultScope] = useState<ResultScope | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [cloning, setCloning] = useState(false);
  const [cloneMessage, setCloneMessage] = useState<string | null>(null);
  const requestId = useRef(0);
  const requestInFlight = useRef(false);
  const busy = loading || cloning;

  function exactRepositoryInput(value: string): boolean {
    const trimmed = value.trim();
    return trimmed.includes("/") || /^https?:/i.test(trimmed);
  }

  function updateInput(value: string) {
    requestId.current += 1;
    setInput(value);
    setInfo(null);
    setResults([]);
    setSearched(false);
    setResultScope(null);
    setError(null);
    setCloneMessage(null);
  }

  async function lookup() {
    if (requestInFlight.current || cloning) return;
    const query = input.trim();
    if (!query) return;
    requestInFlight.current = true;
    const currentRequest = ++requestId.current;
    setLoading(true);
    setError(null);
    setInfo(null);
    setResults([]);
    setSearched(false);
    setResultScope(null);
    setCloneMessage(null);
    try {
      if (exactRepositoryInput(query)) {
        const exact = await window.api.github.fetchRepoInfo(query);
        if (requestId.current === currentRequest) setInfo(exact);
      } else {
        const organization = await window.api.github.listOrgRepos(query);
        if (requestId.current !== currentRequest) return;
        const matches = organization?.repositories ?? (await window.api.github.searchRepos(query));
        if (requestId.current === currentRequest) {
          setResults(matches);
          setSearched(true);
          setResultScope(
            organization
              ? { kind: "organization", organization: organization.organization, truncated: organization.truncated }
              : { kind: "search" },
          );
        }
      }
    } catch (err) {
      if (requestId.current === currentRequest) setError((err as Error).message);
    } finally {
      requestInFlight.current = false;
      if (requestId.current === currentRequest) setLoading(false);
    }
  }

  async function selectResult(result: RepoSearchResult) {
    if (requestInFlight.current || cloning) return;
    requestInFlight.current = true;
    const currentRequest = ++requestId.current;
    setLoading(true);
    setError(null);
    setInfo(null);
    setCloneMessage(null);
    try {
      // Re-run the strict exact lookup before a result can become cloneable.
      const exact = await window.api.github.fetchRepoInfo(result.fullName);
      if (requestId.current !== currentRequest) return;
      setInput(exact.fullName);
      setResults([]);
      setSearched(false);
      setResultScope(null);
      setInfo(exact);
    } catch (err) {
      if (requestId.current === currentRequest) setError((err as Error).message);
    } finally {
      requestInFlight.current = false;
      if (requestId.current === currentRequest) setLoading(false);
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
    <div className="github-import">
      <label className="field-label" htmlFor="github-repository-query">GitHub repository</label>
      <div className="field-hint">Search by repository or organization name, or paste an owner/repo or GitHub URL.</div>
      <div className="github-search-row">
        <input
          id="github-repository-query"
          value={input}
          onChange={(e) => updateInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && lookup()}
          placeholder="qb-core"
          disabled={busy}
        />
        <button className="btn" onClick={lookup} disabled={busy || !input.trim()}>
          {loading ? "Searching…" : "Search"}
        </button>
      </div>

      {error && <div className="error-text">{error}</div>}
      {searched && results.length === 0 && (
        <div className="github-empty">
          {resultScope?.kind === "organization"
            ? `${resultScope.organization} has no public repositories.`
            : "No matching public repositories found."}
        </div>
      )}

      {results.length > 0 && (
        <div className="repo-results" aria-label="GitHub repository search results">
          <div className="repo-results-heading">
            {resultScope?.kind === "organization"
              ? `${resultScope.organization} · ${results.length} public repositories`
              : "Repository matches"}
            {resultScope?.kind === "organization" && resultScope.truncated && (
              <span>Showing the first {results.length}.</span>
            )}
          </div>
          {results.map((result) => (
            <button
              type="button"
              className="repo-result"
              key={result.fullName}
              onClick={() => void selectResult(result)}
              disabled={busy}
            >
              <span className="repo-result-name">{result.fullName}</span>
              {result.description && <span className="repo-result-desc">{result.description}</span>}
              <span className="repo-result-meta">
                <span>⭐ {result.stars.toLocaleString()}</span>
                {result.language && <span>{result.language}</span>}
                <span className="repo-result-action">Select</span>
              </span>
            </button>
          ))}
        </div>
      )}

      {info && (
        <div className="repo-card">
          <div className="repo-name">{info.fullName}</div>
          {info.description && <div className="repo-desc">{info.description}</div>}
          <div className="repo-meta">
            <span>⭐ {info.stars.toLocaleString()}</span>
            {info.language && <span>{info.language}</span>}
            {info.license && <span>{info.license}</span>}
          </div>
          <div className="repo-card-actions">
            <button className="btn small" onClick={() => window.api.shell.openExternal(info.htmlUrl)} disabled={busy}>
              View on GitHub
            </button>
            <button className="btn small primary" onClick={clone} disabled={busy || !projectRoot}>
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
