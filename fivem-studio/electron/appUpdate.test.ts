import assert from "node:assert/strict";
import test from "node:test";

import { checkForAppUpdate, compareStableVersions } from "./appUpdate";

function githubResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("stable semantic versions compare without treating v or build metadata as precedence", () => {
  assert.equal(compareStableVersions("1.2.3", "v1.2.4"), -1);
  assert.equal(compareStableVersions("2.0.0+build.4", "v2.0.0"), 0);
  assert.equal(compareStableVersions("10.0.0", "2.99.99"), 1);
  assert.throws(() => compareStableVersions("1.2.3-beta.1", "1.2.3"), /stable semantic versions/i);
});

test("development builds skip the network and stable builds detect an official newer release", async () => {
  let calls = 0;
  const fakeFetch = async (input: string | URL | Request, init?: RequestInit) => {
    calls += 1;
    assert.equal(String(input), "https://api.github.com/repos/qbcore-framework/qb-studio/releases/latest");
    assert.equal((init?.headers as Record<string, string>)["User-Agent"], "QB-Studio-Update-Check");
    return githubResponse({
      tag_name: "v1.3.0",
      html_url: "https://github.com/qbcore-framework/qb-studio/releases/tag/v1.3.0",
      draft: false,
      prerelease: false,
    });
  };

  assert.equal(await checkForAppUpdate("0.0.0-development", fakeFetch), null);
  assert.equal(calls, 0);
  assert.deepEqual(await checkForAppUpdate("1.2.4", fakeFetch), {
    currentVersion: "1.2.4",
    latestVersion: "1.3.0",
    releaseUrl: "https://github.com/qbcore-framework/qb-studio/releases/tag/v1.3.0",
    updateAvailable: true,
  });
  assert.equal(calls, 1);
});

test("release checks reject untrusted pages and report current versions without an update", async () => {
  const current = await checkForAppUpdate("1.3.0", async () => githubResponse({
    tag_name: "v1.3.0",
    html_url: "https://github.com/qbcore-framework/qb-studio/releases/tag/v1.3.0",
    draft: false,
    prerelease: false,
  }));
  assert.equal(current?.updateAvailable, false);

  await assert.rejects(
    checkForAppUpdate("1.2.0", async () => githubResponse({
      tag_name: "v1.3.0",
      html_url: "https://example.com/releases/v1.3.0",
      draft: false,
      prerelease: false,
    })),
    /outside the official QB Studio repository/i,
  );
});

test("release checks ignore prereleases and bound the upstream response", async () => {
  assert.equal(await checkForAppUpdate("1.2.0", async () => githubResponse({
    tag_name: "v1.3.0-beta.1",
    html_url: "https://github.com/qbcore-framework/qb-studio/releases/tag/v1.3.0-beta.1",
    draft: false,
    prerelease: true,
  })), null);

  const oversized = new Response("{}", {
    headers: { "content-length": String(256 * 1024 + 1) },
  });
  await assert.rejects(checkForAppUpdate("1.2.0", async () => oversized), /too large/i);
});
