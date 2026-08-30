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
}
