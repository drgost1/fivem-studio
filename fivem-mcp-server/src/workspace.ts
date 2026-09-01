import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { config } from "./config.js";

/**
 * File, git and exec tools are jailed to these absolute roots. Default: the
 * parent of the server-data workspace (typically the txData level, which is
 * the git repo root) plus the workspace itself, so both the enclosing repo
 * and resources/ are reachable. Override with MCP_WORKSPACE_ROOTS (an OS path
 * list — ':'-separated on POSIX). Every path a tool receives is resolved and
 * must fall inside one of these.
 */
export function workspaceRoots(): string[] {
  const configured = config.capabilities.workspaceRoots
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const roots = configured.length > 0
    ? configured
    : [path.dirname(config.serverData.workspacePath), config.serverData.workspacePath];
  return roots
    .filter((root) => path.isAbsolute(root))
    .map((root) => path.resolve(root).replace(/[\\/]+$/, ""));
}

/** Resolves a caller-supplied path and asserts it lies within an allowed root. */
export function assertInsideRoots(target: unknown): string {
  if (typeof target !== "string" || target.length === 0 || target.length > 4096) {
    throw new Error("A path is required.");
  }
  // Reject control characters (newlines, NUL, etc.); spaces and dashes are legal.
  if (/[\x00-\x1f]/.test(target)) throw new Error("A path must not contain control characters.");
  const resolved = path.resolve(target);
  const roots = workspaceRoots();
  const ok = roots.some((root) => resolved === root || resolved.startsWith(root + path.sep));
  if (!ok) {
    throw new Error(
      `That path is outside the allowed workspace roots (${roots.join(", ") || "none configured"}). ` +
        "Set MCP_WORKSPACE_ROOTS to widen access.",
    );
  }
  return resolved;
}

export interface ProcResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

interface RunOptions {
  cwd: string;
  /** Numeric uid to drop to via sudo, when the runtime runs as another user. */
  asUid?: number;
  input?: string;
  timeoutMs?: number;
  maxBytes?: number;
}

/**
 * Spawns a program with a hard timeout, an output cap, and optional stdin.
 * When `asUid` differs from the runtime's own uid, the call is re-issued
 * through `sudo -n -u '#<uid>' -H` so it runs as that user with their HOME —
 * this is what lets git reach a repo's per-user deploy keys and ssh host
 * aliases even though the runtime process may be root. Falls back to a direct
 * call when sudo is unavailable or the uid already matches.
 */
export function runProc(program: string, args: string[], options: RunOptions): Promise<ProcResult> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const maxBytes = options.maxBytes ?? 64 * 1024;
  const ownUid = typeof process.getuid === "function" ? process.getuid() : undefined;
  const needsDrop = options.asUid !== undefined && ownUid !== undefined && ownUid === 0 && options.asUid !== 0;

  const [cmd, cmdArgs] = needsDrop
    ? ["sudo", ["-n", "-u", `#${options.asUid}`, "-H", program, ...args]]
    : [program, args];

  return new Promise((resolve) => {
    const child = spawn(cmd, cmdArgs, {
      cwd: options.cwd,
      windowsHide: true,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = `${stdout}${chunk.toString("utf8")}`.slice(-maxBytes);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-maxBytes);
    });
    let settled = false;
    const finish = (result: ProcResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      if (!child.killed) child.kill("SIGKILL");
      finish({ code: -1, stdout, stderr: `${stderr}\nTimed out after ${Math.round(timeoutMs / 1000)}s.`, timedOut });
    }, timeoutMs);
    timer.unref?.();
    child.on("error", (error) => finish({ code: -1, stdout, stderr: `${stderr}${error.message}`, timedOut }));
    child.on("close", (code) => finish({ code: code ?? -1, stdout, stderr, timedOut }));
    child.stdin?.on("error", () => undefined);
    if (options.input !== undefined) child.stdin?.end(options.input);
    else child.stdin?.end();
  });
}

/** The owning uid of a path, for the sudo drop; undefined on platforms/paths without one. */
export function ownerUid(target: string): number | undefined {
  try {
    return fs.statSync(target).uid;
  } catch {
    return undefined;
  }
}

/** A short, stable label for where the roots live, used in tool descriptions. */
export function rootsSummary(): string {
  const roots = workspaceRoots();
  return roots.length > 0 ? roots.join(", ") : os.homedir();
}
