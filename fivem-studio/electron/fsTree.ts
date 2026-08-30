// One-level directory listing for the resource tree — the renderer expands
// folders lazily by calling this again with the child path, rather than
// walking the whole tree up front (a resources/ folder can be huge, and a
// cloned repo's node_modules would be worse).

import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { isUtf8 } from "node:buffer";

export interface DirEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  resourceName?: string;
}

const SKIP_NAMES = new Set([".git", "node_modules", ".DS_Store"]);

export function listDir(dirPath: string): DirEntry[] {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  return entries
    .filter((e) => !SKIP_NAMES.has(e.name))
    .map((e) => ({
      name: e.name,
      path: path.join(dirPath, e.name),
      isDirectory: e.isDirectory(),
    }))
    .sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
}

const MAX_READABLE_BYTES = 2 * 1024 * 1024; // 2MB — plenty for Lua/config files, guards against opening huge binaries

export interface FileSnapshot {
  content: string;
  revision: string;
}

export function contentRevision(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function readTextFile(filePath: string): string {
  return readTextFileSnapshot(filePath).content;
}

export function readTextFileSnapshot(filePath: string): FileSnapshot {
  const stat = fs.statSync(filePath);
  if (stat.size > MAX_READABLE_BYTES) {
    throw new Error(`${filePath} is ${(stat.size / 1024 / 1024).toFixed(1)}MB — too large to open in the editor.`);
  }
  const bytes = fs.readFileSync(filePath);
  // Buffer.toString("utf8") silently replaces malformed byte sequences. That
  // is dangerous in an editor: a later save would persist those replacement
  // characters and corrupt the original binary. Reject unsupported encodings
  // while the source bytes are still intact.
  if (bytes.includes(0) || !isUtf8(bytes)) {
    throw new Error(`${filePath} appears to be a binary or non-UTF-8 file and cannot be opened in the text editor.`);
  }
  return { content: bytes.toString("utf8"), revision: contentRevision(bytes) };
}

export function writeTextFile(filePath: string, content: string, expectedRevision?: string): string {
  if (expectedRevision !== undefined) {
    let currentRevision: string;
    try {
      currentRevision = contentRevision(fs.readFileSync(filePath));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error("This file was removed after it was opened. Your editor buffer was not written.");
      }
      throw err;
    }
    if (currentRevision !== expectedRevision) {
      throw new Error(
        "This file changed on disk after it was opened. Your editor buffer was not written; reopen the file and merge your changes.",
      );
    }
  }

  // Never truncate the live file before the replacement is complete. A crash
  // during an editor/agent save should leave either the old content or the
  // complete new content, not a partial resource file.
  const tempPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  let fd: number | null = null;
  try {
    const mode = fs.existsSync(filePath) ? fs.statSync(filePath).mode : undefined;
    fd = fs.openSync(tempPath, "wx", mode);
    fs.writeFileSync(fd, content, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tempPath, filePath);
    return contentRevision(content);
  } catch (err) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // best effort
      }
    }
    try {
      fs.rmSync(tempPath, { force: true });
    } catch {
      // best effort
    }
    throw err;
  }
}

/** Atomically creates a new text file and refuses any existing target, even if
 * another writer wins the race after the caller's initial directory check. */
export function createTextFile(filePath: string, content: string | Buffer): string {
  const tempPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  let fd: number | null = null;
  try {
    fd = fs.openSync(tempPath, "wx", 0o600);
    fs.writeFileSync(fd, content);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    // A hard link publishes the already-durable bytes without an overwrite
    // window. It fails with EEXIST if another writer created the target.
    fs.linkSync(tempPath, filePath);
    try {
      fs.rmSync(tempPath);
    } catch {
      // The target is already durable. A leftover hidden temp hard-link is
      // preferable to reporting failure after the requested file was created.
    }
    return contentRevision(content);
  } catch (err) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // best effort
      }
    }
    try {
      fs.rmSync(tempPath, { force: true });
    } catch {
      // best effort
    }
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error("This file was created by another process before the new file could be published.");
    }
    throw err;
  }
}

/** Renames/moves `oldPath` to `newName` within the same parent directory. Returns the new full path. */
export function renamePath(oldPath: string, newName: string): string {
  const newPath = path.join(path.dirname(oldPath), newName);
  fs.renameSync(oldPath, newPath);
  return newPath;
}

// --- txData / server profile discovery ---
// Mirrors the txData/<profile>/{server.cfg,resources/} layout that
// The bundled runtime's log tailing already assumes for txAdmin
// installs, so pointing Studio at the same txData root Just Works.

export interface ProfileInfo {
  name: string;
  hasServerCfg: boolean;
  hasResources: boolean;
}

export function listProfiles(txDataPath: string): ProfileInfo[] {
  return fs
    .readdirSync(txDataPath, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !SKIP_NAMES.has(e.name))
    .map((e) => {
      const dir = path.join(txDataPath, e.name);
      return {
        name: e.name,
        hasServerCfg: fs.existsSync(path.join(dir, "server.cfg")),
        hasResources: fs.existsSync(path.join(dir, "resources")),
      };
    })
    .filter((p) => p.hasServerCfg || p.hasResources)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export interface ResolvedProfile {
  profileRoot: string;
  resourcesPath: string | null;
  serverCfgPath: string | null;
}

export function resolveProfile(txDataPath: string, profile: string): ResolvedProfile {
  const profileRoot = path.join(txDataPath, profile);
  const resourcesPath = path.join(profileRoot, "resources");
  const serverCfgPath = path.join(profileRoot, "server.cfg");
  return {
    profileRoot,
    resourcesPath: fs.existsSync(resourcesPath) ? resourcesPath : null,
    serverCfgPath: fs.existsSync(serverCfgPath) ? serverCfgPath : null,
  };
}
