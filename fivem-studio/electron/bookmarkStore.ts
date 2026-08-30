import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { resolveInsideRoot } from "./pathSafety";

export interface EditorBookmark {
  path: string;
  line: number;
  updatedAt: string;
}

interface StoredBookmark {
  relativePath: string;
  line: number;
  updatedAt: string;
}

const MAX_BOOKMARKS = 500;

function pathKey(value: string): string {
  return value.replace(/\\/g, "/").toLowerCase();
}

function sameOrChild(candidate: string, parent: string): boolean {
  const childKey = pathKey(candidate);
  const parentKey = pathKey(parent).replace(/\/+$/, "");
  return childKey === parentKey || childKey.startsWith(`${parentKey}/`);
}

export class BookmarkStore {
  constructor(private readonly storageRoot: string) {}

  private statePath(workspaceRoot: string): string {
    const key = createHash("sha256").update(fs.realpathSync.native(workspaceRoot)).digest("hex");
    return path.join(this.storageRoot, `${key}.json`);
  }

  private read(workspaceRoot: string): StoredBookmark[] {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.statePath(workspaceRoot), "utf8"));
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((entry): entry is StoredBookmark =>
        entry && typeof entry === "object" && typeof entry.relativePath === "string" &&
        Number.isInteger(entry.line) && entry.line >= 1 && entry.line <= 10_000_000 && typeof entry.updatedAt === "string",
      ).slice(0, MAX_BOOKMARKS);
    } catch {
      return [];
    }
  }

  private write(workspaceRoot: string, bookmarks: StoredBookmark[]): void {
    fs.mkdirSync(this.storageRoot, { recursive: true });
    const target = this.statePath(workspaceRoot);
    const temporary = path.join(this.storageRoot, `.${path.basename(target)}.${randomUUID()}.tmp`);
    try {
      fs.writeFileSync(temporary, JSON.stringify(bookmarks.slice(0, MAX_BOOKMARKS), null, 2), { encoding: "utf8", mode: 0o600, flag: "wx" });
      fs.renameSync(temporary, target);
    } finally {
      try { fs.rmSync(temporary, { force: true }); } catch { /* best effort */ }
    }
  }

  list(workspaceRoot: string): EditorBookmark[] {
    const result: EditorBookmark[] = [];
    for (const bookmark of this.read(workspaceRoot)) {
      try {
        const target = resolveInsideRoot(workspaceRoot, bookmark.relativePath);
        const stat = fs.lstatSync(target);
        if (stat.isFile() && !stat.isSymbolicLink()) result.push({ path: target, line: bookmark.line, updatedAt: bookmark.updatedAt });
      } catch {
        // Deleted/moved bookmarks disappear from the visible list without weakening containment.
      }
    }
    return result.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  toggle(workspaceRoot: string, filePath: string, line: number): EditorBookmark[] {
    if (!Number.isInteger(line) || line < 1 || line > 10_000_000) throw new Error("Bookmark line is invalid.");
    const target = resolveInsideRoot(workspaceRoot, path.relative(workspaceRoot, filePath));
    const stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Bookmarks require an ordinary workspace file.");
    const relativePath = path.relative(workspaceRoot, target);
    const current = this.read(workspaceRoot);
    const existing = current.findIndex((bookmark) => bookmark.relativePath.toLowerCase() === relativePath.toLowerCase() && bookmark.line === line);
    if (existing >= 0) current.splice(existing, 1);
    else current.unshift({ relativePath, line, updatedAt: new Date().toISOString() });
    this.write(workspaceRoot, current);
    return this.list(workspaceRoot);
  }

  /** Persist bookmark path changes in the same rename operation that moved the
   * file or directory. The store write itself is atomic (temporary + rename). */
  remapPath(workspaceRoot: string, oldPath: string, newPath: string): EditorBookmark[] {
    this.remapPathWithRollback(workspaceRoot, oldPath, newPath);
    return this.list(workspaceRoot);
  }

  /** Stage a durable bookmark rename and return a rollback for the matching
   * filesystem operation. */
  remapPathWithRollback(workspaceRoot: string, oldPath: string, newPath: string): () => void {
    const oldRelative = path.relative(workspaceRoot, resolveInsideRoot(workspaceRoot, path.relative(workspaceRoot, oldPath)));
    const newRelative = path.relative(workspaceRoot, resolveInsideRoot(workspaceRoot, path.relative(workspaceRoot, newPath)));
    const current = this.read(workspaceRoot);
    let changed = false;
    const remapped = current.map((bookmark) => {
      if (!sameOrChild(bookmark.relativePath, oldRelative)) return bookmark;
      changed = true;
      return {
        ...bookmark,
        relativePath: newRelative + bookmark.relativePath.slice(oldRelative.length),
      };
    });
    if (!changed) return () => undefined;
    const unique = remapped.filter((bookmark, index, all) =>
      all.findIndex((candidate) => pathKey(candidate.relativePath) === pathKey(bookmark.relativePath) && candidate.line === bookmark.line) === index,
    );
    this.write(workspaceRoot, unique);
    return () => this.write(workspaceRoot, current);
  }

  removePath(workspaceRoot: string, removedPath: string): EditorBookmark[] {
    this.removePathWithRollback(workspaceRoot, removedPath);
    return this.list(workspaceRoot);
  }

  /** Remove matching bookmarks before a destructive filesystem operation and
   * return a rollback that restores the exact previous durable state. */
  removePathWithRollback(workspaceRoot: string, removedPath: string): () => void {
    const removedRelative = path.relative(workspaceRoot, resolveInsideRoot(workspaceRoot, path.relative(workspaceRoot, removedPath)));
    const current = this.read(workspaceRoot);
    const remaining = current.filter((bookmark) => !sameOrChild(bookmark.relativePath, removedRelative));
    if (remaining.length === current.length) return () => undefined;
    this.write(workspaceRoot, remaining);
    return () => this.write(workspaceRoot, current);
  }
}
