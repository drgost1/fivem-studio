import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn, type SpawnOptions } from "node:child_process";
import type { Readable } from "node:stream";
import yauzl, { type Entry, type ZipFile } from "yauzl";

export type ArtifactFlavor = "legacy" | "enhanced";
export type ArtifactTrack = "recommended" | "latest";

export interface ArtifactDescriptor {
  flavor: ArtifactFlavor;
  track: ArtifactTrack;
  build: number;
  displayName: string;
  downloadUrl: string;
  archiveSize: number | null;
  publishedAt: string | null;
}

export interface ArtifactStatus extends ArtifactDescriptor {
  installedBuild: number | null;
  updateAvailable: boolean | null;
  recoveryNotice?: string;
}

export interface ArtifactUpdateResult extends ArtifactStatus {
  sha256: string;
  backupPath: string;
  installedAt: string;
  warning?: string;
}

export interface ArtifactProgress {
  phase: "checking" | "downloading" | "extracting" | "validating" | "installing" | "complete";
  transferredBytes: number;
  totalBytes: number | null;
}

export interface ArtifactTarget {
  executablePath: string;
  executableName: "FXServer.exe" | "cfx-server.exe";
  root: string;
  flavor: ArtifactFlavor;
}

interface ArtifactInstallRecord {
  schemaVersion: 1;
  artifactRoot: string;
  executableName: ArtifactTarget["executableName"];
  flavor: ArtifactFlavor;
  build: number;
  track: ArtifactTrack;
  downloadUrl: string;
  sha256: string;
  installedAt: string;
  backupPath: string;
}

interface ArtifactTransactionJournal {
  schemaVersion: 1;
  phase: "prepared" | "backup-created";
  executablePath: string;
  artifactRoot: string;
  archivePath: string;
  stagePath: string;
  backupPath: string;
  record: ArtifactInstallRecord;
}

const DOWNLOAD_PAGE = "https://docs.fivem.net/docs/server-download/";
const MAX_PAGE_BYTES = 2 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 1024 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 100_000;
const MAX_ARCHIVE_UNCOMPRESSED_BYTES = 8 * 1024 * 1024 * 1024;
const MAX_ARCHIVE_ENTRY_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_REDIRECTS = 3;

function normalizedPath(value: string): string {
  const resolved = path.resolve(value).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function canonicalPathIfPresent(value: string): string {
  try {
    return fs.realpathSync.native(value);
  } catch {
    return path.resolve(value);
  }
}

function pathsOverlap(first: string, second: string): boolean {
  const a = normalizedPath(first);
  const b = normalizedPath(second);
  const aToB = path.relative(a, b);
  const bToA = path.relative(b, a);
  const isInside = (relative: string) =>
    relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  return isInside(aToB) || isInside(bToA);
}

function assertOrdinaryFile(filePath: string, label: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(filePath);
  } catch {
    throw new Error(`${label} does not exist.`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be an ordinary file, not a link.`);
}

function expectedSystemResources(root: string, executableName: ArtifactTarget["executableName"]): string {
  return executableName === "FXServer.exe"
    ? path.join(root, "citizen", "system_resources")
    : path.join(root, "system_resources");
}

function hasCompleteArtifactLayout(root: string, executableName: ArtifactTarget["executableName"]): boolean {
  try {
    const executable = fs.lstatSync(path.join(root, executableName));
    const resources = fs.lstatSync(expectedSystemResources(root, executableName));
    return executable.isFile() && !executable.isSymbolicLink() && resources.isDirectory() && !resources.isSymbolicLink();
  } catch {
    return false;
  }
}

/** Resolve and validate the one executable/directory that launch and update may touch. */
export function resolveArtifactTarget(exePath: string, txDataPath?: string | null): ArtifactTarget {
  if (!path.isAbsolute(exePath)) throw new Error("The local server executable path must be absolute.");
  assertOrdinaryFile(exePath, "The selected local server executable");

  const requested = path.resolve(exePath);
  const requestedRoot = path.dirname(requested);
  const requestedRootStat = fs.lstatSync(requestedRoot);
  if (!requestedRootStat.isDirectory() || requestedRootStat.isSymbolicLink()) {
    throw new Error("The server artifact folder may not be a link or junction.");
  }
  const canonical = fs.realpathSync.native(requested);

  const lowerName = path.basename(canonical).toLowerCase();
  const executableName =
    lowerName === "fxserver.exe" ? "FXServer.exe" : lowerName === "cfx-server.exe" ? "cfx-server.exe" : null;
  if (!executableName) throw new Error("Choose FXServer.exe or cfx-server.exe from a Cfx.re Windows artifact folder.");

  const root = path.dirname(canonical);
  if (normalizedPath(root) === normalizedPath(path.parse(root).root)) {
    throw new Error("A drive root cannot be used as the server artifact folder.");
  }
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("The server artifact folder may not be a link or junction.");
  }
  if (!hasCompleteArtifactLayout(root, executableName)) {
    throw new Error("The selected executable is not inside a complete Cfx.re Windows server artifact folder.");
  }

  if (txDataPath) {
    const txData = canonicalPathIfPresent(txDataPath);
    if (pathsOverlap(root, txData)) {
      throw new Error("The server artifact folder and txData must be separate. Updates never replace or contain txData.");
    }
  }

  return {
    executablePath: canonical,
    executableName,
    root,
    flavor: executableName === "FXServer.exe" ? "legacy" : "enhanced",
  };
}

export function buildServerLaunchArgs(
  flavor: ArtifactFlavor,
  txDataPath: string,
  controlProfile: string | null,
): string[] {
  // Current Enhanced artifacts reject serverProfile outright. The default
  // profile also never needs an argument on legacy FXServer, so keep the
  // deprecated compatibility switches only for legacy artifacts which may
  // predate TXHOST_DATA_PATH.
  if (flavor === "enhanced") return [];
  const args = ["+set", "txDataPath", path.resolve(txDataPath)];
  if (controlProfile && controlProfile.toLowerCase() !== "default") {
    args.push("+set", "serverProfile", controlProfile);
  }
  return args;
}

/** txAdmin v8 removed the txDataPath ConVar. Pass the official boot-scoped
 * replacement only to the server process rather than changing the user's
 * machine environment. */
export function buildServerLaunchEnvironment(txDataPath: string): Record<string, string> {
  return { TXHOST_DATA_PATH: path.resolve(txDataPath) };
}

export function buildServerSpawnOptions(artifactRoot: string, txDataPath: string): SpawnOptions {
  return {
    cwd: artifactRoot,
    // On Windows, `detached` overrides CREATE_NO_WINDOW. Keep it false so
    // `windowsHide` also suppresses Windows Terminal's console delegation.
    detached: false,
    windowsHide: true,
    shell: false,
    stdio: "ignore",
    env: { ...process.env, ...buildServerLaunchEnvironment(txDataPath) },
  };
}

function helperEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const names = ["SystemRoot", "WINDIR", "PATH", "PATHEXT", "TEMP", "TMP"];
  return {
    ...Object.fromEntries(names.flatMap((name) => (process.env[name] ? [[name, process.env[name]]] : []))),
    ...extra,
  };
}

export function parseProcessIds(output: string): number[] {
  return output
    .split(/\r?\n/)
    .map((line) => Number(line.trim()))
    .filter((pid) => Number.isSafeInteger(pid) && pid > 0);
}

/** Kept exportable so the real Windows PowerShell parser/executor can cover
 * every branch in tests. Newlines are significant here: inserting a semicolon
 * between an `if` block and `elseif` turns `elseif` into a command. */
export function buildServerProcessQueryScript(): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    "$target = [IO.Path]::GetFullPath($env:GHZ_TARGET_SERVER_EXE)",
    "Get-CimInstance Win32_Process | Where-Object { $_.Name -ieq 'FXServer.exe' -or $_.Name -ieq 'cfx-server.exe' } | ForEach-Object {",
    "  if (-not $_.ExecutablePath) { [Console]::Out.WriteLine(('unknown:' + $_.ProcessId)) }",
    "  elseif ([IO.Path]::GetFullPath($_.ExecutablePath) -ieq $target) { [Console]::Out.WriteLine($_.ProcessId) }",
    "}",
  ].join("\r\n");
}

export function buildServerProcessStopScript(): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    "$target = [IO.Path]::GetFullPath($env:GHZ_TARGET_SERVER_EXE)",
    "$servers = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -ieq 'FXServer.exe' -or $_.Name -ieq 'cfx-server.exe' })",
    "$hidden = @($servers | Where-Object { -not $_.ExecutablePath })",
    "if ($hidden.Count -gt 0) {",
    "  $hidden | ForEach-Object { [Console]::Out.WriteLine(('unknown:' + $_.ProcessId)) }",
    "} else {",
    "  $servers | ForEach-Object {",
    "    if ([IO.Path]::GetFullPath($_.ExecutablePath) -ieq $target) {",
    "      $serverPid = [int]$_.ProcessId",
    "      [Console]::Out.WriteLine(('matched:' + $serverPid))",
    "      try {",
    "        Stop-Process -Id $serverPid -ErrorAction Stop",
    "        [Console]::Out.WriteLine(('stopped:' + $serverPid))",
    "      } catch {",
    "        $remaining = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $serverPid) -ErrorAction SilentlyContinue",
    "        if ($remaining -and (-not $remaining.ExecutablePath -or [IO.Path]::GetFullPath($remaining.ExecutablePath) -ieq $target)) { throw }",
    "      }",
    "    }",
    "  }",
    "}",
  ].join("\r\n");
}

function runServerPowerShell(script: string, executablePath: string, operation: string): Promise<string> {
  if (process.platform !== "win32") return Promise.resolve("");
  const systemRoot = process.env.SystemRoot || process.env.WINDIR;
  if (!systemRoot) throw new Error(`Windows system directory is unavailable; cannot ${operation}.`);
  const powershell = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  assertOrdinaryFile(powershell, "Windows PowerShell");

  return new Promise<string>((resolve, reject) => {
    const child = spawn(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: helperEnvironment({ GHZ_TARGET_SERVER_EXE: executablePath }),
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(() => reject(new Error(`Timed out while attempting to ${operation}.`)));
    }, 15_000);
    timer.unref();
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < 64 * 1024) stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 64 * 1024) stderr += chunk.toString("utf8");
    });
    child.once("error", (error) => finish(() => reject(error)));
    // `close` fires after stdout/stderr have closed, so parsing cannot race the
    // last buffered process id or error line.
    child.once("close", (code) => {
      finish(() => {
        if (code !== 0) {
          reject(new Error(`Could not ${operation}${stderr.trim() ? `: ${stderr.trim()}` : "."}`));
          return;
        }
        resolve(stdout);
      });
    });
  });
}

/** Find only processes whose executable path exactly matches the configured artifact. */
export async function findRunningServerPids(executablePath: string): Promise<number[]> {
  if (process.platform !== "win32") return [];
  const stdout = await runServerPowerShell(buildServerProcessQueryScript(), executablePath, "verify local server process state");
  if (/^unknown:\d+$/m.test(stdout)) {
    throw new Error("Another Cfx.re server process is running but Windows hid its executable path. Stop it before continuing.");
  }
  return parseProcessIds(stdout);
}

export interface StopLocalServerResult {
  stoppedPids: number[];
  alreadyStopped: boolean;
}

export function parseServerStopOutput(output: string): { matchedPids: number[]; stoppedPids: number[] } {
  const tagged = (tag: "matched" | "stopped") =>
    output
      .split(/\r?\n/)
      .map((line) => line.trim().match(new RegExp(`^${tag}:(\\d+)$`))?.[1])
      .filter((value): value is string => Boolean(value))
      .map(Number)
      .filter((pid) => Number.isSafeInteger(pid) && pid > 0);
  return { matchedPids: tagged("matched"), stoppedPids: tagged("stopped") };
}

/** Stop only Cfx.re processes whose executable path still exactly matches the
 * configured artifact. This also gives users a reliable escape hatch when the
 * native server console ignores its close button. */
export async function stopLocalServer(
  exePath: string,
  txDataPath: string | null,
): Promise<StopLocalServerResult> {
  const target = resolveArtifactTarget(exePath, txDataPath);
  const matchedPids = new Set<number>();
  const stoppedPids = new Set<number>();
  const deadline = Date.now() + 5_000;
  let emptySince: number | null = null;
  while (Date.now() < deadline) {
    // Enhanced can hand off to another cfx-server.exe after the first process
    // snapshot. Re-run the exact-path stop until the whole artifact tree is gone.
    const stdout = await runServerPowerShell(buildServerProcessStopScript(), target.executablePath, "stop the local server");
    if (/^unknown:\d+$/m.test(stdout)) {
      throw new Error("Another Cfx.re server process is running but Windows hid its executable path. Stop it in txAdmin.");
    }
    const parsed = parseServerStopOutput(stdout);
    parsed.matchedPids.forEach((pid) => matchedPids.add(pid));
    parsed.stoppedPids.forEach((pid) => stoppedPids.add(pid));

    const remaining = await findRunningServerPids(target.executablePath);
    if (remaining.length === 0) {
      emptySince ??= Date.now();
      if (Date.now() - emptySince >= 500) {
        return {
          stoppedPids: [...stoppedPids],
          alreadyStopped: matchedPids.size === 0,
        };
      }
    } else {
      emptySince = null;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("The local server did not stop within five seconds. Stop it in txAdmin and try again.");
}

export async function launchLocalServer(
  exePath: string,
  txDataPath: string,
  controlProfile: string | null,
): Promise<{ pid: number; controlProfile: string | null; alreadyRunning: boolean }> {
  const target = resolveArtifactTarget(exePath, txDataPath);
  const running = await findRunningServerPids(target.executablePath);
  if (running[0]) return { pid: running[0], controlProfile, alreadyRunning: true };

  if (target.flavor === "enhanced" && controlProfile && controlProfile.toLowerCase() !== "default") {
    throw new Error(
      "Current Enhanced artifacts no longer support selecting a non-default txAdmin profile at launch. Use the default profile or a separate txData folder for this server.",
    );
  }

  const child = spawn(
    target.executablePath,
    buildServerLaunchArgs(target.flavor, txDataPath, controlProfile),
    buildServerSpawnOptions(target.root, txDataPath),
  );
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  if (!child.pid) throw new Error("The local server process did not return a process id.");

  // Enhanced artifacts briefly hand off from one cfx-server.exe process to
  // another. Require a matching executable to remain continuously visible,
  // instead of trusting the launcher's original PID or a one-frame process.
  const deadline = Date.now() + 6_000;
  let runningSince: number | null = null;
  let stablePids: number[] = [];
  try {
    while (Date.now() < deadline) {
      const detected = await findRunningServerPids(target.executablePath);
      if (detected.length > 0) {
        stablePids = detected;
        runningSince ??= Date.now();
        if (Date.now() - runningSince >= 1_500) {
          child.unref();
          return { pid: stablePids[0], controlProfile, alreadyRunning: false };
        }
      } else {
        runningSince = null;
        stablePids = [];
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  } catch (error) {
    if (child.exitCode === null) child.kill();
    throw error;
  }

  const exitDetail = child.exitCode === null ? "no matching process remained running" : `the launcher exited with code ${child.exitCode}`;
  if (child.exitCode === null) child.kill();
  throw new Error(`The local server did not stay running (${exitDetail}). Check the txAdmin logs for the startup error.`);
}

function requireTrack(value: unknown): ArtifactTrack {
  if (value !== "recommended" && value !== "latest") throw new Error("Artifact track must be recommended or latest.");
  return value;
}

function entryAt(value: unknown, keys: string[]): unknown {
  let current = value;
  for (const key of keys) {
    if (typeof current !== "object" || current === null || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function validatedDownloadUrl(raw: string, flavor: ArtifactFlavor): { url: string; buildFromUrl: number | null } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Cfx.re returned an invalid artifact URL.");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash) {
    throw new Error("Cfx.re returned an unsafe artifact URL.");
  }

  if (flavor === "legacy") {
    if (url.hostname !== "runtime.fivem.net") throw new Error("The legacy artifact URL is not hosted by Cfx.re.");
    const match = url.pathname.match(
      /^\/artifacts\/fivem\/build_server_windows\/master\/(\d+)-([0-9a-f]{40})\/server\.(?:7z|zip)$/,
    );
    if (!match) throw new Error("Cfx.re returned an unexpected legacy Windows artifact path.");
    url.pathname = url.pathname.replace(/server\.(?:7z|zip)$/, "server.zip");
    return { url: url.toString(), buildFromUrl: Number(match[1]) };
  }

  if (url.hostname !== "downloads.cfx-services.net") throw new Error("The enhanced artifact URL is not hosted by Cfx.re.");
  if (!/^\/prod\/[0-9a-f-]{36}\/cfx-server_win_x64\.zip$/.test(url.pathname)) {
    throw new Error("Cfx.re returned an unexpected enhanced Windows artifact path.");
  }
  return { url: url.toString(), buildFromUrl: null };
}

/** Parse only the structured artifact values embedded in Cfx.re's official download page. */
export function parseArtifactDownloadPage(html: string, flavor: ArtifactFlavor, requestedTrack: ArtifactTrack): ArtifactDescriptor {
  const track = requireTrack(requestedTrack);
  const match = html.match(/<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!match) throw new Error("The Cfx.re download page did not contain artifact metadata.");
  let page: unknown;
  try {
    page = JSON.parse(match[1]);
  } catch {
    throw new Error("The Cfx.re download page contained invalid artifact metadata.");
  }

  const entries =
    flavor === "legacy"
      ? entryAt(page, ["props", "pageProps", "legacy", track, "windows"])
      : entryAt(page, ["props", "pageProps", "enhanced", "windows"]);
  if (!Array.isArray(entries) || entries.length === 0 || typeof entries[0] !== "object" || entries[0] === null) {
    throw new Error("No supported Cfx.re Windows artifact was found.");
  }
  const first = entries[0] as Record<string, unknown>;
  if (typeof first.downloadURL !== "string" || typeof first.subtitle !== "string" || typeof first.displayName !== "string") {
    throw new Error("Cfx.re returned incomplete artifact metadata.");
  }
  const buildMatch = first.subtitle.match(/^build\s+(\d+)$/i);
  if (!buildMatch) throw new Error("Cfx.re returned an artifact without a numeric build.");
  const build = Number(buildMatch[1]);
  if (!Number.isSafeInteger(build) || build < 1) throw new Error("Cfx.re returned an invalid artifact build.");
  const validated = validatedDownloadUrl(first.downloadURL, flavor);
  if (validated.buildFromUrl !== null && validated.buildFromUrl !== build) {
    throw new Error("The Cfx.re artifact build does not match its download path.");
  }
  return {
    flavor,
    track: flavor === "enhanced" ? "recommended" : track,
    build,
    displayName: flavor === "legacy" ? "server.zip" : "cfx-server_win_x64.zip",
    downloadUrl: validated.url,
    archiveSize: null,
    publishedAt: null,
  };
}

function assertDocsUrl(url: URL): void {
  if (
    url.protocol !== "https:" ||
    url.hostname !== "docs.fivem.net" ||
    url.username ||
    url.password ||
    url.port ||
    url.pathname !== "/docs/server-download/"
  ) {
    throw new Error("The Cfx.re download page redirected to an unexpected location.");
  }
}

async function fetchWithValidatedRedirects(
  initialUrl: string,
  method: "GET" | "HEAD",
  validate: (url: URL) => void,
  timeoutMs: number,
): Promise<Response> {
  let current = new URL(initialUrl);
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    validate(current);
    const response = await fetch(current, {
      method,
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "User-Agent": "QB-Studio-Artifact-Updater" },
    });
    if (response.status < 300 || response.status >= 400) return response;
    const location = response.headers.get("location");
    await response.body?.cancel();
    if (!location || redirects === MAX_REDIRECTS) throw new Error("Cfx.re artifact download redirected too many times.");
    current = new URL(location, current);
  }
  throw new Error("Cfx.re artifact download redirected too many times.");
}

async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error("The Cfx.re download page was unexpectedly large.");
  if (!response.body) throw new Error("The Cfx.re download page returned an empty response.");
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    const value = Buffer.from(chunk);
    total += value.length;
    if (total > maxBytes) throw new Error("The Cfx.re download page was unexpectedly large.");
    chunks.push(value);
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

function validateExactDownloadUrl(url: URL, flavor: ArtifactFlavor): void {
  validatedDownloadUrl(url.toString(), flavor);
}

export async function fetchArtifactDescriptor(flavor: ArtifactFlavor, track: ArtifactTrack): Promise<ArtifactDescriptor> {
  const pageResponse = await fetchWithValidatedRedirects(DOWNLOAD_PAGE, "GET", assertDocsUrl, 30_000);
  if (!pageResponse.ok) throw new Error(`Cfx.re's download page returned HTTP ${pageResponse.status}.`);
  const html = await readBoundedText(pageResponse, MAX_PAGE_BYTES);
  const descriptor = parseArtifactDownloadPage(html, flavor, track);

  const head = await fetchWithValidatedRedirects(
    descriptor.downloadUrl,
    "HEAD",
    (url) => validateExactDownloadUrl(url, flavor),
    30_000,
  );
  if (!head.ok) throw new Error(`Cfx.re's artifact returned HTTP ${head.status}.`);
  const archiveSize = Number(head.headers.get("content-length"));
  if (!Number.isSafeInteger(archiveSize) || archiveSize < 1 || archiveSize > MAX_ARCHIVE_BYTES) {
    throw new Error("Cfx.re returned an invalid artifact archive size.");
  }
  const contentType = head.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/zip" && contentType !== "application/octet-stream") {
    throw new Error(`Cfx.re returned an unexpected artifact content type (${contentType ?? "missing"}).`);
  }
  await head.body?.cancel();
  return {
    ...descriptor,
    archiveSize,
    publishedAt: head.headers.get("last-modified"),
  };
}

function readInstallRecord(statePath: string, target: ArtifactTarget): ArtifactInstallRecord | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, "utf8")) as Partial<ArtifactInstallRecord>;
    if (
      parsed.schemaVersion !== 1 ||
      parsed.flavor !== target.flavor ||
      parsed.executableName !== target.executableName ||
      normalizedPath(String(parsed.artifactRoot ?? "")) !== normalizedPath(target.root) ||
      !Number.isSafeInteger(parsed.build) ||
      Number(parsed.build) < 1
    ) {
      return null;
    }
    return parsed as ArtifactInstallRecord;
  } catch {
    return null;
  }
}

export async function checkArtifactUpdate(
  exePath: string,
  txDataPath: string | null,
  track: ArtifactTrack,
  statePath: string,
): Promise<ArtifactStatus> {
  const recoveryNotice = recoverInterruptedArtifactUpdate(exePath, statePath);
  const target = resolveArtifactTarget(exePath, txDataPath);
  const descriptor = await fetchArtifactDescriptor(target.flavor, track);
  const record = readInstallRecord(statePath, target);
  const installedBuild = record?.build ?? null;
  return {
    ...descriptor,
    installedBuild,
    updateAvailable: installedBuild === null ? null : descriptor.build > installedBuild,
    recoveryNotice: recoveryNotice ?? undefined,
  };
}

async function writeAll(handle: fs.promises.FileHandle, chunk: Buffer): Promise<void> {
  let offset = 0;
  while (offset < chunk.length) {
    const result = await handle.write(chunk, offset, chunk.length - offset, null);
    if (result.bytesWritten < 1) throw new Error("Could not write the artifact archive.");
    offset += result.bytesWritten;
  }
}

async function downloadArchive(
  descriptor: ArtifactDescriptor,
  outputPath: string,
  onProgress?: (progress: ArtifactProgress) => void,
): Promise<string> {
  const response = await fetchWithValidatedRedirects(
    descriptor.downloadUrl,
    "GET",
    (url) => validateExactDownloadUrl(url, descriptor.flavor),
    10 * 60_000,
  );
  if (!response.ok) throw new Error(`Cfx.re's artifact returned HTTP ${response.status}.`);
  const declared = Number(response.headers.get("content-length"));
  if (!Number.isSafeInteger(declared) || declared < 1 || declared > MAX_ARCHIVE_BYTES) {
    throw new Error("Cfx.re returned an invalid artifact archive size.");
  }
  if (descriptor.archiveSize !== null && declared !== descriptor.archiveSize) {
    throw new Error("The artifact size changed after the update check; check again before installing.");
  }
  if (!response.body) throw new Error("Cfx.re returned an empty artifact response.");

  const hash = createHash("sha256");
  const handle = await fs.promises.open(outputPath, "wx", 0o600);
  let total = 0;
  let lastProgressAt = 0;
  onProgress?.({ phase: "downloading", transferredBytes: 0, totalBytes: declared });
  try {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      const value = Buffer.from(chunk);
      total += value.length;
      if (total > declared || total > MAX_ARCHIVE_BYTES) throw new Error("The artifact exceeded its declared size.");
      hash.update(value);
      await writeAll(handle, value);
      const now = Date.now();
      if (total === declared || now - lastProgressAt >= 100) {
        onProgress?.({ phase: "downloading", transferredBytes: total, totalBytes: declared });
        lastProgressAt = now;
      }
    }
  } finally {
    await handle.close();
  }
  if (total !== declared) throw new Error(`The artifact download was incomplete (${total} of ${declared} bytes).`);
  return hash.digest("hex");
}

const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

function archivePath(name: string): string {
  if (name.length > 1024 || name.includes("\\")) {
    throw new Error(`The artifact contains an unsafe archive path: ${name.slice(0, 120)}`);
  }
  const withoutSlash = name.endsWith("/") ? name.slice(0, -1) : name;
  if (!withoutSlash || withoutSlash.startsWith("/") || /^[a-zA-Z]:/.test(withoutSlash)) {
    throw new Error(`The artifact contains an unsafe archive path: ${name.slice(0, 120)}`);
  }
  const parts = withoutSlash.split("/");
  if (
    parts.some(
      (part) =>
        !part ||
        part === "." ||
        part === ".." ||
        part.length > 255 ||
        /[<>:"|?*\u0000-\u001f]/.test(part) ||
        /[. ]$/.test(part) ||
        WINDOWS_RESERVED_NAME.test(part),
    )
  ) {
    throw new Error(`The artifact contains an unsafe archive path: ${name.slice(0, 120)}`);
  }
  return parts.join(path.sep);
}

export function validateArchiveEntryName(name: string): string {
  return archivePath(name);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let value = n;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[n] = value >>> 0;
  }
  return table;
})();

function updateCrc32(crc: number, chunk: Buffer): number {
  let value = crc;
  for (const byte of chunk) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return value >>> 0;
}

function openZip(zipPath: string): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, autoClose: true, decodeStrings: true, strictFileNames: true, validateEntrySizes: true }, (error, zip) => {
      if (error || !zip) reject(error ?? new Error("Could not open the artifact archive."));
      else resolve(zip);
    });
  });
}

function openEntryStream(zip: ZipFile, entry: Entry): Promise<Readable> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error || !stream) reject(error ?? new Error("Could not read an artifact archive entry."));
      else resolve(stream);
    });
  });
}

function isLinkEntry(entry: Entry): boolean {
  const hostSystem = entry.versionMadeBy >>> 8;
  const unixMode = entry.externalFileAttributes >>> 16;
  const unixType = unixMode & 0o170000;
  const windowsAttributes = entry.externalFileAttributes & 0xffff;
  return (hostSystem === 3 && unixType === 0o120000) || (windowsAttributes & 0x400) !== 0;
}

async function extractFile(zip: ZipFile, entry: Entry, targetPath: string): Promise<void> {
  const stream = await openEntryStream(zip, entry);
  const handle = await fs.promises.open(targetPath, "wx", 0o600);
  let bytes = 0;
  let crc = 0xffffffff;
  try {
    for await (const chunk of stream as AsyncIterable<Buffer | Uint8Array>) {
      const value = Buffer.from(chunk);
      bytes += value.length;
      if (bytes > entry.uncompressedSize) throw new Error(`Archive entry ${entry.fileName} exceeded its declared size.`);
      crc = updateCrc32(crc, value);
      await writeAll(handle, value);
    }
  } finally {
    await handle.close();
  }
  const finalCrc = (crc ^ 0xffffffff) >>> 0;
  if (bytes !== entry.uncompressedSize || finalCrc !== (entry.crc32 >>> 0)) {
    throw new Error(`Archive integrity check failed for ${entry.fileName}.`);
  }
}

export async function extractValidatedZip(zipPath: string, stageRoot: string): Promise<void> {
  const zip = await openZip(zipPath);
  const seen = new Set<string>();
  let entryCount = 0;
  let uncompressedBytes = 0;

  await new Promise<void>((resolve, reject) => {
    let failed = false;
    const fail = (error: unknown) => {
      if (failed) return;
      failed = true;
      zip.close();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    zip.once("error", fail);
    zip.once("end", () => {
      if (!failed) resolve();
    });
    zip.on("entry", (entry: Entry) => {
      void (async () => {
        entryCount += 1;
        if (entryCount > MAX_ARCHIVE_ENTRIES) throw new Error("The artifact archive contains too many entries.");
        if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0 || entry.uncompressedSize > MAX_ARCHIVE_ENTRY_BYTES) {
          throw new Error(`The artifact archive entry ${entry.fileName} is too large.`);
        }
        uncompressedBytes += entry.uncompressedSize;
        if (uncompressedBytes > MAX_ARCHIVE_UNCOMPRESSED_BYTES) throw new Error("The extracted artifact would be too large.");
        if (isLinkEntry(entry)) throw new Error(`The artifact archive contains a link or reparse point: ${entry.fileName}`);

        const relative = archivePath(entry.fileName);
        const collisionKey = process.platform === "win32" ? relative.toLowerCase() : relative;
        if (seen.has(collisionKey)) throw new Error(`The artifact archive contains a duplicate path: ${entry.fileName}`);
        seen.add(collisionKey);
        const output = path.resolve(stageRoot, relative);
        const relativeToStage = path.relative(stageRoot, output);
        if (relativeToStage.startsWith(`..${path.sep}`) || relativeToStage === ".." || path.isAbsolute(relativeToStage)) {
          throw new Error(`The artifact archive path escapes its staging directory: ${entry.fileName}`);
        }

        const isDirectory = entry.fileName.endsWith("/");
        if (isDirectory) {
          await fs.promises.mkdir(output, { recursive: true });
        } else {
          await fs.promises.mkdir(path.dirname(output), { recursive: true });
          await extractFile(zip, entry, output);
        }
        zip.readEntry();
      })().catch(fail);
    });
    zip.readEntry();
  });
}

function validateStagedArtifact(stageRoot: string, target: ArtifactTarget): void {
  const executable = path.join(stageRoot, target.executableName);
  assertOrdinaryFile(executable, "The staged Cfx.re server executable");
  const systemResources =
    target.flavor === "legacy"
      ? path.join(stageRoot, "citizen", "system_resources")
      : path.join(stageRoot, "system_resources");
  const stat = fs.lstatSync(systemResources);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("The staged artifact is missing its system resources.");
}

function writeJsonDurably(targetPath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const temporary = `${targetPath}.tmp-${randomUUID()}`;
  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(descriptor, JSON.stringify(value, null, 2), "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fs.renameSync(temporary, targetPath);
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
    try {
      fs.rmSync(temporary, { force: true });
    } catch {
      // A future recovery can ignore an orphaned temporary metadata file.
    }
  }
}

function writeInstallRecord(statePath: string, record: ArtifactInstallRecord): void {
  writeJsonDurably(statePath, record);
}

function safeGeneratedSibling(root: string, marker: string): string {
  const parent = path.dirname(root);
  const generated = path.join(parent, `${path.basename(root)}.${marker}-${randomUUID()}`);
  if (path.dirname(generated) !== parent || generated === root) throw new Error("Could not create a safe artifact staging path.");
  return generated;
}

function transactionPath(statePath: string): string {
  return `${statePath}.transaction.json`;
}

function assertGeneratedSibling(candidate: string, root: string, marker: string, suffix = ""): void {
  const resolved = path.resolve(candidate);
  const parent = path.dirname(path.resolve(root));
  if (normalizedPath(path.dirname(resolved)) !== normalizedPath(parent)) {
    throw new Error("The artifact recovery journal contains a path outside the artifact parent folder.");
  }
  const escapedRoot = path.basename(root).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedSuffix = suffix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const expected = new RegExp(`^${escapedRoot}\\.${marker}-[0-9a-f-]{36}${escapedSuffix}$`, "i");
  if (!expected.test(path.basename(resolved))) {
    throw new Error("The artifact recovery journal contains an unexpected generated path.");
  }
}

function readTransactionJournal(exePath: string, statePath: string): ArtifactTransactionJournal | null {
  const journalPath = transactionPath(statePath);
  if (!fs.existsSync(journalPath)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(journalPath, "utf8"));
  } catch {
    throw new Error(`An artifact update recovery journal is unreadable: ${journalPath}`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`An artifact update recovery journal is invalid: ${journalPath}`);
  }
  const journal = raw as Partial<ArtifactTransactionJournal>;
  const configured = path.resolve(exePath);
  const lowerName = path.basename(configured).toLowerCase();
  const executableName: ArtifactTarget["executableName"] | null =
    lowerName === "fxserver.exe" ? "FXServer.exe" : lowerName === "cfx-server.exe" ? "cfx-server.exe" : null;
  const record = journal.record;
  if (
    journal.schemaVersion !== 1 ||
    (journal.phase !== "prepared" && journal.phase !== "backup-created") ||
    !executableName ||
    typeof journal.executablePath !== "string" ||
    normalizedPath(journal.executablePath) !== normalizedPath(configured) ||
    typeof journal.artifactRoot !== "string" ||
    normalizedPath(journal.artifactRoot) !== normalizedPath(path.dirname(configured)) ||
    typeof journal.archivePath !== "string" ||
    typeof journal.stagePath !== "string" ||
    typeof journal.backupPath !== "string" ||
    typeof record !== "object" ||
    record === null ||
    record.schemaVersion !== 1 ||
    record.executableName !== executableName ||
    normalizedPath(String(record.artifactRoot ?? "")) !== normalizedPath(journal.artifactRoot) ||
    record.backupPath !== journal.backupPath ||
    !Number.isSafeInteger(record.build) ||
    record.build < 1
  ) {
    throw new Error(`An artifact update recovery journal failed validation: ${journalPath}`);
  }
  assertGeneratedSibling(journal.archivePath, journal.artifactRoot, "ghz-download", ".zip");
  assertGeneratedSibling(journal.stagePath, journal.artifactRoot, "ghz-stage");
  assertGeneratedSibling(journal.backupPath, journal.artifactRoot, "ghz-backup");
  return journal as ArtifactTransactionJournal;
}

function cleanupJournalPath(targetPath: string, recursive: boolean): void {
  try {
    fs.rmSync(targetPath, { recursive, force: true });
  } catch {
    // Antivirus may briefly hold a generated archive/stage; never broaden cleanup beyond the journaled path.
  }
}

/** Repair the only crash-sensitive directory-swap states before launch/check/update. */
export function recoverInterruptedArtifactUpdate(exePath: string, statePath: string): string | null {
  const journal = readTransactionJournal(exePath, statePath);
  if (!journal) return null;
  const journalPath = transactionPath(statePath);
  const rootValid = hasCompleteArtifactLayout(journal.artifactRoot, journal.record.executableName);
  const backupValid = hasCompleteArtifactLayout(journal.backupPath, journal.record.executableName);
  const stageExists = fs.existsSync(journal.stagePath);

  if (journal.phase === "prepared" && rootValid && !backupValid) {
    cleanupJournalPath(journal.stagePath, true);
    cleanupJournalPath(journal.archivePath, false);
    fs.rmSync(journalPath, { force: true });
    return "Recovered an interrupted artifact update before replacement; the previous server artifacts were unchanged.";
  }

  if (journal.phase === "backup-created" && rootValid && backupValid && !stageExists) {
    writeInstallRecord(statePath, journal.record);
    cleanupJournalPath(journal.archivePath, false);
    fs.rmSync(journalPath, { force: true });
    return `Recovered completed Cfx.re build ${journal.record.build}; the previous artifacts remain at ${journal.backupPath}.`;
  }

  if (!rootValid && backupValid) {
    let preservedPartial: string | null = null;
    if (fs.existsSync(journal.artifactRoot)) {
      preservedPartial = safeGeneratedSibling(journal.artifactRoot, "ghz-failed-recovery");
      fs.renameSync(journal.artifactRoot, preservedPartial);
    }
    fs.renameSync(journal.backupPath, journal.artifactRoot);
    cleanupJournalPath(journal.stagePath, true);
    cleanupJournalPath(journal.archivePath, false);
    fs.rmSync(journalPath, { force: true });
    return (
      "Recovered the previous server artifacts after an interrupted update." +
      (preservedPartial ? ` The incomplete replacement was preserved at ${preservedPartial}.` : "")
    );
  }

  throw new Error(
    `Workbench found an inconsistent interrupted artifact update. Nothing was deleted. Inspect ${journalPath}, ${journal.artifactRoot}, and ${journal.backupPath}.`,
  );
}

export async function installArtifactUpdate(
  exePath: string,
  txDataPath: string | null,
  track: ArtifactTrack,
  statePath: string,
  onProgress?: (progress: ArtifactProgress) => void,
): Promise<ArtifactUpdateResult> {
  recoverInterruptedArtifactUpdate(exePath, statePath);
  const target = resolveArtifactTarget(exePath, txDataPath);
  const beforeDownload = await findRunningServerPids(target.executablePath);
  if (beforeDownload.length > 0) throw new Error("Stop this local server in txAdmin before updating its artifacts.");

  onProgress?.({ phase: "checking", transferredBytes: 0, totalBytes: null });
  const status = await checkArtifactUpdate(exePath, txDataPath, track, statePath);
  if (status.installedBuild === status.build) throw new Error(`Cfx.re build ${status.build} is already installed.`);
  const archivePath = safeGeneratedSibling(target.root, "ghz-download") + ".zip";
  const stagePath = safeGeneratedSibling(target.root, "ghz-stage");
  const backupPath = safeGeneratedSibling(target.root, "ghz-backup");
  let stageExists = false;
  let sha256 = "";

  try {
    sha256 = await downloadArchive(status, archivePath, onProgress);
    onProgress?.({ phase: "extracting", transferredBytes: status.archiveSize ?? 0, totalBytes: status.archiveSize });
    fs.mkdirSync(stagePath, { recursive: false });
    stageExists = true;
    await extractValidatedZip(archivePath, stagePath);
    onProgress?.({ phase: "validating", transferredBytes: status.archiveSize ?? 0, totalBytes: status.archiveSize });
    validateStagedArtifact(stagePath, target);

    const beforeSwap = await findRunningServerPids(target.executablePath);
    if (beforeSwap.length > 0) throw new Error("The local server started during the update. Stop it in txAdmin and retry.");

    const installedAt = new Date().toISOString();
    const record: ArtifactInstallRecord = {
      schemaVersion: 1,
      artifactRoot: target.root,
      executableName: target.executableName,
      flavor: target.flavor,
      build: status.build,
      track: status.track,
      downloadUrl: status.downloadUrl,
      sha256,
      installedAt,
      backupPath,
    };
    const journal: ArtifactTransactionJournal = {
      schemaVersion: 1,
      phase: "prepared",
      executablePath: target.executablePath,
      artifactRoot: target.root,
      archivePath,
      stagePath,
      backupPath,
      record,
    };
    const journalPath = transactionPath(statePath);
    writeJsonDurably(journalPath, journal);
    onProgress?.({ phase: "installing", transferredBytes: status.archiveSize ?? 0, totalBytes: status.archiveSize });

    const finalCheck = await findRunningServerPids(target.executablePath);
    if (finalCheck.length > 0) {
      fs.rmSync(journalPath, { force: true });
      throw new Error("The local server started during the update. Stop it in txAdmin and retry.");
    }

    try {
      fs.renameSync(target.root, backupPath);
    } catch (backupError) {
      fs.rmSync(journalPath, { force: true });
      throw new Error(`Could not create the rollback backup; the current artifacts were not changed. ${(backupError as Error).message}`);
    }

    journal.phase = "backup-created";
    try {
      writeJsonDurably(journalPath, journal);
    } catch (journalError) {
      try {
        fs.renameSync(backupPath, target.root);
      } catch (rollbackError) {
        throw new Error(
          `The rollback backup was created, but its recovery journal could not be updated and automatic restoration failed. ` +
            `Your intact previous artifact is at ${backupPath}. Journal error: ${(journalError as Error).message}. ` +
            `Restoration error: ${(rollbackError as Error).message}`,
        );
      }
      fs.rmSync(journalPath, { force: true });
      throw new Error(`The update was cancelled and the previous artifacts were restored because recovery metadata could not be saved.`);
    }

    try {
      fs.renameSync(stagePath, target.root);
      stageExists = false;
    } catch (swapError) {
      try {
        fs.renameSync(backupPath, target.root);
        fs.rmSync(journalPath, { force: true });
      } catch (rollbackError) {
        throw new Error(
          `Artifact replacement failed and automatic rollback also failed. Your intact previous artifact is at ${backupPath}. ` +
            `Replacement error: ${(swapError as Error).message}. Rollback error: ${(rollbackError as Error).message}`,
        );
      }
      throw new Error(`Artifact replacement failed; the previous artifact was restored. ${(swapError as Error).message}`);
    }

    let warning: string | undefined;
    try {
      writeInstallRecord(statePath, record);
      fs.rmSync(journalPath, { force: true });
    } catch (error) {
      warning =
        `The artifact was installed, but Workbench could not finish its local build record: ${(error as Error).message}. ` +
        "The durable recovery journal will finish that bookkeeping on the next launch or update check.";
    }
    const result = { ...status, installedBuild: status.build, updateAvailable: false, sha256, backupPath, installedAt, warning };
    onProgress?.({ phase: "complete", transferredBytes: status.archiveSize ?? 0, totalBytes: status.archiveSize });
    return result;
  } finally {
    try {
      fs.rmSync(archivePath, { force: true });
    } catch {
      // The temporary archive can be removed manually if antivirus still holds it.
    }
    if (stageExists) {
      try {
        fs.rmSync(stagePath, { recursive: true, force: true });
      } catch {
        // A failed staging directory is intentionally outside both txData and the artifact root.
      }
    }
  }
}
