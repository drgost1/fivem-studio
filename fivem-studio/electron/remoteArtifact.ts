import { runSsh, shellQuote } from "./remoteRuntime";

export type RemoteArtifactTrack = "recommended" | "latest";

export interface RemoteArtifactStatus {
  track: RemoteArtifactTrack;
  /** Numeric Cfx.re build, parsed from the version string. */
  build: number;
  /** Full version identifier as published (build-hash). */
  version: string;
  downloadUrl: string;
  /** Build recorded by the last FiveM Studio install on the host, if any. */
  installedBuild: number | null;
  /** Null when no managed install has recorded a build yet. */
  updateAvailable: boolean | null;
}

export interface RemoteArtifactInstallResult extends RemoteArtifactStatus {
  installedAt: string;
  note: string;
}

/** Official Cfx.re changelog API — the same source txAdmin consults. */
const CHANGELOG_URL = "https://changelogs-live.fivem.net/api/changelog/versions/linux/server";
const MARKER_NAME = ".fivem-studio-artifact.json";
// Conservative charset: these paths are embedded in a host-side shell script
// (always through shellQuote, but defence stacks).
const SAFE_REMOTE_DIR = /^\/[A-Za-z0-9._@~/-]+$/;

function assertArtifactDir(value: unknown): string {
  const trimmed = typeof value === "string" ? value.trim().replace(/\/+$/, "") : "";
  if (!SAFE_REMOTE_DIR.test(trimmed) || trimmed.includes("..")) {
    throw new Error(
      "The artifact directory must be an absolute host path using only letters, digits, dot, dash, underscore, tilde and slash.",
    );
  }
  return trimmed;
}

function trackOrDefault(value: unknown): RemoteArtifactTrack {
  return value === "latest" ? "latest" : "recommended";
}

interface PublishedBuild {
  build: number;
  version: string;
  downloadUrl: string;
}

async function fetchLinuxTrack(track: RemoteArtifactTrack): Promise<PublishedBuild> {
  let payload: unknown;
  try {
    const response = await fetch(CHANGELOG_URL, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`answered HTTP ${response.status}`);
    payload = await response.json();
  } catch (error) {
    throw new Error(`Could not read the Cfx.re changelog API: ${(error as Error).message}`);
  }
  const record = payload as Record<string, unknown>;
  const version = record[track];
  const downloadUrl = record[`${track}_download`];
  if (typeof version !== "string" || typeof downloadUrl !== "string") {
    throw new Error(`The Cfx.re changelog API did not publish a ${track} Linux build.`);
  }
  const build = Number(/^(\d+)-/.exec(version)?.[1]);
  if (!Number.isSafeInteger(build) || build <= 0) {
    throw new Error(`Unrecognised Cfx.re version format: ${version.slice(0, 60)}`);
  }
  // The URL is embedded in a host-side script (quoted); refuse anything that
  // is not a plain HTTPS URL from the expected charset.
  if (!/^https:\/\/[A-Za-z0-9./_%-]+$/.test(downloadUrl)) {
    throw new Error("The Cfx.re changelog API returned an unexpected download URL.");
  }
  return { build, version, downloadUrl };
}

async function readInstalledBuild(sshTarget: string, artifactDir: string): Promise<number | null> {
  const result = await runSsh(
    sshTarget,
    ["sh", "-s"],
    "cat " + shellQuote(artifactDir + "/" + MARKER_NAME) + " 2>/dev/null",
    20_000,
  );
  if (result.code !== 0) return null;
  try {
    const parsed = JSON.parse(result.stdout) as { build?: unknown };
    return Number.isSafeInteger(parsed.build) && (parsed.build as number) > 0 ? (parsed.build as number) : null;
  } catch {
    return null;
  }
}

export async function checkRemoteArtifact(
  sshTarget: string,
  artifactDirValue: unknown,
  trackValue: unknown,
): Promise<RemoteArtifactStatus> {
  const artifactDir = assertArtifactDir(artifactDirValue);
  const track = trackOrDefault(trackValue);
  const [published, installedBuild] = await Promise.all([
    fetchLinuxTrack(track),
    readInstalledBuild(sshTarget, artifactDir),
  ]);
  return {
    track,
    ...published,
    installedBuild,
    updateAvailable: installedBuild === null ? null : installedBuild < published.build,
  };
}

export async function installRemoteArtifact(
  sshTarget: string,
  artifactDirValue: unknown,
  trackValue: unknown,
): Promise<RemoteArtifactInstallResult> {
  const artifactDir = assertArtifactDir(artifactDirValue);
  const track = trackOrDefault(trackValue);
  const published = await fetchLinuxTrack(track);
  const installedAt = new Date().toISOString();
  const marker = JSON.stringify({
    schemaVersion: 1,
    build: published.build,
    version: published.version,
    track,
    installedAt,
  });
  const q = shellQuote;
  // Download and extract into a stage inside the artifact directory (same
  // filesystem, so the final moves are atomic renames), keep the previous
  // build as a rolling backup, then swap. A running FXServer keeps serving
  // from its open file handles; the new build applies on the next restart.
  const script = [
    "set -eu",
    "DIR=" + q(artifactDir),
    "URL=" + q(published.downloadUrl),
    'test -d "$DIR" || { echo "ERR: the artifact directory does not exist on the host."; exit 40; }',
    'test -f "$DIR/run.sh" || { echo "ERR: no run.sh in that directory - it does not look like a Linux FXServer artifact folder."; exit 41; }',
    'command -v curl >/dev/null 2>&1 || { echo "ERR: curl is not installed on the host."; exit 42; }',
    'STAGE="$DIR/.fivem-studio-stage"',
    'BACKUP="$DIR/.fivem-studio-backup"',
    'rm -rf "$STAGE"',
    'mkdir -p "$STAGE"',
    'curl -fsSL --max-time 420 -o "$STAGE/fx.tar.xz" "$URL"',
    'tar -xJf "$STAGE/fx.tar.xz" -C "$STAGE"',
    'test -f "$STAGE/run.sh" || { echo "ERR: the downloaded archive does not contain run.sh."; exit 43; }',
    'test -d "$STAGE/alpine" || { echo "ERR: the downloaded archive does not contain alpine/."; exit 44; }',
    'rm -rf "$BACKUP"',
    'mkdir -p "$BACKUP"',
    'mv "$DIR/run.sh" "$BACKUP/run.sh"',
    'if [ -d "$DIR/alpine" ]; then mv "$DIR/alpine" "$BACKUP/alpine"; fi',
    'mv "$STAGE/run.sh" "$DIR/run.sh"',
    'mv "$STAGE/alpine" "$DIR/alpine"',
    'rm -rf "$STAGE"',
    "printf '%s' " + q(marker) + ' > "$DIR/' + MARKER_NAME + '"',
    'echo "OK"',
  ].join("\n");
  const result = await runSsh(sshTarget, ["sh", "-s"], script, 480_000, 64 * 1024);
  if (result.code !== 0 || !result.stdout.includes("OK")) {
    const declared = result.stdout.split("\n").reverse().find((line) => line.startsWith("ERR: "));
    const detail = declared ?? result.stderr.trim().split("\n").slice(-3).join(" ").slice(0, 400);
    throw new Error(
      (detail || "The install script failed on the host.") +
        " If the swap had already begun, the previous build is intact in .fivem-studio-backup inside the artifact directory.",
    );
  }
  return {
    track,
    ...published,
    installedBuild: published.build,
    updateAvailable: false,
    installedAt,
    note: "The new build takes effect the next time the server restarts (txAdmin restart is enough).",
  };
}
