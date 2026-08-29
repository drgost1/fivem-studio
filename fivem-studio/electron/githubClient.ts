// Repository search/metadata lookup + clone for the GitHub import panel.
// Public API calls are deliberately user-triggered rather than type-ahead, and
// cloning still goes through the strict github.com URL/owner-repo parser.

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

export interface RepoSearchResult {
  owner: string;
  repo: string;
  fullName: string;
  description: string | null;
  stars: number;
  language: string | null;
}

export interface OrganizationRepoListing {
  organization: string;
  repositories: RepoSearchResult[];
  truncated: boolean;
}

export class GithubError extends Error {}

type GithubFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

const GITHUB_HEADERS = {
  Accept: "application/vnd.github+json",
  "User-Agent": "ghz-workbench",
  "X-GitHub-Api-Version": "2022-11-28",
};
const GITHUB_REQUEST_TIMEOUT_MS = 10_000;
const GITHUB_SEARCH_LIMIT = 6;
const GITHUB_ORG_PAGE_SIZE = 100;
const GITHUB_ORG_MAX_PAGES = 3;

function validRepoPart(value: string): boolean {
  return value.length <= 100 && /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value) && value !== "." && value !== "..";
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function stars(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function rateLimitError(response: Response): GithubError | null {
  const retryHeader = response.headers.get("retry-after");
  const retryAfter = retryHeader === null ? null : Number(retryHeader);
  const remaining = response.headers.get("x-ratelimit-remaining");
  const resetHeader = response.headers.get("x-ratelimit-reset");
  const reset = resetHeader === null ? null : Number(resetHeader);
  // A successful response may legitimately consume the caller's final request
  // and report `remaining: 0`; its payload is still valid. Only error responses
  // should be converted into a rate-limit message.
  if (response.status !== 403 && response.status !== 429) return null;
  if (response.status === 403 && remaining !== "0" && retryAfter === null) return null;
  if (retryAfter !== null && Number.isFinite(retryAfter) && retryAfter > 0) {
    return new GithubError(`GitHub API rate limit reached. Try again in ${Math.ceil(retryAfter)} seconds.`);
  }
  if (reset !== null && Number.isFinite(reset) && reset > 0) {
    return new GithubError(`GitHub API rate limit reached. Try again after ${new Date(reset * 1000).toLocaleTimeString()}.`);
  }
  return new GithubError("GitHub API rate limit reached. Wait at least one minute before trying again.");
}

async function githubRequest(url: URL, fetcher: GithubFetch): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GITHUB_REQUEST_TIMEOUT_MS);
  try {
    return await fetcher(url, { headers: GITHUB_HEADERS, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) throw new GithubError("GitHub did not respond within 10 seconds.");
    throw new GithubError(`Could not reach GitHub: ${(error as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
}

/** Parses owner/repo out of a GitHub URL or an "owner/repo" shorthand. */
export function parseGithubRepo(input: string): { owner: string; repo: string } {
  const trimmed = input.trim();
  const shorthandInput = trimmed.replace(/\.git$/, "");

  const shorthand = shorthandInput.match(/^([\w.-]+)\/([\w.-]+)$/);
  if (shorthand) {
    if (!validRepoPart(shorthand[1]) || !validRepoPart(shorthand[2])) throw new GithubError("GitHub owner and repo names are invalid.");
    return { owner: shorthand[1], repo: shorthand[2] };
  }

  try {
    const url = new URL(trimmed);
    if (
      url.protocol !== "https:" ||
      url.hostname.toLowerCase() !== "github.com" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new GithubError(`Not a github.com URL: ${input}`);
    }
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length !== 2) {
      throw new GithubError(`Expected an exact github.com/owner/repo URL: ${input}`);
    }
    const repo = parts[1].replace(/\.git$/, "");
    if (!validRepoPart(parts[0]) || !validRepoPart(repo)) throw new GithubError("GitHub owner and repo names are invalid.");
    return { owner: parts[0], repo };
  } catch (err) {
    if (err instanceof GithubError) throw err;
    throw new GithubError(`Could not parse "${input}" as a GitHub repo URL or owner/repo shorthand.`);
  }
}

/** Bare discovery is intentionally a repository-name token, not raw GitHub
 * search syntax, so callers cannot smuggle qualifiers into the query. */
export function normalizeGithubRepoSearch(input: string): string {
  const term = input.trim();
  if (!term || !validRepoPart(term)) {
    throw new GithubError("Search with a repository name up to 100 characters using letters, numbers, ., _, or -.");
  }
  return term;
}

function parseRepoInfoPayload(value: unknown): RepoInfo {
  const data = record(value);
  if (!data || typeof data.full_name !== "string" || typeof data.default_branch !== "string" || !data.default_branch) {
    throw new GithubError("GitHub returned incomplete repository metadata.");
  }
  const canonical = parseGithubRepo(data.full_name);
  const license = record(data.license);
  return {
    ...canonical,
    fullName: `${canonical.owner}/${canonical.repo}`,
    description: optionalText(data.description),
    stars: stars(data.stargazers_count),
    language: optionalText(data.language),
    license: optionalText(license?.name),
    htmlUrl: `https://github.com/${canonical.owner}/${canonical.repo}`,
    defaultBranch: data.default_branch,
  };
}

function parseRepoSearchResult(value: unknown): RepoSearchResult | null {
  const data = record(value);
  const ownerData = record(data?.owner);
  const owner = ownerData?.login;
  const repo = data?.name;
  if (typeof owner !== "string" || typeof repo !== "string" || !validRepoPart(owner) || !validRepoPart(repo)) return null;
  return {
    owner,
    repo,
    fullName: `${owner}/${repo}`,
    description: optionalText(data?.description),
    stars: stars(data?.stargazers_count),
    language: optionalText(data?.language),
  };
}

export async function fetchRepoInfo(input: string, fetcher: GithubFetch = fetch): Promise<RepoInfo> {
  const { owner, repo } = parseGithubRepo(input);

  const res = await githubRequest(new URL(`https://api.github.com/repos/${owner}/${repo}`), fetcher);

  if (res.status === 404) {
    throw new GithubError(`No such repo: ${owner}/${repo}`);
  }
  const limited = rateLimitError(res);
  if (limited) throw limited;
  if (!res.ok) {
    throw new GithubError(`GitHub API returned HTTP ${res.status} for ${owner}/${repo}`);
  }

  return parseRepoInfoPayload(await res.json());
}

export async function searchGithubRepos(input: string, fetcher: GithubFetch = fetch): Promise<RepoSearchResult[]> {
  const term = normalizeGithubRepoSearch(input);
  const url = new URL("https://api.github.com/search/repositories");
  url.search = new URLSearchParams({ q: `${term} in:name`, per_page: String(GITHUB_SEARCH_LIMIT) }).toString();
  const res = await githubRequest(url, fetcher);

  const limited = rateLimitError(res);
  if (limited) throw limited;
  if (res.status === 422) throw new GithubError("GitHub could not search for that repository name.");
  if (!res.ok) throw new GithubError(`GitHub search returned HTTP ${res.status}.`);

  const payload = record(await res.json());
  if (!payload || !Array.isArray(payload.items)) throw new GithubError("GitHub returned incomplete search results.");
  return payload.items.map(parseRepoSearchResult).filter((item): item is RepoSearchResult => item !== null);
}

/** Resolve an exact organization login and list its public repositories. A
 * first-page 404 means the caller can fall back to repository-name search. */
export async function listGithubOrganizationRepos(
  input: string,
  fetcher: GithubFetch = fetch,
): Promise<OrganizationRepoListing | null> {
  const term = normalizeGithubRepoSearch(input);
  const repositories: RepoSearchResult[] = [];

  for (let page = 1; page <= GITHUB_ORG_MAX_PAGES; page += 1) {
    const url = new URL(`https://api.github.com/orgs/${encodeURIComponent(term)}/repos`);
    url.search = new URLSearchParams({
      type: "public",
      sort: "full_name",
      direction: "asc",
      per_page: String(GITHUB_ORG_PAGE_SIZE),
      page: String(page),
    }).toString();
    const res = await githubRequest(url, fetcher);
    if (res.status === 404 && page === 1) return null;
    const limited = rateLimitError(res);
    if (limited) throw limited;
    if (!res.ok) throw new GithubError(`GitHub organization lookup returned HTTP ${res.status}.`);

    const payload: unknown = await res.json();
    if (!Array.isArray(payload)) throw new GithubError("GitHub returned incomplete organization repositories.");
    repositories.push(...payload.map(parseRepoSearchResult).filter((item): item is RepoSearchResult => item !== null));

    const hasNextPage = /<[^>]+>;\s*rel="next"/.test(res.headers.get("link") ?? "");
    if (!hasNextPage) {
      return {
        organization: repositories[0]?.owner ?? term,
        repositories,
        truncated: false,
      };
    }
    if (page === GITHUB_ORG_MAX_PAGES) {
      return {
        organization: repositories[0]?.owner ?? term,
        repositories,
        truncated: true,
      };
    }
  }

  throw new GithubError("GitHub organization pagination ended unexpectedly.");
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
