import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { loadConfig } from "./configStore";
import { resolveProfile } from "./fsTree";
import { runSsh, shellQuote } from "./remoteRuntime";

export interface WorkspaceGitRepo {
  /** Absolute path (host path in remote mode, local path otherwise). */
  path: string;
  /** Path relative to the resources root, used as the display name. */
  name: string;
  branch: string | null;
  detached: boolean;
  /** Count of entries git reports as changed, untracked or unmerged. */
  dirty: number;
  ahead: number;
  behind: number;
  hasUpstream: boolean;
}

export interface GitActionResult {
  ok: boolean;
  output: string;
}

export type GitRepoAction = "pull" | "push" | "commit";

const MAX_REPOS = 60;
const STATUS_TIMEOUT_MS = 20_000;
const ACTION_TIMEOUT_MS = 180_000;

interface WorkspaceContext {
  sshTarget: string | null;
  root: string;
}

function workspaceContext(): WorkspaceContext {
  const config = loadConfig();
  if (config.remote) {
    return {
      sshTarget: config.remote.sshTarget,
      root: `${config.remote.workspacePath.replace(/\/+$/, "")}/resources`,
    };
  }
  if (!config.txDataPath || !config.selectedProfile) {
    throw new Error("Choose a server-data workspace first.");
  }
  const resolved = resolveProfile(config.txDataPath, config.selectedProfile);
  if (!resolved.resourcesPath) {
    throw new Error("The selected workspace has no resources folder.");
  }
  return { sshTarget: null, root: resolved.resourcesPath };
}

/** Parses `git status --porcelain=v2 --branch` output. */
function parseStatus(text: string): Pick<WorkspaceGitRepo, "branch" | "detached" | "dirty" | "ahead" | "behind" | "hasUpstream"> {
  let branch: string | null = null;
  let detached = false;
  let ahead = 0;
  let behind = 0;
  let hasUpstream = false;
  let dirty = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("# branch.head ")) {
      const value = line.slice("# branch.head ".length).trim();
      if (value === "(detached)") detached = true;
      else branch = value;
    } else if (line.startsWith("# branch.ab ")) {
      hasUpstream = true;
      const match = /\+(\d+) -(\d+)/.exec(line);
      if (match) {
        ahead = Number(match[1]);
        behind = Number(match[2]);
      }
    } else if (/^[12u?!] /.test(line)) {
      dirty += 1;
    }
  }
  return { branch, detached, dirty, ahead, behind, hasUpstream };
}

function runGit(
  cwd: string,
  args: string[],
  input?: string,
  timeoutMs = STATUS_TIMEOUT_MS,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("git", ["-C", cwd, ...args], {
      windowsHide: true,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      // Never let git open an interactive credential prompt from a background
      // process; a missing credential must fail loudly instead of hanging.
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = `${stdout}${chunk.toString("utf8")}`.slice(-64 * 1024);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-64 * 1024);
    });
    let settled = false;
    const finish = (value: { code: number; stdout: string; stderr: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      if (!child.killed) child.kill();
      finish({ code: -1, stdout, stderr: `${stderr}\nTimed out after ${Math.round(timeoutMs / 1000)}s.` });
    }, timeoutMs);
    timer.unref();
    child.on("error", (error) => finish({ code: -1, stdout, stderr: `${stderr}${error.message}` }));
    child.on("close", (code) => finish({ code: code ?? -1, stdout, stderr }));
    child.stdin?.on("error", () => undefined);
    if (input !== undefined) child.stdin?.end(input);
    else child.stdin?.end();
  });
}

function findLocalRepos(root: string): string[] {
  const found: string[] = [];
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  let visited = 0;
  while (queue.length > 0 && found.length < MAX_REPOS && visited < 2_000) {
    const { dir, depth } = queue.shift()!;
    visited += 1;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    if (entries.some((entry) => entry.name === ".git" && entry.isDirectory())) {
      found.push(dir);
      continue; // nested repos inside a repo are its own business
    }
    if (depth >= 4) continue;
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "cache") continue;
      queue.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
    }
  }
  return found;
}

function relativeName(root: string, repoPath: string): string {
  const value = repoPath.startsWith(root) ? repoPath.slice(root.length).replace(/^[/\\]+/, "") : repoPath;
  return value.replace(/\\/g, "/") || repoPath;
}

const REPO_MARKER = "===FIVEM-STUDIO-REPO=== ";

export async function listWorkspaceRepos(): Promise<WorkspaceGitRepo[]> {
  const context = workspaceContext();
  const repos: WorkspaceGitRepo[] = [];
  if (context.sshTarget) {
    // One round trip: find every .git under resources, then print a marker
    // line and the porcelain status for each.
    const script = [
      "ROOT=" + shellQuote(context.root),
      'find "$ROOT" -mindepth 1 -maxdepth 4 -type d -name .git -prune 2>/dev/null | head -' + String(MAX_REPOS) + " | while read -r gitdir; do",
      '  repo="${gitdir%/.git}"',
      "  printf '%s%s\\n' " + shellQuote(REPO_MARKER) + ' "$repo"',
      '  GIT_TERMINAL_PROMPT=0 git -C "$repo" status --porcelain=v2 --branch 2>&1 | head -300',
      "done",
    ].join("\n");
    const result = await runSsh(context.sshTarget, ["sh", "-s"], script, 60_000, 512 * 1024);
    if (result.code !== 0 && !result.stdout.includes(REPO_MARKER)) {
      throw new Error(result.stderr.trim().split("\n").slice(-2).join(" ") || "Could not scan the host for repositories.");
    }
    const chunks = result.stdout.split(REPO_MARKER).slice(1);
    for (const chunk of chunks) {
      const newline = chunk.indexOf("\n");
      if (newline === -1) continue;
      const repoPath = chunk.slice(0, newline).trim();
      if (!repoPath) continue;
      repos.push({ path: repoPath, name: relativeName(context.root, repoPath), ...parseStatus(chunk.slice(newline + 1)) });
    }
  } else {
    const paths = findLocalRepos(context.root);
    const statuses = await Promise.all(
      paths.map((repoPath) => runGit(repoPath, ["status", "--porcelain=v2", "--branch"])),
    );
    paths.forEach((repoPath, index) => {
      const status = statuses[index];
      if (status.code !== 0) return; // not readable as a repo right now
      repos.push({ path: repoPath, name: relativeName(context.root, repoPath), ...parseStatus(status.stdout) });
    });
  }
  repos.sort((a, b) => a.name.localeCompare(b.name));
  return repos;
}

function assertRepoInsideWorkspace(context: WorkspaceContext, repoPath: string): string {
  if (typeof repoPath !== "string" || repoPath.length > 4096 || /[\n\r\0]/.test(repoPath) || repoPath.includes("..")) {
    throw new Error("That repository path is not valid.");
  }
  if (context.sshTarget) {
    const normalized = repoPath.replace(/\/+$/, "");
    if (!normalized.startsWith(`${context.root}/`)) throw new Error("That repository is outside the workspace.");
    return normalized;
  }
  const resolved = path.resolve(repoPath);
  const rootResolved = path.resolve(context.root);
  if (!resolved.toLowerCase().startsWith(`${rootResolved.toLowerCase()}${path.sep}`)) {
    throw new Error("That repository is outside the workspace.");
  }
  return resolved;
}

export async function runRepoAction(
  repoPathValue: unknown,
  actionValue: unknown,
  messageValue: unknown,
): Promise<GitActionResult> {
  const action = actionValue as GitRepoAction;
  if (action !== "pull" && action !== "push" && action !== "commit") {
    throw new Error("Unknown git action.");
  }
  const message = typeof messageValue === "string" ? messageValue.trim() : "";
  if (action === "commit" && (message.length === 0 || message.length > 5_000)) {
    throw new Error("Write a commit message first.");
  }
  const context = workspaceContext();
  const repoPath = assertRepoInsideWorkspace(context, repoPathValue as string);

  if (context.sshTarget) {
    // sh -s consumes all of stdin as the script, so a commit message cannot
    // ride stdin behind it; it is delivered inline through shellQuote instead.
    const git = 'GIT_TERMINAL_PROMPT=0 git -C "$REPO"';
    const body = action === "pull"
      ? [`${git} pull --ff-only 2>&1`]
      : action === "push"
        ? [`${git} push 2>&1`]
        : [`${git} add -A 2>&1`, "printf '%s' " + shellQuote(message) + ` | ${git} commit -F - 2>&1`];
    const script = ["REPO=" + shellQuote(repoPath), ...body].join("\n");
    const result = await runSsh(context.sshTarget, ["sh", "-s"], script, ACTION_TIMEOUT_MS, 64 * 1024);
    return { ok: result.code === 0, output: `${result.stdout}\n${result.stderr}`.trim().slice(-4_000) };
  }

  if (action === "commit") {
    const add = await runGit(repoPath, ["add", "-A"], undefined, ACTION_TIMEOUT_MS);
    if (add.code !== 0) return { ok: false, output: `${add.stdout}\n${add.stderr}`.trim().slice(-4_000) };
    const commit = await runGit(repoPath, ["commit", "-F", "-"], message, ACTION_TIMEOUT_MS);
    return { ok: commit.code === 0, output: `${commit.stdout}\n${commit.stderr}`.trim().slice(-4_000) };
  }
  const args = action === "pull" ? ["pull", "--ff-only"] : ["push"];
  const result = await runGit(repoPath, args, undefined, ACTION_TIMEOUT_MS);
  return { ok: result.code === 0, output: `${result.stdout}\n${result.stderr}`.trim().slice(-4_000) };
}
