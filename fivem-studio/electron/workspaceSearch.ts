import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";

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
const REGEX_EXECUTION_TIMEOUT_MS = 1_000;
const REGEX_SEARCH_TIMEOUT_MS = 10_000;

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

interface RegexDescriptor {
  source: string;
  flags: string;
}

interface RegexWorkerMatch {
  index: number;
  text: string;
  captures: Array<string | undefined>;
  namedCaptures: Record<string, string>;
}

interface RegexWorkerResponse {
  id: number;
  matches?: RegexWorkerMatch[];
  error?: string;
}

interface RegexGroupRisk {
  containsQuantifier: boolean;
}

interface RegexAtomRisk {
  group?: RegexGroupRisk;
}

interface RegexExecutionLimits {
  perFileMs: number;
  totalMs: number;
}

const DEFAULT_REGEX_EXECUTION_LIMITS: Readonly<RegexExecutionLimits> = {
  perFileMs: REGEX_EXECUTION_TIMEOUT_MS,
  totalMs: REGEX_SEARCH_TIMEOUT_MS,
};

function forwardSlashes(value: string): string {
  return value.split(path.sep).join("/");
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function quantifierEnd(pattern: string, index: number): number {
  const marker = pattern[index];
  if (marker === "*" || marker === "+" || marker === "?") return index;
  if (marker !== "{") return -1;
  let cursor = index + 1;
  const minimumStart = cursor;
  while (cursor < pattern.length && pattern.charCodeAt(cursor) >= 48 && pattern.charCodeAt(cursor) <= 57) cursor += 1;
  if (cursor === minimumStart) return -1;
  if (pattern[cursor] === ",") {
    cursor += 1;
    while (cursor < pattern.length && pattern.charCodeAt(cursor) >= 48 && pattern.charCodeAt(cursor) <= 57) cursor += 1;
  }
  return pattern[cursor] === "}" ? cursor : -1;
}

function isUnboundedQuantifier(pattern: string, index: number, end: number): boolean {
  if (pattern[index] === "*" || pattern[index] === "+") return true;
  if (pattern[index] !== "{") return false;
  const comma = pattern.indexOf(",", index + 1);
  return comma >= 0 && comma < end && comma + 1 === end;
}

function validateRegexPattern(pattern: string): void {
  if (pattern.length > MAX_QUERY_LENGTH) throw new Error(`Regular expressions are limited to ${MAX_QUERY_LENGTH} characters.`);
  // This scanner must remain linear: applying another backtracking expression
  // to the user-controlled pattern would merely move the ReDoS sink here.
  const groups: RegexGroupRisk[] = [];
  let inCharacterClass = false;
  let escaped = false;
  let lastAtom: RegexAtomRisk | null = null;

  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (escaped) {
      if (!inCharacterClass && ((character >= "1" && character <= "9") || (character === "k" && pattern[index + 1] === "<"))) {
        throw new Error("Regular-expression backreferences are disabled because they can make workspace searches unbounded.");
      }
      escaped = false;
      lastAtom = {};
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (inCharacterClass) {
      if (character === "]") {
        inCharacterClass = false;
        lastAtom = {};
      }
      continue;
    }
    if (character === "[") {
      inCharacterClass = true;
      continue;
    }
    if (character === "(") {
      groups.push({ containsQuantifier: false });
      lastAtom = null;
      continue;
    }
    if (character === "|") {
      lastAtom = null;
      continue;
    }
    if (character === ")") {
      const group = groups.pop();
      if (group) {
        const parent = groups[groups.length - 1];
        if (parent) {
          parent.containsQuantifier ||= group.containsQuantifier;
        }
        lastAtom = { group };
      } else {
        lastAtom = null;
      }
      continue;
    }

    const end = quantifierEnd(pattern, index);
    if (end >= index && lastAtom) {
      if (lastAtom.group?.containsQuantifier && isUnboundedQuantifier(pattern, index, end)) {
        throw new Error("Nested regular-expression quantifiers are disabled because they can make workspace searches unbounded.");
      }
      const group = groups[groups.length - 1];
      if (group) group.containsQuantifier = true;
      index = end;
      continue;
    }
    lastAtom = {};
  }
}

function searchRegex(request: WorkspaceSearchRequest): RegexDescriptor {
  const source = request.regex ? request.query : escapeRegex(request.query);
  if (request.regex) validateRegexPattern(source);
  const bounded = request.wholeWord ? `(?<![A-Za-z0-9_])(?:${source})(?![A-Za-z0-9_])` : source;
  return { source: bounded, flags: `gu${request.caseSensitive ? "" : "i"}` };
}

function executeTrustedRegex(descriptor: RegexDescriptor, content: string, maxMatches: number): RegexWorkerMatch[] {
  const matcher = new RegExp(descriptor.source, descriptor.flags);
  const matches: RegexWorkerMatch[] = [];
  let found: RegExpExecArray | null;
  while (matches.length < maxMatches && (found = matcher.exec(content)) !== null) {
    matches.push({
      index: found.index,
      text: found[0],
      captures: found.slice(1),
      namedCaptures: Object.fromEntries(Object.entries(found.groups ?? {}).map(([name, value]) => [name, value ?? ""])),
    });
    if (found[0].length === 0) {
      const codePoint = content.codePointAt(matcher.lastIndex);
      matcher.lastIndex += codePoint !== undefined && codePoint > 0xffff ? 2 : 1;
    }
  }
  return matches;
}

class BoundedRegexRunner {
  private readonly worker = new Worker(path.join(__dirname, "workspaceSearchWorker.js"));
  private nextId = 1;
  private pending: {
    id: number;
    timer: NodeJS.Timeout;
    resolve: (matches: RegexWorkerMatch[]) => void;
    reject: (error: Error) => void;
  } | null = null;
  private stopped = false;
  private termination: Promise<number> | null = null;

  constructor() {
    this.worker.on("message", (response: RegexWorkerResponse) => {
      if (!this.pending || response.id !== this.pending.id) return;
      const pending = this.pending;
      this.pending = null;
      clearTimeout(pending.timer);
      if (response.error) pending.reject(new Error(`Invalid regular expression: ${response.error}`));
      else pending.resolve(response.matches ?? []);
    });
    this.worker.on("error", (error) => this.fail(error));
    this.worker.on("exit", (code) => {
      if (!this.stopped) this.fail(new Error(`The bounded regular-expression worker exited unexpectedly with code ${code}.`));
    });
  }

  run(
    descriptor: RegexDescriptor,
    content: string,
    maxMatches: number,
    timeoutMs: number,
    timeoutScope: "file" | "search",
  ): Promise<RegexWorkerMatch[]> {
    if (this.pending) throw new Error("A bounded regular-expression search is already running.");
    if (this.stopped) throw new Error("The bounded regular-expression worker is unavailable.");
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending || this.pending.id !== id) return;
        this.pending = null;
        void this.terminateWorker().catch(() => undefined);
        reject(new Error(timeoutScope === "search"
          ? "Regular-expression evaluation exceeded the whole-search safety limit. Narrow the scope or simplify the expression."
          : "Regular-expression evaluation exceeded the per-file safety limit. Narrow or simplify the expression."));
      }, Math.max(1, Math.ceil(timeoutMs)));
      this.pending = { id, timer, resolve, reject };
      this.worker.postMessage({ id, ...descriptor, content, maxMatches });
    });
  }

  async dispose(): Promise<void> {
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(new Error("The bounded regular-expression worker was stopped."));
      this.pending = null;
    }
    await this.terminateWorker();
  }

  private fail(error: Error): void {
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(error);
      this.pending = null;
    }
    this.stopped = true;
  }

  private terminateWorker(): Promise<number> {
    this.stopped = true;
    this.termination ??= this.worker.terminate();
    return this.termination;
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
  private searchActive = false;

  constructor(
    private readonly revertStore: RevertStore,
    private readonly regexExecutionLimits: Readonly<RegexExecutionLimits> = DEFAULT_REGEX_EXECUTION_LIMITS,
  ) {}

  async search(workspaceRoot: string, scopeRoot: string, rawRequest: unknown): Promise<WorkspaceSearchResult> {
    if (this.searchActive) throw new Error("A workspace search is already running. Wait for it to finish before starting another.");
    this.searchActive = true;
    try {
      return await this.runSearch(workspaceRoot, scopeRoot, rawRequest);
    } finally {
      this.searchActive = false;
    }
  }

  private async runSearch(workspaceRoot: string, scopeRoot: string, rawRequest: unknown): Promise<WorkspaceSearchResult> {
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
    const descriptor = searchRegex(request);
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
    const regexRunner = request.regex ? new BoundedRegexRunner() : null;
    const regexDeadline = regexRunner ? Date.now() + this.regexExecutionLimits.totalMs : 0;

    const runBoundedRegex = async (content: string, maxMatches: number): Promise<RegexWorkerMatch[]> => {
      if (!regexRunner) return executeTrustedRegex(descriptor, content, maxMatches);
      const remainingMs = regexDeadline - Date.now();
      if (remainingMs <= 0) {
        throw new Error("Regular-expression evaluation exceeded the whole-search safety limit. Narrow the scope or simplify the expression.");
      }
      const timeoutScope = remainingMs <= this.regexExecutionLimits.perFileMs ? "search" : "file";
      const matches = await regexRunner.run(
        descriptor,
        content,
        maxMatches,
        Math.min(this.regexExecutionLimits.perFileMs, remainingMs),
        timeoutScope,
      );
      if (Date.now() >= regexDeadline) {
        throw new Error("Regular-expression evaluation exceeded the whole-search safety limit. Narrow the scope or simplify the expression.");
      }
      return matches;
    };

    const walk = async (directory: string): Promise<void> => {
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
          if (!SKIP_DIRS.has(entry.name)) await walk(target);
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
        const remainingMatches = Math.min(MAX_MATCHES_PER_FILE, MAX_UI_MATCHES - totalMatches);
        const foundMatches = await runBoundedRegex(content, remainingMatches);
        for (const found of foundMatches) {
          const start = found.index;
          const end = start + found.text.length;
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
            captures: found.captures,
            namedCaptures: found.namedCaptures,
          });
          totalMatches += 1;
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
    try {
      // Compile once in the bounded worker before walking so invalid patterns
      // are rejected even when the selected workspace contains no text files.
      if (regexRunner) await runBoundedRegex("", 1);
      await walk(scope);
    } finally {
      await regexRunner?.dispose();
    }

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
