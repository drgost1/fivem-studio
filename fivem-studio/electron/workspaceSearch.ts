import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { readTextFileSnapshot, writeTextFile } from "./fsTree";
import { resolveInsideRoot } from "./pathSafety";
import { isCredentialBearingFile, type RevertStore } from "./revertStore";

const SKIP_DIRS = new Set([".git", "node_modules", ".vscode", "cache"]);
const MAX_QUERY_LENGTH = 256;
const MAX_GLOBS = 20;
const MAX_GLOB_LENGTH = 200;
const MAX_UI_MATCHES = 5_000;
const MAX_MATCHES_PER_FILE = 1_000;
const MAX_UI_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_SEARCH_BYTES = 64 * 1024 * 1024;
const MAX_SCANNED_FILES = 5_000;
const MAX_PREVIEW_BYTES = 24 * 1024 * 1024;
const SESSION_TTL_MS = 15 * 60 * 1_000;
const MAX_SESSIONS = 4;
const MAX_PREVIEWS = 8;

export interface WorkspaceSearchRequest {
  query: string;
  regex: boolean;
  caseSensitive: boolean;
  wholeWord: boolean;
  include: string[];
  exclude: string[];
}

export interface WorkspaceSearchMatch {
  id: string;
  filePath: string;
  relativePath: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  text: string;
  before: string[];
  after: string[];
}

export interface WorkspaceSearchFileResult {
  filePath: string;
  relativePath: string;
  revision: string;
  matches: WorkspaceSearchMatch[];
}

export interface WorkspaceSearchResult {
  id: string;
  files: WorkspaceSearchFileResult[];
  totalMatches: number;
  truncated: boolean;
  scannedFiles: number;
  skippedCredentialFiles: number;
}

export interface WorkspaceReplaceFilePreview {
  filePath: string;
  relativePath: string;
  originalContent: string;
  modifiedContent: string;
  hitCount: number;
}

export interface WorkspaceReplacePreview {
  searchId: string;
  applyToken: string;
  files: WorkspaceReplaceFilePreview[];
  totalHits: number;
}

export interface WorkspaceReplaceApplyResult {
  searchId: string;
  batchId: string | null;
  filesChanged: number;
  hitsApplied: number;
  changedPaths: string[];
  skipped: Array<{ path: string; reason: string }>;
}

interface InternalMatch extends WorkspaceSearchMatch {
  start: number;
  end: number;
  captures: Array<string | undefined>;
  namedCaptures: Record<string, string>;
}

interface SearchFileSession {
  filePath: string;
  relativePath: string;
  content: string;
  revision: string;
  matches: InternalMatch[];
}

interface SearchSession {
  id: string;
  workspaceRoot: string;
  query: string;
  regex: boolean;
  truncated: boolean;
  createdAt: number;
  files: SearchFileSession[];
}

interface PreparedReplaceFile extends WorkspaceReplaceFilePreview {
  revision: string;
}

interface ReplacePreviewSession {
  token: string;
  searchId: string;
  workspaceRoot: string;
  createdAt: number;
  changes: PreparedReplaceFile[];
}

function forwardSlashes(value: string): string {
  return value.split(path.sep).join("/");
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function validateRegexPattern(pattern: string): void {
  if (pattern.length > MAX_QUERY_LENGTH) throw new Error(`Regular expressions are limited to ${MAX_QUERY_LENGTH} characters.`);
  if (/\\[1-9]/.test(pattern)) throw new Error("Regular-expression backreferences are disabled because they can make workspace searches unbounded.");
  if (/\((?:[^()]|\\.)*[+*{](?:[^()]|\\.)*\)\s*[+*{]/.test(pattern)) {
    throw new Error("Nested regular-expression quantifiers are disabled because they can make workspace searches unbounded.");
  }
}

function searchRegex(request: WorkspaceSearchRequest): RegExp {
  const source = request.regex ? request.query : escapeRegex(request.query);
  if (request.regex) validateRegexPattern(source);
  const bounded = request.wholeWord ? `(?<![A-Za-z0-9_])(?:${source})(?![A-Za-z0-9_])` : source;
  try {
    return new RegExp(bounded, `gu${request.caseSensitive ? "" : "i"}`);
  } catch (error) {
    throw new Error(`Invalid regular expression: ${(error as Error).message}`);
  }
}

function validateGlobs(values: unknown, label: string): string[] {
  if (!Array.isArray(values) || values.length > MAX_GLOBS || values.some((value) => typeof value !== "string" || value.length > MAX_GLOB_LENGTH)) {
    throw new Error(`${label} must contain at most ${MAX_GLOBS} patterns of ${MAX_GLOB_LENGTH} characters each.`);
  }
  return values.map((value) => value.trim().replace(/\\/g, "/")).filter(Boolean);
}

function globRegex(glob: string): RegExp {
  let source = "^";
  for (let index = 0; index < glob.length; index += 1) {
    const character = glob[index];
    if (character === "*") {
      if (glob[index + 1] === "*") {
        index += 1;
        source += ".*";
      } else {
        source += "[^/]*";
      }
    } else if (character === "?") {
      source += "[^/]";
    } else {
      source += escapeRegex(character);
    }
  }
  return new RegExp(`${source}$`, process.platform === "win32" ? "i" : "");
}

function compileGlobs(globs: string[]): RegExp[] {
  return globs.map(globRegex);
}

function lineStarts(content: string): number[] {
  const starts = [0];
  for (let index = 0; index < content.length; index += 1) {
    if (content.charCodeAt(index) === 10) starts.push(index + 1);
  }
  return starts;
}

function lineIndexAt(starts: number[], offset: number): number {
  let low = 0;
  let high = starts.length;
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2);
    if (starts[middle] <= offset) low = middle;
    else high = middle;
  }
  return low;
}

function normalizedRoot(value: string): string {
  let resolved: string;
  try { resolved = fs.realpathSync(value); } catch { resolved = path.resolve(value); }
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function expandReplacement(template: string, match: InternalMatch, content: string): string {
  return template.replace(/\$(\$|&|`|'|<[^>]+>|\d{1,2})/g, (token, marker: string) => {
    if (marker === "$") return "$";
    if (marker === "&") return content.slice(match.start, match.end);
    if (marker === "`") return content.slice(0, match.start);
    if (marker === "'") return content.slice(match.end);
    if (marker.startsWith("<")) return match.namedCaptures[marker.slice(1, -1)] ?? "";
    const index = Number(marker);
    if (!Number.isInteger(index) || index < 1 || index > match.captures.length) return token;
    return match.captures[index - 1] ?? "";
  });
}

export class WorkspaceSearchService {
  private readonly sessions = new Map<string, SearchSession>();
  private readonly previews = new Map<string, ReplacePreviewSession>();

  constructor(private readonly revertStore: RevertStore) {}

  search(workspaceRoot: string, scopeRoot: string, rawRequest: unknown): WorkspaceSearchResult {
    this.pruneSessions();
    if (!rawRequest || typeof rawRequest !== "object" || Array.isArray(rawRequest)) throw new Error("Search options must be an object.");
    const raw = rawRequest as Record<string, unknown>;
    const query = typeof raw.query === "string" ? raw.query : "";
    if (!query || query.length > MAX_QUERY_LENGTH) throw new Error(`Search text must be between 1 and ${MAX_QUERY_LENGTH} characters.`);
    const request: WorkspaceSearchRequest = {
      query,
      regex: raw.regex === true,
      caseSensitive: raw.caseSensitive === true,
      wholeWord: raw.wholeWord === true,
      include: validateGlobs(raw.include, "Include globs"),
      exclude: validateGlobs(raw.exclude, "Exclude globs"),
    };
    const matcher = searchRegex(request);
    const root = fs.realpathSync(workspaceRoot);
    const scope = resolveInsideRoot(root, path.relative(root, scopeRoot));
    const include = compileGlobs(request.include);
    const exclude = compileGlobs(request.exclude);
    const files: SearchFileSession[] = [];
    let totalMatches = 0;
    let totalBytes = 0;
    let scannedFiles = 0;
    let skippedCredentialFiles = 0;
    let truncated = false;

    const walk = (directory: string): void => {
      if (truncated) return;
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (truncated) break;
        const target = path.join(directory, entry.name);
        const relativePath = forwardSlashes(path.relative(root, target));
        try { resolveInsideRoot(root, path.relative(root, target)); } catch { continue; }
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          if (!SKIP_DIRS.has(entry.name)) walk(target);
          continue;
        }
        if (!entry.isFile()) continue;
        if (include.length > 0 && !include.some((pattern) => pattern.test(relativePath))) continue;
        if (exclude.some((pattern) => pattern.test(relativePath))) continue;
        if (isCredentialBearingFile(target)) {
          skippedCredentialFiles += 1;
          continue;
        }
        let stat: fs.Stats;
        try { stat = fs.statSync(target); } catch { continue; }
        if (stat.size > MAX_UI_FILE_BYTES) continue;
        scannedFiles += 1;
        totalBytes += stat.size;
        if (scannedFiles > MAX_SCANNED_FILES || totalBytes > MAX_TOTAL_SEARCH_BYTES) {
          truncated = true;
          break;
        }
        let snapshot: ReturnType<typeof readTextFileSnapshot>;
        try { snapshot = readTextFileSnapshot(target); } catch { continue; }
        const content = snapshot.content;
        if (content.slice(0, 8_192).includes("\0")) continue;
        if (isCredentialBearingFile(target, content)) {
          skippedCredentialFiles += 1;
          continue;
        }
        const starts = lineStarts(content);
        const lines = content.split(/\r?\n/);
        const matches: InternalMatch[] = [];
        matcher.lastIndex = 0;
        let found: RegExpExecArray | null;
        while ((found = matcher.exec(content)) !== null) {
          const start = found.index;
          const end = start + found[0].length;
          const startLineIndex = lineIndexAt(starts, start);
          const endLineIndex = lineIndexAt(starts, Math.max(start, end - 1));
          const id = `${files.length}:${matches.length}`;
          matches.push({
            id,
            filePath: target,
            relativePath,
            line: startLineIndex + 1,
            column: start - starts[startLineIndex] + 1,
            endLine: endLineIndex + 1,
            endColumn: end - starts[endLineIndex] + 1,
            text: (lines[startLineIndex] ?? "").slice(0, 400),
            before: lines.slice(Math.max(0, startLineIndex - 2), startLineIndex).map((line) => line.slice(0, 400)),
            after: lines.slice(endLineIndex + 1, endLineIndex + 3).map((line) => line.slice(0, 400)),
            start,
            end,
            captures: found.slice(1),
            namedCaptures: Object.fromEntries(Object.entries(found.groups ?? {}).map(([name, value]) => [name, value ?? ""])),
          });
          totalMatches += 1;
          if (found[0].length === 0) matcher.lastIndex += 1;
          if (matches.length >= MAX_MATCHES_PER_FILE || totalMatches >= MAX_UI_MATCHES) {
            truncated = true;
            break;
          }
        }
        if (matches.length > 0) {
          files.push({ filePath: target, relativePath, content, revision: snapshot.revision, matches });
        }
      }
    };
    walk(scope);

    const id = randomUUID();
    this.sessions.set(id, {
      id,
      workspaceRoot: root,
      query,
      regex: request.regex,
      truncated,
      createdAt: Date.now(),
      files,
    });
    this.pruneSessions();
    return {
      id,
      files: files.map((file) => ({
        filePath: file.filePath,
        relativePath: file.relativePath,
        revision: file.revision,
        matches: file.matches.map(({ start: _start, end: _end, captures: _captures, namedCaptures: _named, ...match }) => match),
      })),
      totalMatches,
      truncated,
      scannedFiles,
      skippedCredentialFiles,
    };
  }

  preview(workspaceRoot: string, searchId: string, selectedIds: unknown, replacement: unknown): WorkspaceReplacePreview {
    const session = this.requireSession(workspaceRoot, searchId);
    if (session.truncated) throw new Error("Narrow this search before replacing; truncated results cannot produce a complete preview.");
    const changes = this.buildChanges(session, selectedIds, replacement);
    const bytes = changes.reduce((total, file) => total + Buffer.byteLength(file.originalContent) + Buffer.byteLength(file.modifiedContent), 0);
    if (bytes > MAX_PREVIEW_BYTES) throw new Error("The replacement preview is too large. Narrow the scope or include globs.");
    const applyToken = randomUUID();
    this.previews.set(applyToken, {
      token: applyToken,
      searchId,
      workspaceRoot: session.workspaceRoot,
      createdAt: Date.now(),
      changes,
    });
    this.pruneSessions();
    return {
      searchId,
      applyToken,
      files: changes.map(({ revision: _revision, ...file }) => file),
      totalHits: changes.reduce((total, file) => total + file.hitCount, 0),
    };
  }

  apply(workspaceRoot: string, applyToken: string): WorkspaceReplaceApplyResult {
    this.pruneSessions();
    if (typeof applyToken !== "string" || applyToken.length > 128) throw new Error("Replacement preview token is invalid.");
    const preview = this.previews.get(applyToken);
    if (!preview || normalizedRoot(preview.workspaceRoot) !== normalizedRoot(workspaceRoot)) {
      throw new Error("This replacement preview expired, was already applied, or belongs to another workspace. Preview it again.");
    }
    // Consume before touching disk. Retrying an ambiguous request must never
    // apply a reviewed batch twice.
    this.previews.delete(applyToken);
    const changes = preview.changes;
    const prepared = this.revertStore.prepareBatch(
      workspaceRoot,
      `Search replace: ${this.sessions.get(preview.searchId)?.query.slice(0, 80) ?? "reviewed batch"}`,
      changes.map((file) => ({ filePath: file.filePath, nextContent: file.modifiedContent })),
    );
    if (!prepared || prepared.fileCount !== changes.length) {
      if (prepared) this.revertStore.discardBatch(workspaceRoot, prepared.id);
      throw new Error("The replacement touches credential-bearing content and was refused before any files were written.");
    }

    const changedPaths: string[] = [];
    const skipped: Array<{ path: string; reason: string }> = [];
    let hitsApplied = 0;
    for (const change of changes) {
      try {
        writeTextFile(change.filePath, change.modifiedContent, change.revision);
        changedPaths.push(change.filePath);
        hitsApplied += change.hitCount;
      } catch (error) {
        skipped.push({ path: change.relativePath, reason: (error as Error).message || "File changed after the preview." });
      }
    }
    const finalized = this.revertStore.retainBatchEntries(workspaceRoot, prepared.id, changedPaths);
    return {
      searchId: preview.searchId,
      batchId: finalized?.id ?? null,
      filesChanged: changedPaths.length,
      hitsApplied,
      changedPaths,
      skipped,
    };
  }

  private buildChanges(session: SearchSession, selectedIds: unknown, replacement: unknown): PreparedReplaceFile[] {
    if (!Array.isArray(selectedIds) || selectedIds.length === 0 || selectedIds.length > MAX_UI_MATCHES || selectedIds.some((id) => typeof id !== "string" || id.length > 64)) {
      throw new Error("Select between 1 and 5000 search hits before replacing.");
    }
    if (typeof replacement !== "string" || Buffer.byteLength(replacement, "utf8") > 100 * 1024) {
      throw new Error("Replacement text is limited to 100KB.");
    }
    const selectedMatchIds = selectedIds as string[];
    const known = new Map(session.files.flatMap((file) => file.matches.map((match) => [match.id, match] as const)));
    const selected = new Set(selectedMatchIds);
    for (const id of selected) if (!known.has(id)) throw new Error("The replacement selection is stale. Run the search again.");

    const changes: PreparedReplaceFile[] = [];
    for (const file of session.files) {
      const matches = file.matches.filter((match) => selected.has(match.id));
      if (matches.length === 0) continue;
      let modified = file.content;
      for (const match of matches.slice().sort((a, b) => b.start - a.start)) {
        const inserted = session.regex ? expandReplacement(replacement, match, file.content) : replacement;
        modified = `${modified.slice(0, match.start)}${inserted}${modified.slice(match.end)}`;
      }
      if (Buffer.byteLength(modified, "utf8") > MAX_UI_FILE_BYTES) {
        throw new Error(`Replacement would make ${file.relativePath} exceed the ${MAX_UI_FILE_BYTES / 1024 / 1024}MB safety limit.`);
      }
      if (modified !== file.content) {
        changes.push({
          filePath: file.filePath,
          relativePath: file.relativePath,
          originalContent: file.content,
          modifiedContent: modified,
          hitCount: matches.length,
          revision: file.revision,
        });
      }
    }
    if (changes.length === 0) throw new Error("The selected replacement would not change any files.");
    return changes;
  }

  private requireSession(workspaceRoot: string, searchId: string): SearchSession {
    this.pruneSessions();
    const session = this.sessions.get(searchId);
    if (!session || normalizedRoot(session.workspaceRoot) !== normalizedRoot(workspaceRoot)) {
      throw new Error("This search preview expired or belongs to another workspace. Run it again.");
    }
    return session;
  }

  private pruneSessions(): void {
    const cutoff = Date.now() - SESSION_TTL_MS;
    for (const [id, session] of this.sessions) if (session.createdAt < cutoff) this.sessions.delete(id);
    for (const [token, preview] of this.previews) if (preview.createdAt < cutoff) this.previews.delete(token);
    while (this.sessions.size > MAX_SESSIONS) this.sessions.delete(this.sessions.keys().next().value!);
    while (this.previews.size > MAX_PREVIEWS) this.previews.delete(this.previews.keys().next().value!);
  }
}
