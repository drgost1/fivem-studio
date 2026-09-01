/**
 * The file operations behind both the individual file tools and `batch`.
 * Kept as plain functions so a batched edit and a single edit can never drift
 * apart in behaviour or in their safety checks.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { assertInsideRoots, runProc } from "./workspace.js";

export const MAX_READ_BYTES = 512 * 1024;
export const MAX_WRITE_BYTES = 2 * 1024 * 1024;
export const MAX_DIR_ENTRIES = 500;

export function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Writes via a temp file in the same directory, then renames over the target. */
function atomicWrite(resolved: string, content: string): void {
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const temp = `${resolved}.mcp-${process.pid}.tmp`;
  fs.writeFileSync(temp, content, "utf8");
  fs.renameSync(temp, resolved);
}

export function opReadFile(args: { path: string; start_line?: number; line_count?: number }): string {
  const resolved = assertInsideRoots(args.path);
  const stat = fs.statSync(resolved, { throwIfNoEntry: false });
  if (!stat || !stat.isFile()) return `Not a file: ${resolved}`;
  if (stat.size > MAX_READ_BYTES) {
    return `File is ${stat.size} bytes; the cap is ${MAX_READ_BYTES}. Use start_line/line_count on a smaller slice, or search_files.`;
  }
  const raw = fs.readFileSync(resolved);
  if (raw.includes(0)) return `Binary file (${stat.size} bytes) — refusing to return as text.`;
  const content = raw.toString("utf8");
  const digest = sha256(raw);
  if (args.start_line !== undefined) {
    const lines = content.split("\n");
    const slice = lines.slice(args.start_line - 1, args.start_line - 1 + (args.line_count ?? 200));
    return `sha256:${digest} lines ${args.start_line}-${args.start_line - 1 + slice.length} of ${lines.length}\n${slice.join("\n")}`;
  }
  return `sha256:${digest}\n${content}`;
}

export function opWriteFile(args: { path: string; content: string; expected_sha256?: string }): string {
  const resolved = assertInsideRoots(args.path);
  const existing = fs.existsSync(resolved) ? fs.readFileSync(resolved) : null;
  if (args.expected_sha256 && existing && sha256(existing) !== args.expected_sha256) {
    return "CONFLICT: the file changed since that sha256 was read. Re-read it and merge.";
  }
  atomicWrite(resolved, args.content);
  return `Wrote ${Buffer.byteLength(args.content, "utf8")} bytes. New sha256:${sha256(args.content)}`;
}

export function opEditFile(args: { path: string; old_text: string; new_text: string; occurrences?: number }): string {
  const occurrences = args.occurrences ?? 1;
  const resolved = assertInsideRoots(args.path);
  const stat = fs.statSync(resolved, { throwIfNoEntry: false });
  if (!stat || !stat.isFile()) return `Not a file: ${resolved}`;
  if (stat.size > MAX_WRITE_BYTES) return `File exceeds the ${MAX_WRITE_BYTES}-byte edit cap.`;
  const raw = fs.readFileSync(resolved);
  if (raw.includes(0)) return "Binary file — refusing to edit as text.";
  const content = raw.toString("utf8");
  const found = content.split(args.old_text).length - 1;
  if (found !== occurrences) {
    return `Expected ${occurrences} occurrence(s), found ${found}. Nothing changed.`;
  }
  const next = content.split(args.old_text).join(args.new_text);
  atomicWrite(resolved, next);
  return `Replaced ${found} occurrence(s). New sha256:${sha256(next)}`;
}

export function opListDir(args: { path: string }): string {
  const resolved = assertInsideRoots(args.path);
  const entries = fs.readdirSync(resolved, { withFileTypes: true }).slice(0, MAX_DIR_ENTRIES);
  const lines = entries.map((entry) => {
    const kind = entry.isDirectory() ? "dir " : entry.isSymbolicLink() ? "link" : "file";
    let size = "";
    if (kind === "file") {
      try {
        size = ` ${fs.statSync(path.join(resolved, entry.name)).size}`;
      } catch {
        // unreadable entry; the name is still worth listing
      }
    }
    return `${kind}${size}\t${entry.name}`;
  });
  return lines.join("\n") || "(empty)";
}

export async function opSearchFiles(args: { pattern: string; path: string; max_results?: number }): Promise<string> {
  const resolved = assertInsideRoots(args.path);
  const result = await runProc(
    "grep",
    ["-RInE", "--binary-files=without-match", "--exclude-dir=.git", "--exclude-dir=node_modules",
      "--exclude-dir=cache", "-m", "5", "-e", args.pattern, "."],
    { cwd: resolved, timeoutMs: 30_000, maxBytes: 256 * 1024 },
  );
  // grep exits 1 for "no matches", which is a result, not a failure.
  if (result.code > 1) return `Search failed: ${result.stderr.trim() || `exit ${result.code}`}`;
  const lines = result.stdout.split("\n").filter(Boolean).slice(0, args.max_results ?? 100);
  return lines.length > 0 ? lines.join("\n") : "(no matches)";
}

export async function opCheckLua(args: { path: string }): Promise<string> {
  const resolved = assertInsideRoots(args.path);
  for (const binary of ["luac5.4", "luac5.3", "luac"]) {
    const result = await runProc(binary, ["-p", resolved], { cwd: path.dirname(resolved), timeoutMs: 15_000 });
    if (result.code === 0) return `OK: ${path.basename(resolved)} parses cleanly (${binary}).`;
    if (!/not found|ENOENT/i.test(result.stderr)) {
      return `SYNTAX ERROR (${binary}):\n${(result.stderr || result.stdout).trim()}`;
    }
  }
  return "No luac binary found on this host (tried luac5.4, luac5.3, luac).";
}
