import assert from "node:assert/strict";
import test from "node:test";

import {
  fetchRepoInfo,
  listGithubOrganizationRepos,
  normalizeGithubRepoSearch,
  parseGithubRepo,
  searchGithubRepos,
} from "./githubClient";

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

test("GitHub repository parsing accepts only exact github.com repositories", () => {
  assert.deepEqual(parseGithubRepo("qbcore-framework/qb-core"), {
    owner: "qbcore-framework",
    repo: "qb-core",
  });
  assert.deepEqual(parseGithubRepo("https://github.com/qbcore-framework/qb-core.git"), {
    owner: "qbcore-framework",
    repo: "qb-core",
  });
  assert.throws(() => parseGithubRepo("qb-core"), /Could not parse/);
  assert.throws(() => parseGithubRepo("http://github.com/owner/repo"), /Not a github.com URL/);
  assert.throws(() => parseGithubRepo("https://example.com/owner/repo"), /Not a github.com URL/);
  assert.throws(() => parseGithubRepo("https://github.com/owner/repo/issues/1"), /exact github\.com\/owner\/repo/);
  assert.throws(() => parseGithubRepo("https://github.com/owner/repo/tree/main"), /exact github\.com\/owner\/repo/);
  assert.throws(() => parseGithubRepo("https://github.com/owner/repo?tab=readme"), /Not a github.com URL/);
  assert.throws(() => parseGithubRepo("owner/../repo"), /Could not parse|invalid/);
});

test("repository-name search is bounded and cannot inject GitHub qualifiers", async () => {
  assert.equal(normalizeGithubRepoSearch(" qb-core "), "qb-core");
  for (const invalid of ["", "qb core", "owner/repo", "user:someone", "x".repeat(101)]) {
    assert.throws(() => normalizeGithubRepoSearch(invalid), /Search with a repository name/);
  }

  let called = false;
  await assert.rejects(
    searchGithubRepos("qb core", async () => {
      called = true;
      return jsonResponse({ items: [] });
    }),
    /Search with a repository name/,
  );
  assert.equal(called, false);
});

test("repository search builds an encoded name query and maps bounded public results", async () => {
  const observed: { url?: URL; init?: RequestInit } = {};
  const results = await searchGithubRepos("qb-core", async (input, init) => {
    observed.url = new URL(input);
    observed.init = init;
    return jsonResponse({
      items: [
        {
          owner: { login: "qbcore-framework" },
          name: "qb-core",
          description: "FiveM RP Framework Core",
          stargazers_count: 742,
          language: "Lua",
        },
        { owner: null, name: "malformed" },
      ],
    });
  });

  assert.ok(observed.url);
  assert.equal(observed.url.origin, "https://api.github.com");
  assert.equal(observed.url.pathname, "/search/repositories");
  assert.equal(observed.url.searchParams.get("q"), "qb-core in:name");
  assert.equal(observed.url.searchParams.get("per_page"), "6");
  assert.equal((observed.init?.headers as Record<string, string>)["User-Agent"], "qb-studio");
  assert.deepEqual(results, [
    {
      owner: "qbcore-framework",
      repo: "qb-core",
      fullName: "qbcore-framework/qb-core",
      description: "FiveM RP Framework Core",
      stars: 742,
      language: "Lua",
    },
  ]);
});

test("repository search handles empty results, validation failures, and rate limits", async () => {
  assert.deepEqual(
    await searchGithubRepos("nothing-here", async () => jsonResponse({ items: [] })),
    [],
  );
  await assert.rejects(
    searchGithubRepos("qb-core", async () => jsonResponse({ message: "Validation Failed" }, 422)),
    /could not search/i,
  );
  await assert.rejects(
    searchGithubRepos("qb-core", async () =>
      jsonResponse({ message: "rate limited" }, 429, { "retry-after": "12", "x-ratelimit-remaining": "0" }),
    ),
    /12 seconds/,
  );

  assert.deepEqual(
    await searchGithubRepos("last-request", async () =>
      jsonResponse({ items: [] }, 200, { "x-ratelimit-remaining": "0" }),
    ),
    [],
    "the final successful request remains usable even when the remaining quota reaches zero",
  );
});

test("organization lookup uses the public endpoint and validates returned repositories", async () => {
  const observed: { url?: URL; init?: RequestInit } = {};
  const listing = await listGithubOrganizationRepos("qbcore-fivem", async (input, init) => {
    observed.url = new URL(input);
    observed.init = init;
    return jsonResponse([
      {
        owner: { login: "qbcore-fivem" },
        name: "qb-core",
        description: "FiveM RP Framework Core",
        stargazers_count: 742,
        language: "Lua",
        clone_url: "https://attacker.invalid/not-used",
      },
      { owner: null, name: "malformed" },
    ]);
  });

  assert.ok(observed.url);
  assert.equal(observed.url.origin, "https://api.github.com");
  assert.equal(observed.url.pathname, "/orgs/qbcore-fivem/repos");
  assert.equal(observed.url.searchParams.get("type"), "public");
  assert.equal(observed.url.searchParams.get("sort"), "full_name");
  assert.equal(observed.url.searchParams.get("direction"), "asc");
  assert.equal(observed.url.searchParams.get("per_page"), "100");
  assert.equal(observed.url.searchParams.get("page"), "1");
  assert.equal((observed.init?.headers as Record<string, string>)["X-GitHub-Api-Version"], "2022-11-28");
  assert.deepEqual(listing, {
    organization: "qbcore-fivem",
    repositories: [
      {
        owner: "qbcore-fivem",
        repo: "qb-core",
        fullName: "qbcore-fivem/qb-core",
        description: "FiveM RP Framework Core",
        stars: 742,
        language: "Lua",
      },
    ],
    truncated: false,
  });
  assert.equal("clone_url" in (listing?.repositories[0] ?? {}), false);
});

test("organization lookup distinguishes a missing organization and an empty one", async () => {
  assert.equal(
    await listGithubOrganizationRepos("not-an-org", async () => jsonResponse({ message: "Not Found" }, 404)),
    null,
  );
  assert.deepEqual(
    await listGithubOrganizationRepos("empty-org", async () => jsonResponse([])),
    { organization: "empty-org", repositories: [], truncated: false },
  );
});

test("organization lookup follows only bounded GitHub pagination", async () => {
  const pages: number[] = [];
  const listing = await listGithubOrganizationRepos("large-org", async (input) => {
    const url = new URL(input);
    const page = Number(url.searchParams.get("page"));
    pages.push(page);
    const next = `<https://api.github.com/orgs/attacker/repos?page=${page + 1}>; rel="next"`;
    return jsonResponse(
      [
        {
          owner: { login: "large-org" },
          name: `repo-${page}`,
          stargazers_count: page,
        },
      ],
      200,
      { link: next },
    );
  });

  assert.deepEqual(pages, [1, 2, 3]);
  assert.equal(listing?.repositories.length, 3);
  assert.equal(listing?.truncated, true);
  assert.deepEqual(
    listing?.repositories.map((repo) => repo.fullName),
    ["large-org/repo-1", "large-org/repo-2", "large-org/repo-3"],
  );
});

test("organization lookup reports malformed payloads, HTTP failures, and rate limits", async () => {
  await assert.rejects(
    listGithubOrganizationRepos("broken-org", async () => jsonResponse({ repositories: [] })),
    /incomplete organization repositories/i,
  );
  await assert.rejects(
    listGithubOrganizationRepos("broken-org", async () => jsonResponse({ message: "Server Error" }, 500)),
    /HTTP 500/,
  );
  await assert.rejects(
    listGithubOrganizationRepos("limited-org", async () =>
      jsonResponse(
        { message: "API rate limit exceeded" },
        403,
        { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "2000000000" },
      ),
    ),
    /rate limit reached/i,
  );
});

test("exact lookup validates metadata and constructs the canonical clone URL", async () => {
  const info = await fetchRepoInfo("qbcore-framework/qb-core", async () =>
    jsonResponse({
      full_name: "qbcore-framework/qb-core",
      description: "FiveM RP Framework Core",
      stargazers_count: 742,
      language: "Lua",
      license: { name: "GNU General Public License v3.0" },
      html_url: "https://attacker.invalid/not-used",
      default_branch: "main",
    }),
  );
  assert.equal(info.htmlUrl, "https://github.com/qbcore-framework/qb-core");
  assert.equal(info.fullName, "qbcore-framework/qb-core");
  assert.equal(info.defaultBranch, "main");
  assert.equal(info.license, "GNU General Public License v3.0");

  await assert.rejects(
    fetchRepoInfo("qbcore-framework/missing", async () => jsonResponse({ message: "Not Found" }, 404)),
    /No such repo/,
  );
  await assert.rejects(
    fetchRepoInfo("qbcore-framework/qb-core", async () => jsonResponse({ full_name: "qbcore-framework/qb-core" })),
    /incomplete repository metadata/,
  );
});
