import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { config } from "../config.js";
import { assertInsideRoots, ownerUid, runProc, type ProcResult } from "../workspace.js";

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

function combined(result: ProcResult): string {
  return `${result.stdout}\n${result.stderr}`.trim().slice(-6_000);
}

/** Runs git in a repo as the repo's owning user (deploy keys and ssh host
 * aliases live with the owner, not with whoever runs this runtime). */
function git(repo: string, args: string[], input?: string, timeoutMs = 120_000): Promise<ProcResult> {
  return runProc("git", ["-C", repo, ...args], {
    cwd: repo,
    asUid: ownerUid(repo),
    input,
    timeoutMs,
  });
}

const repoSchema = z.string().max(4096).optional()
  .describe("Absolute repo path on this host. Omit for the repo enclosing the server-data workspace.");

/** Resolves the repo argument: explicit path (validated) or the enclosing
 * repo of the configured workspace, discovered once per call via rev-parse. */
async function resolveRepo(repo: string | undefined): Promise<string> {
  if (repo) return assertInsideRoots(repo);
  const workspace = config.serverData.workspacePath;
  const top = await git(workspace, ["rev-parse", "--show-toplevel"], undefined, 15_000);
  if (top.code !== 0 || !top.stdout.trim()) {
    throw new Error("The server-data workspace is not inside a git repository; pass a repo path explicitly.");
  }
  return assertInsideRoots(top.stdout.trim());
}

/** Git tools for the host's repositories. Enabled with MCP_ENABLE_GIT=1. */
export function registerGitTools(server: McpServer): void {
  server.tool(
    "git_status",
    "Branch, ahead/behind (after a fetch) and changed files of a repository on this host. " +
      "Defaults to the repo enclosing the server-data workspace (the txData-level server repo).",
    {
      repo: repoSchema,
      fetch: z.boolean().default(true).describe("Fetch first so ahead/behind is truthful, not a stale tracking ref."),
    },
    async ({ repo, fetch }) => {
      const target = await resolveRepo(repo);
      if (fetch) await git(target, ["fetch", "--quiet"], undefined, 60_000);
      const status = await git(target, ["status", "--porcelain=v2", "--branch"], undefined, 30_000);
      if (status.code !== 0) return text(`git status failed:\n${combined(status)}`);
      const lines = status.stdout.split("\n");
      const changed = lines.filter((line) => /^[12u?!] /.test(line)).length;
      const head = lines.filter((line) => line.startsWith("# ")).join("\n");
      const files = lines.filter((line) => /^[12u?!] /.test(line)).slice(0, 30)
        .map((line) => line.split(" ").slice(-1)[0]).join("\n");
      return text(`${target}\n${head}\nchanged files: ${changed}${files ? `\n${files}` : ""}`);
    },
  );

  server.tool(
    "git_diff",
    "Unified diff of uncommitted changes in a repository (worktree + index vs HEAD), capped. " +
      "Pass a path to narrow it to one file or folder.",
    {
      repo: repoSchema,
      path: z.string().max(4096).optional().describe("Limit the diff to this path (relative to the repo)."),
    },
    async ({ repo, path: subPath }) => {
      const target = await resolveRepo(repo);
      const args = ["diff", "HEAD", "--stat", "--patch", "--no-color"];
      if (subPath) {
        if (/[\x00-\x1f]/.test(subPath) || subPath.includes("..")) return text("Invalid path filter.");
        args.push("--", subPath);
      }
      const result = await git(target, args, undefined, 60_000);
      if (result.code !== 0) return text(`git diff failed:\n${combined(result)}`);
      return text(result.stdout.trim() || "(no uncommitted changes)");
    },
  );

  server.tool(
    "git_log",
    "Recent commits of a repository on this host (oneline, newest first).",
    {
      repo: repoSchema,
      count: z.number().int().positive().max(50).default(15),
    },
    async ({ repo, count }) => {
      const target = await resolveRepo(repo);
      const result = await git(target, ["log", `--max-count=${count}`, "--oneline", "--no-color"], undefined, 30_000);
      return text(result.code === 0 ? result.stdout.trim() || "(no commits)" : combined(result));
    },
  );

  server.tool(
    "git_pull",
    "Fast-forward-only pull of a repository on this host, as the repo's owner (their deploy keys).",
    { repo: repoSchema },
    async ({ repo }) => {
      const target = await resolveRepo(repo);
      const result = await git(target, ["pull", "--ff-only"]);
      return text(combined(result) || (result.code === 0 ? "Already up to date." : `exit ${result.code}`));
    },
  );

  server.tool(
    "git_sync",
    "The one-shot GitHub keeper: stage everything, commit (skipped when clean), and push — in a " +
      "single call, on the host, as the repo's owner. Use after finishing a unit of work so GitHub " +
      "never drifts from the server. Fails loudly on push rejection instead of force-pushing.",
    {
      repo: repoSchema,
      message: z.string().min(3).max(5_000).describe("Commit message (used only when there is something to commit)."),
    },
    async ({ repo, message }) => {
      const target = await resolveRepo(repo);
      const steps: string[] = [];

      const add = await git(target, ["add", "-A"]);
      if (add.code !== 0) return text(`git add failed:\n${combined(add)}`);

      const staged = await git(target, ["diff", "--cached", "--quiet"], undefined, 30_000);
      if (staged.code === 1) {
        const commit = await git(target, ["commit", "-F", "-"], message);
        if (commit.code !== 0) return text(`git commit failed:\n${combined(commit)}`);
        steps.push(commit.stdout.trim().split("\n")[0] || "committed");
      } else if (staged.code === 0) {
        steps.push("nothing to commit (clean)");
      } else {
        return text(`git diff --cached failed:\n${combined(staged)}`);
      }

      const push = await git(target, ["push"]);
      if (push.code !== 0) {
        return text(`${steps.join("; ")}\nPUSH FAILED:\n${combined(push)}\nResolve (usually git_pull first), then git_sync again.`);
      }
      steps.push(combined(push) || "pushed");
      return text(`${path.basename(target)}: ${steps.join("; ")}`);
    },
  );
}
