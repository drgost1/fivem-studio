import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";

import { languageForPath } from "../editorLanguage";
import type {
  EditorPreferences,
  ResolvedTheme,
  ResourceContext,
  RevertResult,
  WorkspaceReplaceApplyResult,
  WorkspaceReplacePreview,
  WorkspaceSearchFileResult,
  WorkspaceSearchResult,
} from "../global";
import { t } from "../i18n";

const ChangeDiff = lazy(() => import("./ChangeDiff"));
const INITIAL_VISIBLE_MATCHES = 50;

interface SearchPanelProps {
  workspaceRoot: string | null;
  activeResource: ResourceContext | null;
  resolvedTheme: ResolvedTheme;
  editorPreferences: EditorPreferences;
  onOpenLocation: (path: string, line: number, column: number) => void;
  onFilesChanged: () => void;
}

function parseGlobs(value: string): string[] {
  return value.split(",").map((part) => part.trim()).filter(Boolean);
}

export default function SearchPanel({
  workspaceRoot,
  activeResource,
  resolvedTheme,
  editorPreferences,
  onOpenLocation,
  onFilesChanged,
}: SearchPanelProps) {
  const [query, setQuery] = useState("");
  const [replacement, setReplacement] = useState("");
  const [scope, setScope] = useState<"resource" | "workspace">(activeResource ? "resource" : "workspace");
  const scopeManuallyChanged = useRef(false);
  const [regex, setRegex] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [include, setInclude] = useState("");
  const [exclude, setExclude] = useState("");
  const [result, setResult] = useState<WorkspaceSearchResult | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set());
  const [visibleByFile, setVisibleByFile] = useState<Record<string, number>>({});
  const [preview, setPreview] = useState<WorkspaceReplacePreview | null>(null);
  const [previewFileIndex, setPreviewFileIndex] = useState(0);
  const [applied, setApplied] = useState<WorkspaceReplaceApplyResult | null>(null);
  const [undoResult, setUndoResult] = useState<RevertResult | null>(null);
  const [busy, setBusy] = useState<"search" | "preview" | "apply" | "undo" | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!activeResource && scope === "resource") setScope("workspace");
    else if (activeResource && !scopeManuallyChanged.current && !result) setScope("resource");
  }, [activeResource, result, scope]);

  const resourceScopeIdentity = scope === "resource" ? (activeResource?.rootPath ?? null) : null;
  useEffect(() => {
    setResult(null);
    setSelected(new Set());
    setExpandedFiles(new Set());
    setPreview(null);
    setApplied(null);
    setUndoResult(null);
    setError(null);
  }, [query, scope, regex, caseSensitive, wholeWord, include, exclude, resourceScopeIdentity]);

  const selectedIds = useMemo(() => [...selected], [selected]);

  async function runSearch() {
    if (!workspaceRoot) return;
    setBusy("search");
    setError(null);
    setPreview(null);
    setApplied(null);
    setUndoResult(null);
    try {
      const found = await window.api.search.run({
        scope,
        resourceRoot: scope === "resource" ? (activeResource?.rootPath ?? null) : null,
        query,
        regex,
        caseSensitive,
        wholeWord,
        include: parseGlobs(include),
        exclude: parseGlobs(exclude),
      });
      setResult(found);
      setSelected(new Set(found.files.flatMap((file) => file.matches.map((match) => match.id))));
      setExpandedFiles(new Set(found.files[0] ? [found.files[0].filePath] : []));
      setVisibleByFile({});
    } catch (searchError) {
      setResult(null);
      setSelected(new Set());
      setExpandedFiles(new Set());
      setError((searchError as Error).message || t("search.error.run"));
    } finally {
      setBusy(null);
    }
  }

  function toggleFile(file: WorkspaceSearchFileResult) {
    setPreview(null);
    setApplied(null);
    setSelected((current) => {
      const next = new Set(current);
      const allSelected = file.matches.every((match) => next.has(match.id));
      for (const match of file.matches) {
        if (allSelected) next.delete(match.id);
        else next.add(match.id);
      }
      return next;
    });
  }

  function toggleMatch(id: string) {
    setPreview(null);
    setApplied(null);
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function previewReplacement() {
    if (!result) return;
    setBusy("preview");
    setError(null);
    try {
      const next = await window.api.search.previewReplace(result.id, selectedIds, replacement);
      setPreview(next);
      setPreviewFileIndex(0);
    } catch (previewError) {
      setError((previewError as Error).message || t("search.error.preview"));
    } finally {
      setBusy(null);
    }
  }

  async function applyReplacement() {
    if (!result || !preview) return;
    setBusy("apply");
    setError(null);
    try {
      const next = await window.api.search.applyReplace(result.id, selectedIds, replacement);
      setApplied(next);
      setPreview(null);
      setUndoResult(null);
      onFilesChanged();
    } catch (applyError) {
      setError((applyError as Error).message || t("search.error.apply"));
    } finally {
      setBusy(null);
    }
  }

  async function undoBatch(mode: "all" | "safe") {
    if (!applied?.batchId) return;
    setBusy("undo");
    setError(null);
    try {
      const next = await window.api.revert.apply(applied.batchId, mode);
      setUndoResult(next);
      onFilesChanged();
    } catch (undoError) {
      setError((undoError as Error).message || t("search.error.undo"));
    } finally {
      setBusy(null);
    }
  }

  if (!workspaceRoot) return <div className="search-empty">{t("search.noWorkspace")}</div>;
  const activePreviewFile = preview?.files[Math.min(previewFileIndex, Math.max(0, preview.files.length - 1))];

  return (
    <div className="search-panel">
      <div className="search-controls">
        <div className="search-query-row">
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && busy === null) void runSearch();
            }}
            placeholder={t("search.queryPlaceholder")}
            aria-label={t("search.queryLabel")}
          />
          <button className="btn primary" type="button" onClick={() => void runSearch()} disabled={!query || busy !== null}>
            {busy === "search" ? t("search.searching") : t("search.run")}
          </button>
        </div>
        <div className="search-option-row">
          <label><input type="checkbox" checked={regex} onChange={(event) => setRegex(event.target.checked)} />{t("search.regex")}</label>
          <label><input type="checkbox" checked={caseSensitive} onChange={(event) => setCaseSensitive(event.target.checked)} />{t("search.caseSensitive")}</label>
          <label><input type="checkbox" checked={wholeWord} onChange={(event) => setWholeWord(event.target.checked)} />{t("search.wholeWord")}</label>
        </div>
        <label className="search-field-label">
          {t("search.scope")}
          <select
            value={scope}
            onChange={(event) => {
              scopeManuallyChanged.current = true;
              setScope(event.target.value as "resource" | "workspace");
            }}
          >
            <option value="resource" disabled={!activeResource}>
              {activeResource ? t("search.scopeResource", { resource: activeResource.name }) : t("search.scopeNoResource")}
            </option>
            <option value="workspace">{t("search.scopeWorkspace")}</option>
          </select>
        </label>
        <details className="search-globs">
          <summary>{t("search.fileFilters")}</summary>
          <label className="search-field-label">
            {t("search.include")}
            <input value={include} onChange={(event) => setInclude(event.target.value)} placeholder={t("search.includePlaceholder")} />
          </label>
          <label className="search-field-label">
            {t("search.exclude")}
            <input value={exclude} onChange={(event) => setExclude(event.target.value)} placeholder={t("search.excludePlaceholder")} />
          </label>
        </details>
        <div className="search-replace-row">
          <input
            value={replacement}
            onChange={(event) => {
              setReplacement(event.target.value);
              setPreview(null);
              setApplied(null);
            }}
            placeholder={t("search.replacePlaceholder")}
            aria-label={t("search.replaceLabel")}
          />
          <button
            className="btn"
            type="button"
            onClick={() => void previewReplacement()}
            disabled={!result || result.truncated || selected.size === 0 || busy !== null || applied !== null}
          >
            {busy === "preview" ? t("search.preparing") : t("search.preview")}
          </button>
        </div>
      </div>

      {error && <div className="search-error" role="alert">{error}</div>}
      {result && (
        <div className="search-summary" role="status">
          <span>{t("search.summary", { matches: result.totalMatches, files: result.files.length })}</span>
          <span>{t("search.scanned", { files: result.scannedFiles })}</span>
          {result.skippedCredentialFiles > 0 && <span>{t("search.credentialsSkipped", { files: result.skippedCredentialFiles })}</span>}
          {result.truncated && <strong>{t("search.truncated")}</strong>}
        </div>
      )}

      {applied && (
        <div className="search-apply-summary" role="status">
          <strong>{t("search.applied", { files: applied.filesChanged, hits: applied.hitsApplied })}</strong>
          {applied.skipped.length > 0 && (
            <details>
              <summary>{t("search.skipped", { files: applied.skipped.length })}</summary>
              {applied.skipped.map((entry) => <div key={entry.path}><code>{entry.path}</code> — {entry.reason}</div>)}
            </details>
          )}
          {applied.batchId && undoResult?.status !== "reverted" && (
            <div className="search-undo-actions">
              <button className="btn" type="button" onClick={() => void undoBatch("all")} disabled={busy !== null}>
                {busy === "undo" ? t("search.undoing") : t("search.undoBatch")}
              </button>
              {(undoResult?.status === "conflict" || undoResult?.status === "partial") && (
                <button className="btn" type="button" onClick={() => void undoBatch("safe")} disabled={busy !== null}>
                  {t("search.undoSafe")}
                </button>
              )}
            </div>
          )}
          {undoResult && (
            <div className={undoResult.status === "conflict" ? "search-undo-conflict" : "search-undo-result"}>
              {undoResult.status === "reverted"
                ? t("search.undoComplete", { files: undoResult.reverted.length })
                : undoResult.status === "partial"
                  ? t("search.undoPartial", { files: undoResult.reverted.length, skipped: undoResult.skipped.length })
                  : t("search.undoBlocked", { files: undoResult.skipped.length })}
            </div>
          )}
        </div>
      )}

      <div className="search-results">
        {result && result.files.length === 0 && <div className="search-empty">{t("search.noResults")}</div>}
        {result?.files.map((file) => {
          const selectedCount = file.matches.filter((match) => selected.has(match.id)).length;
          const visibleCount = visibleByFile[file.filePath] ?? INITIAL_VISIBLE_MATCHES;
          return (
            <details
              className="search-file-group"
              key={file.filePath}
              open={expandedFiles.has(file.filePath)}
              onToggle={(event) => {
                const open = event.currentTarget.open;
                setExpandedFiles((current) => {
                  const next = new Set(current);
                  if (open) next.add(file.filePath);
                  else next.delete(file.filePath);
                  return next;
                });
              }}
            >
              <summary>
                <input
                  type="checkbox"
                  checked={selectedCount === file.matches.length}
                  aria-checked={selectedCount > 0 && selectedCount < file.matches.length ? "mixed" : selectedCount === file.matches.length}
                  onClick={(event) => event.stopPropagation()}
                  onChange={() => toggleFile(file)}
                />
                <span title={file.filePath}>{file.relativePath}</span>
                <small>{selectedCount}/{file.matches.length}</small>
              </summary>
              <div className="search-file-matches">
                {file.matches.slice(0, visibleCount).map((match) => (
                  <div className="search-match" key={match.id}>
                    <label>
                      <input type="checkbox" checked={selected.has(match.id)} onChange={() => toggleMatch(match.id)} />
                    </label>
                    <button type="button" onClick={() => onOpenLocation(match.filePath, match.line, match.column)}>
                      <span className="search-match-location">{match.line}:{match.column}</span>
                      {match.before.map((line, index) => (
                        <code className="context" key={`before-${index}`}>{match.line - match.before.length + index}  {line}</code>
                      ))}
                      <code className="hit">{match.line}  {match.text}</code>
                      {match.after.map((line, index) => (
                        <code className="context" key={`after-${index}`}>{match.endLine + index + 1}  {line}</code>
                      ))}
                    </button>
                  </div>
                ))}
                {visibleCount < file.matches.length && (
                  <button
                    className="search-show-more"
                    type="button"
                    onClick={() => setVisibleByFile((current) => ({
                      ...current,
                      [file.filePath]: visibleCount + INITIAL_VISIBLE_MATCHES,
                    }))}
                  >
                    {t("search.showMore", { count: Math.min(INITIAL_VISIBLE_MATCHES, file.matches.length - visibleCount) })}
                  </button>
                )}
              </div>
            </details>
          );
        })}
      </div>

      {preview && activePreviewFile && (
        <div className="search-preview-backdrop" role="presentation">
          <section className="search-preview-dialog" role="dialog" aria-modal="true" aria-labelledby="search-preview-title">
            <header>
              <div>
                <strong id="search-preview-title">{t("search.previewTitle")}</strong>
                <span>{t("search.previewSummary", { files: preview.files.length, hits: preview.totalHits })}</span>
              </div>
              <div className="search-preview-actions">
                <button className="btn" type="button" onClick={() => setPreview(null)} disabled={busy !== null}>{t("search.backToResults")}</button>
                <button className="btn primary" type="button" onClick={() => void applyReplacement()} disabled={busy !== null}>
                  {busy === "apply" ? t("search.applying") : t("search.apply")}
                </button>
              </div>
            </header>
            <div className="search-preview-body">
              <nav aria-label={t("search.previewFiles")}>
                {preview.files.map((file, index) => (
                  <button
                    type="button"
                    className={index === previewFileIndex ? "active" : ""}
                    key={file.filePath}
                    onClick={() => setPreviewFileIndex(index)}
                  >
                    <span>{file.relativePath}</span>
                    <small>{t("search.hitCount", { count: file.hitCount })}</small>
                  </button>
                ))}
              </nav>
              <div className="search-preview-diff">
                <Suspense fallback={<div className="search-empty">{t("search.loadingDiff")}</div>}>
                  <ChangeDiff
                    id={`${preview.searchId}:${activePreviewFile.filePath}`}
                    original={activePreviewFile.originalContent}
                    modified={activePreviewFile.modifiedContent}
                    language={languageForPath(activePreviewFile.filePath)}
                    fontSize={editorPreferences.fontSize}
                    wordWrap={editorPreferences.wordWrap}
                    resolvedTheme={resolvedTheme}
                  />
                </Suspense>
              </div>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
