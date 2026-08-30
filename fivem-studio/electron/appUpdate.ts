const LATEST_RELEASE_URL = "https://api.github.com/repos/qbcore-framework/qb-studio/releases/latest";
const RELEASE_PAGE_PREFIX = "https://github.com/qbcore-framework/qb-studio/releases/tag/";
const MAX_RELEASE_RESPONSE_BYTES = 256 * 1024;
const STABLE_VERSION = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z.-]+)?$/;

export interface AppUpdateStatus {
  currentVersion: string;
  latestVersion: string;
  releaseUrl: string;
  updateAvailable: boolean;
}

type StableVersion = readonly [major: number, minor: number, patch: number];

function parseStableVersion(value: string): StableVersion | null {
  const match = STABLE_VERSION.exec(value);
  if (!match) return null;
  const version = [Number(match[1]), Number(match[2]), Number(match[3])] as const;
  return version.every(Number.isSafeInteger) ? version : null;
}

export function compareStableVersions(left: string, right: string): number {
  const leftVersion = parseStableVersion(left);
  const rightVersion = parseStableVersion(right);
  if (!leftVersion || !rightVersion) throw new Error("Only stable semantic versions can be compared.");
  for (let index = 0; index < leftVersion.length; index += 1) {
    if (leftVersion[index] !== rightVersion[index]) return leftVersion[index] < rightVersion[index] ? -1 : 1;
  }
  return 0;
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RELEASE_RESPONSE_BYTES) {
    throw new Error("The release response is too large.");
  }
  if (!response.body) throw new Error("The release response was empty.");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > MAX_RELEASE_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("The release response is too large.");
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return JSON.parse(text) as unknown;
}

function validatedReleasePage(value: unknown, tagName: string): string {
  if (typeof value !== "string") throw new Error("The latest release did not include a valid download page.");
  const expected = `${RELEASE_PAGE_PREFIX}${tagName}`;
  if (value !== expected) throw new Error("The latest release page was outside the official QB Studio repository.");
  return value;
}

/**
 * Checks the official GitHub release without downloading or installing anything.
 * Development and otherwise non-release versions deliberately skip the network.
 */
export async function checkForAppUpdate(
  currentVersion: string,
  fetchImpl: typeof fetch = fetch,
): Promise<AppUpdateStatus | null> {
  if (!parseStableVersion(currentVersion)) return null;

  const response = await fetchImpl(LATEST_RELEASE_URL, {
    method: "GET",
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2026-03-10",
      "User-Agent": "QB-Studio-Update-Check",
    },
    redirect: "error",
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`GitHub release check failed with HTTP ${response.status}.`);

  const payload = await readBoundedJson(response);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("GitHub returned an invalid latest release response.");
  }
  const release = payload as Record<string, unknown>;
  if (release.draft === true || release.prerelease === true) return null;
  const tagName = typeof release.tag_name === "string" ? release.tag_name : "";
  if (!parseStableVersion(tagName)) throw new Error("The latest release tag is not a stable semantic version.");
  const releaseUrl = validatedReleasePage(release.html_url, tagName);

  return {
    currentVersion: currentVersion.replace(/^v/, ""),
    latestVersion: tagName.replace(/^v/, "").split("+")[0],
    releaseUrl,
    updateAvailable: compareStableVersions(currentVersion, tagName) < 0,
  };
}
