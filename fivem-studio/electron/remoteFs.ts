/**
 * Workspace file access on a remote host.
 *
 * Mirrors the local fsTree surface (list, read, write) so the main-process
 * `fs:*` handlers can route to a host without the renderer knowing which side
 * it is talking to.
 *
 * Revisions are deliberately computed with the same `contentRevision` used
 * locally — a sha256 of the file bytes — so the editor's conflict detection
 * behaves identically whether a file lives here or on the host.
 *
 * Every path is validated as an absolute POSIX path with no traversal segment
 * and is shell-quoted before it reaches the host.
 */

import { runSsh, shellQuote } from "./remoteRuntime";
import { contentRevision, type FileSnapshot } from "./fsTree";
import type { DirEntry } from "./fsTree";

/** Matches the local editor limit so remote files behave the same. */
const MAX_READABLE_BYTES = 2 * 1024 * 1024;
/** base64 inflates by ~4/3; leave headroom for the wrapper lines. */
const MAX_READ_STDOUT_BYTES = Math.ceil((MAX_READABLE_BYTES * 4) / 3) + 4096;
const READ_TIMEOUT_MS = 60_000;
const WRITE_TIMEOUT_MS = 60_000;

const NO_FILE = "__QB_NOFILE__";
const TOO_BIG = "__QB_TOOBIG__";
const NOT_DIR = "__QB_NOTDIR__";

export function assertRemotePath(value: string): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.length > 4096) {
    throw new Error("A remote path must be absolute.");
  }
  if (/[\u0000-\u001f]/.test(value)) throw new Error("A remote path may not contain control characters.");
  if (value.split("/").includes("..")) throw new Error("A remote path may not contain traversal segments.");
  return value.replace(/\/+$/, "") || "/";
}

function join(directory: string, name: string): string {
  return directory === "/" ? `/${name}` : `${directory}/${name}`;
}

/** Directory contents, directories first, then files, each alphabetical. */
export async function remoteListDir(sshTarget: string, dirPath: string): Promise<DirEntry[]> {
  const directory = assertRemotePath(dirPath);
  const script = [
    `cd -- ${shellQuote(directory)} 2>/dev/null || { echo ${NOT_DIR}; exit 0; }`,
    "for entry in * .*; do",
    '  if [ "$entry" = "." ] || [ "$entry" = ".." ]; then continue; fi',
    '  if [ ! -e "$entry" ]; then continue; fi',
    '  if [ -d "$entry" ]; then printf "d\\t%s\\n" "$entry"; else printf "f\\t%s\\n" "$entry"; fi',
    "done",
    "exit 0",
  ].join("\n");

  const result = await runSsh(sshTarget, ["sh", "-s"], script, READ_TIMEOUT_MS, 1024 * 1024);
  if (result.code !== 0) {
    throw new Error(`Could not read ${directory} on ${sshTarget}: ${result.stderr.trim() || `ssh exited ${result.code}`}`);
  }
  if (result.stdout.trim() === NOT_DIR) {
    throw new Error(`${directory} is not a readable directory on ${sshTarget}.`);
  }

  const entries: DirEntry[] = [];
  for (const line of result.stdout.split("\n")) {
    const separator = line.indexOf("\t");
    if (separator < 0) continue;
    const name = line.slice(separator + 1).trim();
    if (!name) continue;
    entries.push({ name, path: join(directory, name), isDirectory: line.startsWith("d") });
  }
  entries.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return entries;
}

export async function remoteReadFileSnapshot(sshTarget: string, filePath: string): Promise<FileSnapshot> {
  const target = assertRemotePath(filePath);
  const quoted = shellQuote(target);
  const script = [
    `if [ ! -f ${quoted} ]; then echo ${NO_FILE}; exit 0; fi`,
    `size=$(wc -c < ${quoted})`,
    `if [ "$size" -gt ${MAX_READABLE_BYTES} ]; then echo ${TOO_BIG}:$size; exit 0; fi`,
    `base64 ${quoted}`,
    "exit 0",
  ].join("\n");

  const result = await runSsh(sshTarget, ["sh", "-s"], script, READ_TIMEOUT_MS, MAX_READ_STDOUT_BYTES);
  if (result.code !== 0) {
    throw new Error(`Could not read ${target} on ${sshTarget}: ${result.stderr.trim() || `ssh exited ${result.code}`}`);
  }
  const output = result.stdout.trim();
  if (output === NO_FILE) throw new Error(`${target} does not exist on ${sshTarget}.`);
  if (output.startsWith(TOO_BIG)) {
    const size = Number(output.split(":")[1] ?? 0);
    throw new Error(`${target} is ${(size / 1024 / 1024).toFixed(1)}MB — too large to open in the editor.`);
  }

  const bytes = Buffer.from(output.replace(/\s+/g, ""), "base64");
  // Same guard the local reader applies: toString("utf8") would silently
  // substitute replacement characters and a save would then corrupt the file.
  const content = bytes.toString("utf8");
  if (Buffer.compare(Buffer.from(content, "utf8"), bytes) !== 0) {
    throw new Error(`${target} is not valid UTF-8 text.`);
  }
  return { content, revision: contentRevision(bytes) };
}

/**
 * Writes a file on the host, atomically via a sibling temp file and rename.
 *
 * When `expectedRevision` is supplied the current remote content is hashed
 * first and the write is refused if it moved, which is the same optimistic
 * conflict check the local writer performs.
 */
export async function remoteWriteFile(
  sshTarget: string,
  filePath: string,
  content: string,
  expectedRevision?: string,
): Promise<string> {
  const target = assertRemotePath(filePath);

  if (expectedRevision !== undefined) {
    let current: FileSnapshot | null = null;
    try {
      current = await remoteReadFileSnapshot(sshTarget, target);
    } catch (error) {
      // A file that does not exist yet is only a conflict if one was expected.
      if (!(error instanceof Error) || !error.message.includes("does not exist")) throw error;
    }
    const currentRevision = current ? current.revision : "";
    if (currentRevision !== expectedRevision) {
      throw new Error(`${target} changed on ${sshTarget} since it was opened. Reload the file before saving.`);
    }
  }

  const payload = Buffer.from(content, "utf8");
  const quoted = shellQuote(target);
  const result = await runSsh(
    sshTarget,
    ["sh", "-c", `mkdir -p "$(dirname ${quoted})" && cat > ${quoted}.qbpart && mv ${quoted}.qbpart ${quoted}`],
    payload,
    WRITE_TIMEOUT_MS,
  );
  if (result.code !== 0) {
    throw new Error(`Could not write ${target} on ${sshTarget}: ${result.stderr.trim() || `ssh exited ${result.code}`}`);
  }
  return contentRevision(payload);
}
