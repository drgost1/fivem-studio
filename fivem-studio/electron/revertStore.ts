import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

import { contentRevision, readTextFileSnapshot, writeTextFile } from "./fsTree";
import { ensureParentInsideRoot, resolveInsideRoot } from "./pathSafety";

export const DEFAULT_REVERT_MAX_BYTES = 16 * 1024 * 1024;
export const DEFAULT_REVERT_MAX_ENTRIES = 200;

const REVISION_PATTERN = /^[a-f0-9]{64}$/;
const CREDENTIAL_FILENAMES = new Set([
  ".env",
  ".git-credentials",
  ".npmrc",
  ".pypirc",
  "auth.json",
  "credentials.json",
  "id_ed25519",
  "id_rsa",
  "secrets.cfg",
  "service-account.json",
]);
const CREDENTIAL_EXTENSIONS = new Set([".key", ".keystore", ".p12", ".pem", ".pfx"]);
const CREDENTIAL_CONTENT_PATTERNS = [
  /\b(?:(?:set|setr|sets)\s+)?(?:mysql_connection_string|rcon_password|steam_webapikey|sv_licensekey)\b/i,
  /-----BEGIN (?:ENCRYPTED |RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  /["']?(?:access[_-]?token|api[_-]?key|client[_-]?secret|private[_-]?key|password|passwd|secret)["']?\s*[:=]\s*(?:"[^"\r\n]+"|'[^'\r\n]+')/i,
  /(?:^|\n)\s*(?:(?:set|setr|sets)\s+)?[A-Za-z0-9_.-]*(?:password|passwd|token|api[_-]?key|client[_-]?secret|private[_-]?key|secret)[A-Za-z0-9_.-]*\s*(?::|=|\s)\s*(?:"[^"\r\n]+"|'[^'\r\n]+'|[^\s#;]{8,})/i,
  /(?:^|\n)\s*[A-Z][A-Z0-9_]*(?:TOKEN|PASSWORD|PASSWD|API_KEY|CLIENT_SECRET|PRIVATE_KEY)[A-Z0-9_]*\s*=\s*\S{8,}/,
  /\bauthorization\s*[:=]\s*["']?bearer\s+/i,
  /\b(?:sk-ant-|sk-|ghp_|github_pat_|glpat-|xox[baprs]-)[A-Za-z0-9_-]{12,}\b/i,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@[^\s]+/i,
];

interface RevertEntry {
  path: string;
  priorContent: string | null;
  priorRevision: string | null;
  writtenRevision: string;
}

interface RevertBatch extends RevertBatchSummary {
  entries: RevertEntry[];
}

interface RevertDocument {
  version: 1;
  batches: RevertBatch[];
}

export interface ProgrammaticWrite {
  filePath: string;
  nextContent: string;
}

export interface RevertBatchSummary {
  id: string;
  label: string;
  createdAt: string;
  fileCount: number;
  totalBytes: number;
}

export interface RevertConflict {
  path: string;
  reason: string;
}

export interface RevertResult {
  batchId: string;
  status: "reverted" | "partial" | "conflict" | "not-found";
  reverted: string[];
  skipped: RevertConflict[];
}

export type RevertMode = "all" | "safe";

export interface RevertStoreOptions {
  maxBytes?: number;
  maxEntries?: number;
}

function normalizedWorkspace(workspaceRoot: string): string {
  const resolved = path.resolve(workspaceRoot);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function workspaceKey(workspaceRoot: string): string {
  return createHash("sha256").update(normalizedWorkspace(workspaceRoot)).digest("hex");
}

function serializedBytes(document: RevertDocument): number {
  return Buffer.byteLength(JSON.stringify(document), "utf8");
}

function entryBytes(entry: RevertEntry): number {
  return Buffer.byteLength(entry.priorContent ?? "", "utf8");
}

function countEntries(document: RevertDocument): number {
  return document.batches.reduce((total, batch) => total + batch.entries.length, 0);
}

function safeLabel(label: string): string {
  const clean = label.trim();
  return (clean || "Programmatic file change").slice(0, 200);
}

function isValidEntry(value: unknown): value is RevertEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.path === "string"
    && entry.path.length > 0
    && !path.isAbsolute(entry.path)
    && (typeof entry.priorContent === "string" || entry.priorContent === null)
    && (entry.priorRevision === null || (typeof entry.priorRevision === "string" && REVISION_PATTERN.test(entry.priorRevision)))
    && typeof entry.writtenRevision === "string"
    && REVISION_PATTERN.test(entry.writtenRevision);
}

function parseDocument(raw: string): RevertDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Undo history is corrupt and was left untouched.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Undo history has an invalid format and was left untouched.");
  }
  const document = parsed as Record<string, unknown>;
  if (document.version !== 1 || !Array.isArray(document.batches)) {
    throw new Error("Undo history uses an unsupported format and was left untouched.");
  }
  const batches: RevertBatch[] = [];
  for (const value of document.batches) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Undo history has an invalid batch and was left untouched.");
    }
    const batch = value as Record<string, unknown>;
    if (typeof batch.id !== "string"
      || typeof batch.label !== "string"
      || typeof batch.createdAt !== "string"
      || !Array.isArray(batch.entries)
      || !batch.entries.every(isValidEntry)) {
      throw new Error("Undo history has an invalid batch and was left untouched.");
    }
    const entries = batch.entries as RevertEntry[];
    batches.push({
      id: batch.id,
      label: batch.label,
      createdAt: batch.createdAt,
      fileCount: entries.length,
      totalBytes: entries.reduce((total, entry) => total + entryBytes(entry), 0),
      entries,
    });
  }
  return { version: 1, batches };
}

/** Conservative policy shared by all programmatic-write callers. The store
 * never persists either a known credential file or prior text that looks like
 * an actual provider/server credential. */
export function isCredentialBearingPath(filePath: string): boolean {
  const base = path.basename(filePath).toLowerCase();
  if (CREDENTIAL_FILENAMES.has(base) || base.startsWith(".env.")) return true;
  if (CREDENTIAL_EXTENSIONS.has(path.extname(base))) return true;
  if (/(?:^|[._-])(?:secret|secrets|credential|credentials|token|tokens|api[-_]?key|private[-_]?key)(?:[._-]|$)/i.test(base)) return true;
  if (filePath.split(/[\\/]+/).some((part) => /^(?:secret|secrets|credentials)$/i.test(part))) return true;
  return false;
}

export function hasCredentialBearingContent(content: string): boolean {
  return CREDENTIAL_CONTENT_PATTERNS.some((pattern) => pattern.test(content));
}

export function isCredentialBearingFile(filePath: string, priorContent?: string): boolean {
  return isCredentialBearingPath(filePath)
    || (typeof priorContent === "string" && hasCredentialBearingContent(priorContent));
}

/** Remove common credential forms before local tool output enters a hosted
 * model's context. This is deliberately conservative; false-positive
 * redaction is safer than sending a usable secret to a third party. */
export function redactCredentialText(value: string): string {
  return value
    .replace(/-----BEGIN (?:ENCRYPTED |RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:ENCRYPTED |RSA |EC |OPENSSH )?PRIVATE KEY-----/gi, "<redacted-private-key>")
    .replace(
      /(^\s*(?:(?:set|setr|sets)\s+)?(?:mysql_connection_string|rcon_password|steam_webapikey|sv_licensekey|[A-Za-z0-9_.-]*(?:password|passwd|token|api[_-]?key|client[_-]?secret|private[_-]?key|secret)[A-Za-z0-9_.-]*)\s*(?::|=|\s)\s*)(?:"[^"]*"|'[^']*'|[^\r\n]*)/gim,
      "$1<redacted>",
    )
    .replace(/(["'](?:access[_-]?token|api[_-]?key|client[_-]?secret|private[_-]?key|password|passwd|secret)["']\s*:\s*)["'][^"'\r\n]*["']/gi, "$1\"<redacted>\"")
    .replace(/(\b[A-Za-z0-9_.-]*(?:password|passwd|token|api[_-]?key|client[_-]?secret|private[_-]?key|secret)[A-Za-z0-9_.-]*\b\s*(?::|=|\s)\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi, "$1<redacted>")
    .replace(/(\bauthorization\s*[:=]\s*["']?bearer\s+)[^\s"']+/gi, "$1<redacted>")
    .replace(/\b(?:sk-ant-|sk-|ghp_|github_pat_|glpat-|xox[baprs]-)[A-Za-z0-9_-]{12,}\b/gi, "<redacted-token>")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "<redacted-token>")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "<redacted-token>")
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1<redacted>@");
}

export class RevertStore {
  private readonly maxBytes: number;
  private readonly maxEntries: number;

  constructor(private readonly baseDir: string, options: RevertStoreOptions = {}) {
    this.maxBytes = options.maxBytes ?? DEFAULT_REVERT_MAX_BYTES;
    this.maxEntries = options.maxEntries ?? DEFAULT_REVERT_MAX_ENTRIES;
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes < 1024) throw new Error("Undo byte cap must be at least 1024 bytes.");
    if (!Number.isSafeInteger(this.maxEntries) || this.maxEntries < 1) throw new Error("Undo entry cap must be at least 1.");
  }

  prepareBatch(workspaceRoot: string, label: string, writes: ProgrammaticWrite[]): RevertBatchSummary | null {
    if (!fs.statSync(workspaceRoot).isDirectory()) throw new Error("The undo workspace is not a directory.");
    if (!Array.isArray(writes) || writes.length === 0) throw new Error("An undo batch needs at least one file write.");

    const seen = new Set<string>();
    const entries: RevertEntry[] = [];
    for (const write of writes) {
      if (!write || typeof write.filePath !== "string" || typeof write.nextContent !== "string") {
        throw new Error("Undo batch writes must contain a file path and text content.");
      }
      const relative = path.relative(workspaceRoot, write.filePath);
      const target = resolveInsideRoot(workspaceRoot, relative);
      const identity = process.platform === "win32" ? target.toLowerCase() : target;
      if (seen.has(identity)) throw new Error(`Undo batch contains the same file twice: ${relative}`);
      seen.add(identity);

      let priorContent: string | null = null;
      let priorRevision: string | null = null;
      if (fs.existsSync(target)) {
        const stat = fs.statSync(target);
        if (!stat.isFile()) throw new Error(`Undo target is not a regular file: ${relative}`);
        const snapshot = readTextFileSnapshot(target);
        priorContent = snapshot.content;
        priorRevision = snapshot.revision;
      }
      if (isCredentialBearingFile(target, priorContent ?? undefined) || isCredentialBearingFile(target, write.nextContent)) continue;
      entries.push({ path: relative, priorContent, priorRevision, writtenRevision: contentRevision(write.nextContent) });
    }

    if (entries.length === 0) return null;
    const batch: RevertBatch = {
      id: randomUUID(),
      label: safeLabel(label),
      createdAt: new Date().toISOString(),
      fileCount: entries.length,
      totalBytes: entries.reduce((total, entry) => total + entryBytes(entry), 0),
      entries,
    };
    const batchOnly: RevertDocument = { version: 1, batches: [batch] };
    if (entries.length > this.maxEntries || serializedBytes(batchOnly) > this.maxBytes) {
      throw new Error("This change is larger than the bounded undo history can safely store, so no files were written.");
    }

    const document = this.load(workspaceRoot);
    document.batches.push(batch);
    while (countEntries(document) > this.maxEntries || serializedBytes(document) > this.maxBytes) {
      document.batches.shift();
    }
    this.save(workspaceRoot, document);
    return this.summary(batch);
  }

  discardBatch(workspaceRoot: string, batchId: string): void {
    const document = this.load(workspaceRoot);
    const next = document.batches.filter((batch) => batch.id !== batchId);
    if (next.length === document.batches.length) return;
    this.save(workspaceRoot, { version: 1, batches: next });
  }

  /** Finalize a prepared batch after a caller intentionally skips stale files.
   * Keeping only successful paths prevents a later undo from reporting entries
   * that were previewed but never written. */
  retainBatchEntries(workspaceRoot: string, batchId: string, successfulPaths: string[]): RevertBatchSummary | null {
    const retained = new Set(successfulPaths.map((filePath) => {
      const target = resolveInsideRoot(workspaceRoot, path.relative(workspaceRoot, filePath));
      const relative = path.relative(workspaceRoot, target);
      return process.platform === "win32" ? relative.toLowerCase() : relative;
    }));
    const document = this.load(workspaceRoot);
    const batch = document.batches.find((candidate) => candidate.id === batchId);
    if (!batch) return null;
    batch.entries = batch.entries.filter((entry) => retained.has(process.platform === "win32" ? entry.path.toLowerCase() : entry.path));
    batch.fileCount = batch.entries.length;
    batch.totalBytes = batch.entries.reduce((total, entry) => total + entryBytes(entry), 0);
    document.batches = document.batches.filter((candidate) => candidate.entries.length > 0);
    this.save(workspaceRoot, document);
    return batch.entries.length > 0 ? this.summary(batch) : null;
  }

  listBatches(workspaceRoot: string): RevertBatchSummary[] {
    return this.load(workspaceRoot).batches.slice().reverse().map((batch) => this.summary(batch));
  }

  revertBatch(workspaceRoot: string, batchId: string, mode: RevertMode = "all"): RevertResult {
    if (mode !== "all" && mode !== "safe") throw new Error("Undo mode must be 'all' or 'safe'.");
    const document = this.load(workspaceRoot);
    const batch = document.batches.find((candidate) => candidate.id === batchId);
    if (!batch) return { batchId, status: "not-found", reverted: [], skipped: [] };

    const conflicts: RevertConflict[] = [];
    const safeEntries: Array<{ entry: RevertEntry; target: string }> = [];
    for (const entry of batch.entries) {
      let target: string;
      try {
        target = resolveInsideRoot(workspaceRoot, entry.path);
        const current = readTextFileSnapshot(target);
        if (current.revision !== entry.writtenRevision) {
          conflicts.push({ path: entry.path, reason: "File changed after this undo snapshot was created." });
          continue;
        }
      } catch (error) {
        conflicts.push({ path: entry.path, reason: (error as Error).message || "File is no longer safely accessible." });
        continue;
      }
      safeEntries.push({ entry, target });
    }

    if (mode === "all" && conflicts.length > 0) {
      return { batchId, status: "conflict", reverted: [], skipped: conflicts };
    }

    const reverted: string[] = [];
    const applyConflicts = [...conflicts];
    for (const { entry, target } of safeEntries) {
      try {
        if (entry.priorContent === null) {
          const current = readTextFileSnapshot(target);
          if (current.revision !== entry.writtenRevision) throw new Error("File changed while the undo was being applied.");
          fs.unlinkSync(target);
        } else {
          ensureParentInsideRoot(workspaceRoot, target);
          writeTextFile(target, entry.priorContent, entry.writtenRevision);
        }
        reverted.push(entry.path);
      } catch (error) {
        applyConflicts.push({ path: entry.path, reason: (error as Error).message || "Undo could not be applied safely." });
      }
    }

    const unresolved = new Set(applyConflicts.map((conflict) => conflict.path));
    batch.entries = batch.entries.filter((entry) => unresolved.has(entry.path));
    batch.fileCount = batch.entries.length;
    batch.totalBytes = batch.entries.reduce((total, entry) => total + entryBytes(entry), 0);
    document.batches = document.batches.filter((candidate) => candidate.entries.length > 0);
    this.save(workspaceRoot, document);

    return {
      batchId,
      status: applyConflicts.length === 0 ? "reverted" : reverted.length > 0 ? "partial" : "conflict",
      reverted,
      skipped: applyConflicts,
    };
  }

  private summary(batch: RevertBatch): RevertBatchSummary {
    return {
      id: batch.id,
      label: batch.label,
      createdAt: batch.createdAt,
      fileCount: batch.entries.length,
      totalBytes: batch.entries.reduce((total, entry) => total + entryBytes(entry), 0),
    };
  }

  private storePath(workspaceRoot: string): string {
    return path.join(this.baseDir, `${workspaceKey(workspaceRoot)}.json`);
  }

  private load(workspaceRoot: string): RevertDocument {
    const target = this.storePath(workspaceRoot);
    if (!fs.existsSync(target)) return { version: 1, batches: [] };
    const stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Undo history is not a safe regular file.");
    if (stat.size > this.maxBytes) throw new Error("Undo history exceeds its configured storage cap and was left untouched.");
    return parseDocument(fs.readFileSync(target, "utf8"));
  }

  private save(workspaceRoot: string, document: RevertDocument): void {
    const serialized = JSON.stringify(document);
    if (Buffer.byteLength(serialized, "utf8") > this.maxBytes || countEntries(document) > this.maxEntries) {
      throw new Error("Undo history exceeds its configured storage cap.");
    }
    fs.mkdirSync(this.baseDir, { recursive: true, mode: 0o700 });
    const baseStat = fs.lstatSync(this.baseDir);
    if (!baseStat.isDirectory() || baseStat.isSymbolicLink()) throw new Error("Undo history folder is not a safe directory.");
    const target = this.storePath(workspaceRoot);
    const temp = path.join(this.baseDir, `.${path.basename(target)}.${randomUUID()}.tmp`);
    let fd: number | null = null;
    try {
      fd = fs.openSync(temp, "wx", 0o600);
      fs.writeFileSync(fd, serialized, "utf8");
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = null;
      fs.renameSync(temp, target);
    } catch (error) {
      if (fd !== null) {
        try { fs.closeSync(fd); } catch { /* best effort */ }
      }
      try { fs.rmSync(temp, { force: true }); } catch { /* best effort */ }
      throw error;
    }
  }
}
