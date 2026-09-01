import { useCallback, useEffect, useState } from "react";
import type { GitActionResult, WorkspaceGitRepo } from "../global";

interface WorkspaceReposPanelProps {
  /** Bumped by the file tree when workspace contents change. */
  refreshKey: number;
}

/** Git repositories found inside the workspace's resources folder — local or
 * on the remote host — with pull / push / commit per repository. */
export default function WorkspaceReposPanel({ refreshKey }: WorkspaceReposPanelProps) {
  const [repos, setRepos] = useState<WorkspaceGitRepo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [commitFor, setCommitFor] = useState<string | null>(null);
  const [commitMessage, setCommitMessage] = useState("");
  const [outputs, setOutputs] = useState<Record<string, GitActionResult>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setRepos(await window.api.git.listWorkspaceRepos());
    } catch (loadError) {
      setRepos(null);
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  async function act(repo: WorkspaceGitRepo, action: "pull" | "push" | "commit") {
    if (actionBusy) return;
    setActionBusy(`${repo.path}:${action}`);
    try {
      const result = await window.api.git.repoAction(repo.path, action, action === "commit" ? commitMessage : undefined);
      setOutputs((current) => ({ ...current, [repo.path]: result }));
      if (result.ok) {
        if (action === "commit") {
          setCommitFor(null);
          setCommitMessage("");
        }
        void load();
      }
    } catch (actionError) {
      setOutputs((current) => ({
        ...current,
        [repo.path]: { ok: false, output: actionError instanceof Error ? actionError.message : String(actionError) },
      }));
    } finally {
      setActionBusy(null);
    }
  }

  return (
    <div className="git-repos">
      <div className="git-repos-header">
        <strong>Workspace repositories</strong>
        <button className="btn small" type="button" onClick={() => void load()} disabled={loading || actionBusy !== null}>
          {loading ? "Scanning…" : "Refresh"}
        </button>
      </div>
      <div className="field-hint">
        Git repositories inside <code>resources/</code> — on the remote host when one is connected. Push and pull
        use the credentials already configured where the repository lives.
      </div>
      {error ? <div className="error-text">{error}</div> : null}
      {repos !== null && repos.length === 0 && !loading ? (
        <div className="field-hint">No git repositories found under resources/.</div>
      ) : null}
      <ul className="git-repo-list">
        {(repos ?? []).map((repo) => {
          const busyHere = actionBusy?.startsWith(`${repo.path}:`) ?? false;
          const output = outputs[repo.path];
          return (
            <li key={repo.path} className="git-repo-row">
              <div className="git-repo-title" title={repo.path}>
                <span className="git-repo-name">{repo.name}</span>
                <span className="git-repo-meta">
                  {repo.detached ? "detached" : repo.branch ?? "no branch"}
                  {repo.hasUpstream ? ` ↑${repo.ahead} ↓${repo.behind}` : " · no upstream"}
                  {repo.dirty > 0 ? ` · ${repo.dirty} changed` : ""}
                </span>
              </div>
              <div className="git-repo-actions">
                <button
                  className="btn small"
                  type="button"
                  disabled={busyHere || actionBusy !== null || !repo.hasUpstream}
                  title={repo.hasUpstream ? "git pull --ff-only" : "This branch has no upstream to pull from."}
                  onClick={() => void act(repo, "pull")}
                >
                  {actionBusy === `${repo.path}:pull` ? "Pulling…" : "Pull"}
                </button>
                <button
                  className="btn small"
                  type="button"
                  disabled={busyHere || actionBusy !== null || !repo.hasUpstream}
                  title={repo.hasUpstream ? "git push" : "This branch has no upstream to push to."}
                  onClick={() => void act(repo, "push")}
                >
                  {actionBusy === `${repo.path}:push` ? "Pushing…" : "Push"}
                </button>
                <button
                  className="btn small"
                  type="button"
                  disabled={busyHere || actionBusy !== null || repo.dirty === 0}
                  title={repo.dirty > 0 ? "git add -A && git commit" : "Nothing to commit."}
                  onClick={() => setCommitFor((current) => (current === repo.path ? null : repo.path))}
                >
                  Commit
                </button>
              </div>
              {commitFor === repo.path ? (
                <div className="git-repo-commit">
                  <input
                    type="text"
                    value={commitMessage}
                    placeholder="commit message"
                    onChange={(event) => setCommitMessage(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && commitMessage.trim()) void act(repo, "commit");
                    }}
                  />
                  <button
                    className="btn small primary"
                    type="button"
                    disabled={!commitMessage.trim() || actionBusy !== null}
                    onClick={() => void act(repo, "commit")}
                  >
                    {actionBusy === `${repo.path}:commit` ? "Committing…" : "Go"}
                  </button>
                </div>
              ) : null}
              {output ? (
                <pre className={`git-repo-output ${output.ok ? "" : "is-error"}`} onDoubleClick={() =>
                  setOutputs((current) => {
                    const next = { ...current };
                    delete next[repo.path];
                    return next;
                  })
                }>{output.output || (output.ok ? "Done." : "Failed with no output.")}</pre>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
