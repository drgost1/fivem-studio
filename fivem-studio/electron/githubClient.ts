// Repo metadata lookup + clone, for the "Import from GitHub" panel.
// Uses the unauthenticated GitHub REST API (60 req/hr/IP — plenty for a
// one-off "paste a URL, see the info" flow) and shells out to the user's
// own `git` for cloning rather than bundling a git implementation.

import { execFile } from "node:child_process";
import path from "node:path";
import fs from "node:fs";

export interface RepoInfo {
  owner: string;
  repo: string;
  fullName: string;
  description: string | null;
  stars: number;
  language: string | null;
  license: string | null;
  htmlUrl: string;
  defaultBranch: string;
}

export class GithubError extends Error {}

function validRepoPart(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value) && value !== "." && value !== "..";
}

/** Parses owner/repo out of a GitHub URL or an "owner/repo" shorthand. */
export function parseGithubRepo(input: string): { owner: string; repo: string } {
  const trimmed = input.trim().replace(/\.git$/, "");

  const shorthand = trimmed.match(/^([\w.-]+)\/([\w.-]+)$/);
  if (shorthand) {
    if (!validRepoPart(shorthand[1]) || !validRepoPart(shorthand[2])) throw new GithubError("GitHub owner and repo names are invalid.");
    return { owner: shorthand[1], repo: shorthand[2] };
  }

  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com" || url.username || url.password) {
      throw new GithubError(`Not a github.com URL: ${input}`);
    }
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length < 2) {
      throw new GithubError(`Could not find owner/repo in URL: ${input}`);
    }
    if (!validRepoPart(parts[0]) || !validRepoPart(parts[1])) throw new GithubError("GitHub owner and repo names are invalid.");
    return { owner: parts[0], repo: parts[1] };
  } catch (err) {
    if (err instanceof GithubError) throw err;
    throw new GithubError(`Could not parse "${input}" as a GitHub repo URL or owner/repo shorthand.`);
  }
}

export async function fetchRepoInfo(input: string): Promise<RepoInfo> {
  const { owner, repo } = parseGithubRepo(input);

  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "ghz-workbench" },
  });

  if (res.status === 404) {
    throw new GithubError(`No such repo: ${owner}/${repo}`);
  }
  if (res.status === 403) {
    throw new GithubError("GitHub API rate limit hit (unauthenticated requests are capped at 60/hr). Try again later.");
  }
  if (!res.ok) {
    throw new GithubError(`GitHub API returned HTTP ${res.status} for ${owner}/${repo}`);
  }

  const data = (await res.json()) as {
    full_name: string;
    description: string | null;
    stargazers_count: number;
    language: string | null;
    license: { name: string } | null;
    html_url: string;
    default_branch: string;
  };

  return {
    owner,
    repo,
    fullName: data.full_name,
    description: data.description,
    stars: data.stargazers_count,
    language: data.language,
    license: data.license?.name ?? null,
    htmlUrl: data.html_url,
    defaultBranch: data.default_branch,
  };
}

export interface CloneResult {
  ok: boolean;
  destPath?: string;
  error?: string;
}

/** Clones `repoUrl` into `<projectRoot>/<repo-name>`. Requires `git` on PATH. */
export function cloneRepo(repoUrl: string, projectRoot: string): Promise<CloneResult> {
  return new Promise((resolve) => {
    const { owner, repo } = parseGithubRepo(repoUrl);
    const destPath = path.join(projectRoot, repo);

    if (fs.existsSync(destPath)) {
      resolve({ ok: false, error: `${destPath} already exists — remove it or pick a different repo.` });
      return;
    }

    // Construct from validated pieces, never retain query strings, fragments,
    // alternate hosts, or embedded credentials supplied by the renderer.
    const cloneUrl = `https://github.com/${owner}/${repo}.git`;

    execFile("git", ["clone", "--depth", "1", cloneUrl, destPath], (error, _stdout, stderr) => {
      if (error) {
        resolve({ ok: false, error: stderr?.trim() || error.message });
        return;
      }
      resolve({ ok: true, destPath });
    });
  });
}
