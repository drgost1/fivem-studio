/**
 * Optional remote host support.
 *
 * This module is only reached when `StudioConfig.remote` is set. With no remote
 * host configured, `managedRuntime.ts` behaves exactly as before.
 *
 * The loopback policy is not relaxed. It is satisfied honestly on both ends:
 *
 *   - the runtime binds 127.0.0.1 on the remote host,
 *   - RCON stays 127.0.0.1 there, so the Quake3-style UDP packets that carry
 *     `rcon_password` in plaintext never leave that machine,
 *   - the desktop app connects to 127.0.0.1 on a forwarded port here,
 *   - SSH provides encryption, authentication, and host-key verification
 *     between the two.
 *
 * `networkPolicy.ts` and the runtime itself are unchanged.
 *
 * Secret handling: the launch script is delivered over SSH stdin (`sh -s`), so
 * no value appears in `argv` (visible via `ps` to other users on the host) or
 * on disk. `rcon_password` is read out of server.cfg *by the remote script*, so
 * it is never transmitted to the client at all.
 */

import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import { spawn, type ChildProcess } from "node:child_process";

import type { RemoteHostSettings } from "./configStore";
import type { ManagedRuntimeConnection } from "./managedRuntime";

/** Matches the line the runtime always writes to stderr on listen. */
const READY_PATTERN = /listening on http:\/\/(?:127\.0\.0\.1|\[::1\]):(\d{1,5})\//;

const READY_TIMEOUT_MS = 20_000;
const FORWARD_TIMEOUT_MS = 15_000;
const MAX_STDERR_BYTES = 8192;
const SSH_COMMAND_TIMEOUT_MS = 30_000;
const SSH_UPLOAD_TIMEOUT_MS = 120_000;

const SSH_BASE_OPTIONS = [
  // Never block the UI on an interactive password or host-key prompt.
  "-o", "BatchMode=yes",
  "-o", "ConnectTimeout=15",
  "-o", "ServerAliveInterval=30",
  "-o", "ServerAliveCountMax=3",
];

let runtimeChild: ChildProcess | null = null;
let forwardChild: ChildProcess | null = null;
let connection: ManagedRuntimeConnection | null = null;
let activeKey: string | null = null;
let starting: Promise<ManagedRuntimeConnection> | null = null;

/** POSIX single-quote quoting for values interpolated into the remote script. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function remoteKey(settings: RemoteHostSettings): string {
  return [
    settings.sshTarget,
    settings.workspacePath,
    settings.serverConfigPath,
    settings.txAdminDataDir ?? "",
    settings.txAdminControlProfile ?? "",
    String(settings.rconPort),
    settings.runtimePath,
  ].join("\0");
}

/**
 * Builds the script piped to `ssh <target> sh -s`.
 *
 * `rcon_password` is extracted here, on the host, from the same server.cfg the
 * runtime is told to use. It never crosses the network.
 */
export function buildLaunchScript(settings: RemoteHostSettings, token: string): string {
  const cfg = shellQuote(settings.serverConfigPath);
  return [
    "set -e",
    `CFG=${cfg}`,
    `if [ ! -r "$CFG" ]; then echo "qb-studio: cannot read $CFG on the remote host" >&2; exit 66; fi`,
    // Take the first `set rcon_password <value>` and strip optional quoting.
    `RCON_PASSWORD=$(sed -n 's/^[[:space:]]*set[[:space:]]\\{1,\\}rcon_password[[:space:]]\\{1,\\}//p' "$CFG" | head -n 1 | sed 's/^"//; s/"$//; s/^'"'"'//; s/'"'"'$//')`,
    `if [ -z "$RCON_PASSWORD" ]; then echo "qb-studio: no 'set rcon_password' found in $CFG" >&2; exit 67; fi`,
    "export RCON_PASSWORD",
    "export MCP_TRANSPORT=http",
    "export MCP_HOST=127.0.0.1",
    // 0 lets the host pick a free port; we read it back off stderr.
    "export MCP_PORT=0",
    `export MCP_TOKEN=${shellQuote(token)}`,
    "export RCON_HOST=127.0.0.1",
    `export RCON_PORT=${shellQuote(String(settings.rconPort))}`,
    `export SERVER_DATA_WORKSPACE=${shellQuote(settings.workspacePath)}`,
    `export SERVER_CONFIG_PATH=${shellQuote(settings.serverConfigPath)}`,
    `export TXADMIN_DATA_DIR=${shellQuote(settings.txAdminDataDir ?? "")}`,
    `export TXADMIN_CONTROL_PROFILE=${shellQuote(settings.txAdminControlProfile ?? "")}`,
    `exec ${shellQuote(settings.nodePath)} ${shellQuote(settings.runtimePath)}`,
  ].join("\n");
}

function runSsh(
  sshTarget: string,
  remoteCommand: string[],
  input?: string | Buffer,
  timeoutMs = SSH_COMMAND_TIMEOUT_MS,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("ssh", [...SSH_BASE_OPTIONS, sshTarget, ...remoteCommand], {
      windowsHide: true,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = `${stdout}${chunk.toString("utf8")}`.slice(-MAX_STDERR_BYTES);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-MAX_STDERR_BYTES);
    });
    let settled = false;
    const finish = (value: { code: number; stdout: string; stderr: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    // Without this a stalled ssh — an unreachable host, or a redirection that
    // died while a large payload was still being written — never settles, and
    // the caller waits forever with nothing to report.
    const timer = setTimeout(() => {
      if (!child.killed) child.kill();
      finish({ code: -1, stdout, stderr: `${stderr}\nTimed out after ${Math.round(timeoutMs / 1000)}s.` });
    }, timeoutMs);
    timer.unref();

    child.on("error", (error) => finish({ code: -1, stdout, stderr: `${stderr}${error.message}` }));
    child.on("close", (code) => finish({ code: code ?? -1, stdout, stderr }));
    // The remote side can close stdin early (a failed redirection); that surfaces
    // as EPIPE here and must not become an unhandled error event.
    child.stdin?.on("error", () => undefined);
    if (input !== undefined) child.stdin?.end(input);
    else child.stdin?.end();
  });
}

/** Uploads the bundled runtime when the host copy is absent or differs. */
async function ensureRuntimeDeployed(settings: RemoteHostSettings, localRuntimePath: string): Promise<void> {
  if (!fs.existsSync(localRuntimePath)) {
    throw new Error("The bundled coding runtime is missing. Reinstall QB Studio or run the runtime bundle build.");
  }
  const payload = fs.readFileSync(localRuntimePath);
  const localDigest = createHash("sha256").update(payload).digest("hex");

  const probe = await runSsh(settings.sshTarget, ["sh", "-s"], `sha256sum ${shellQuote(settings.runtimePath)} 2>/dev/null | cut -d' ' -f1`);
  if (probe.code === 0 && probe.stdout.trim() === localDigest) return;

  // The script must arrive as argv, not stdin: `cat` consumes all of stdin, so
  // a script piped ahead of the payload would swallow its own remaining lines.
  const target = shellQuote(settings.runtimePath);
  const upload = await runSsh(
    settings.sshTarget,
    // mkdir -p first: the destination folder is user-supplied and may not exist
    // yet, and cat would otherwise fail with a bare redirection error.
    ["sh", "-c", `umask 077; mkdir -p "$(dirname ${target})" && cat > ${target}.part && mv ${target}.part ${target}`],
    payload,
    SSH_UPLOAD_TIMEOUT_MS,
  );
  if (upload.code !== 0) {
    throw new Error(`Could not deploy the coding runtime to ${settings.sshTarget}: ${upload.stderr.trim() || `ssh exited ${upload.code}`}`);
  }
}

/**
 * Confirms server.cfg sits directly inside the chosen workspace before the
 * runtime is launched.
 *
 * Getting this wrong is the easy mistake: txAdmin's data root holds the
 * server-data folder rather than server.cfg itself, so pointing at the root
 * fails. Rather than report only that the file is unreadable, this looks one
 * level down and names the folder that should have been chosen.
 */
async function assertWorkspaceHasServerConfig(settings: RemoteHostSettings): Promise<void> {
  const workspace = shellQuote(settings.workspacePath);
  const script = [
    `if [ -r ${workspace}/server.cfg ]; then echo __QB_OK__; exit 0; fi`,
    `if [ ! -d ${workspace} ]; then echo __QB_NO_DIR__; exit 0; fi`,
    `find ${workspace} -maxdepth 2 -name server.cfg 2>/dev/null | head -n 5`,
    "exit 0",
  ].join("\n");

  const result = await runSsh(settings.sshTarget, ["sh", "-s"], script);
  const output = result.stdout.trim();
  if (output === "__QB_OK__") return;

  if (output === "__QB_NO_DIR__") {
    throw new Error(`${settings.workspacePath} does not exist on ${settings.sshTarget}.`);
  }

  const folders = output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("/") && line.endsWith("/server.cfg"))
    .map((line) => line.slice(0, -"/server.cfg".length));

  if (folders.length > 0) {
    throw new Error(
      `No server.cfg directly inside ${settings.workspacePath}. It is in ${folders.join(" and ")} — set the workspace to that folder instead.`,
    );
  }
  throw new Error(`No server.cfg found in or below ${settings.workspacePath} on ${settings.sshTarget}.`);
}

async function pickFreeLocalPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = address && typeof address === "object" ? address.port : 0;
      probe.close(() => (port > 0 ? resolve(port) : reject(new Error("Could not reserve a local port for the SSH tunnel."))));
    });
  });
}

function connectOnce(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const done = (ok: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.setTimeout(1000, () => done(false));
  });
}

async function waitForLocalPort(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await connectOnce(port)) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("The SSH tunnel did not become reachable in time.");
}

/** Phase A: start the runtime on the host and read back the port it chose. */
function startRemoteRuntimeProcess(settings: RemoteHostSettings, token: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn("ssh", [...SSH_BASE_OPTIONS, settings.sshTarget, "sh", "-s"], {
      windowsHide: true,
      shell: false,
      stdio: ["pipe", "ignore", "pipe"],
    });
    runtimeChild = child;

    let stderr = "";
    let settled = false;
    const finish = (error: Error | null, port?: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        if (runtimeChild === child) runtimeChild = null;
        if (!child.killed) child.kill();
        reject(error);
      } else resolve(port as number);
    };

    const timer = setTimeout(
      () => finish(new Error(`The coding runtime on ${settings.sshTarget} did not report a listening port within 20 seconds.${stderr ? ` ${stderr.trim()}` : ""}`)),
      READY_TIMEOUT_MS,
    );
    timer.unref();

    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-MAX_STDERR_BYTES);
      const match = READY_PATTERN.exec(stderr);
      if (!match) return;
      const port = Number(match[1]);
      if (Number.isInteger(port) && port > 0 && port <= 65535) finish(null, port);
    });
    child.on("error", (error) => finish(new Error(`Could not reach ${settings.sshTarget} over SSH: ${error.message}`)));
    child.on("exit", (code) => {
      if (!settled) finish(new Error(`The remote coding runtime exited with code ${code ?? "unknown"}.${stderr ? ` ${stderr.trim()}` : ""}`));
      else if (runtimeChild === child) {
        runtimeChild = null;
        connection = null;
        activeKey = null;
      }
    });

    child.stdin?.end(buildLaunchScript(settings, token));
  });
}

/** Phase B: forward a local port to the port the runtime chose on the host. */
function startForward(settings: RemoteHostSettings, localPort: number, remotePort: number): ChildProcess {
  const child = spawn(
    "ssh",
    [
      ...SSH_BASE_OPTIONS,
      "-o", "ExitOnForwardFailure=yes",
      "-N",
      "-L", `${localPort}:127.0.0.1:${remotePort}`,
      settings.sshTarget,
    ],
    { windowsHide: true, shell: false, stdio: ["ignore", "ignore", "pipe"] },
  );
  forwardChild = child;
  child.on("exit", () => {
    if (forwardChild === child) {
      forwardChild = null;
      connection = null;
      activeKey = null;
    }
  });
  return child;
}

export async function ensureRemoteRuntime(
  settings: RemoteHostSettings,
  localRuntimePath: string,
): Promise<ManagedRuntimeConnection> {
  const key = remoteKey(settings);
  if (connection && runtimeChild && !runtimeChild.killed && activeKey === key) return connection;
  if (starting && activeKey === key) return starting;
  stopRemoteRuntime();
  activeKey = key;

  const token = randomBytes(32).toString("base64url");
  const startup = (async () => {
    // Cheapest check first: a wrong workspace is the common misconfiguration,
    // and there is no reason to upload 1.4MB before discovering it.
    await assertWorkspaceHasServerConfig(settings);
    await ensureRuntimeDeployed(settings, localRuntimePath);
    const remotePort = await startRemoteRuntimeProcess(settings, token);
    const localPort = await pickFreeLocalPort();
    startForward(settings, localPort, remotePort);
    await waitForLocalPort(localPort, FORWARD_TIMEOUT_MS);
    connection = {
      url: `http://127.0.0.1:${localPort}/mcp`,
      token,
      serverIdentity: {
        workspacePath: settings.workspacePath,
        serverConfigPath: settings.serverConfigPath,
        rcon: { host: "127.0.0.1", port: settings.rconPort },
      },
    };
    return connection;
  })();

  const tracked = startup.catch((error) => {
    stopRemoteRuntime();
    throw error;
  }).finally(() => {
    if (starting === tracked) starting = null;
  });
  starting = tracked;
  return tracked;
}

export function stopRemoteRuntime(): void {
  const stoppingRuntime = runtimeChild;
  const stoppingForward = forwardChild;
  runtimeChild = null;
  forwardChild = null;
  connection = null;
  activeKey = null;
  if (stoppingForward && !stoppingForward.killed) stoppingForward.kill();
  if (stoppingRuntime && !stoppingRuntime.killed) stoppingRuntime.kill();
}

export interface RemoteDirectoryEntry {
  name: string;
  /** Directory already holds a server.cfg, so it is a candidate workspace. */
  hasServerConfig: boolean;
}

export interface RemoteDirectoryListing {
  /** Absolute path the host resolved, so the caller never guesses at ~ or symlinks. */
  path: string;
  entries: RemoteDirectoryEntry[];
}

const MAX_REMOTE_ENTRIES = 500;

/**
 * Lists sub-directories of a path on the host so a workspace can be picked
 * rather than typed. Only directories are returned — the caller is choosing a
 * folder — and each is flagged when it already contains a server.cfg.
 *
 * With no path, listing starts at the login user's home directory.
 */
export async function listRemoteDirectory(
  sshTarget: string,
  requestedPath: string | null,
): Promise<RemoteDirectoryListing> {
  // `set -e` is deliberately absent: the entry loop uses tests whose failure is
  // normal control flow, and a shell that exits on the first false test would
  // truncate the listing.
  const enter = requestedPath
    ? `cd -- ${shellQuote(requestedPath)} 2>/dev/null || { echo __QB_DENIED__ >&2; exit 66; }`
    : 'cd "$HOME" || exit 66';

  const script = [
    enter,
    "pwd",
    "count=0",
    "for entry in * .*; do",
    '  if [ "$entry" = "." ] || [ "$entry" = ".." ]; then continue; fi',
    '  if [ ! -d "$entry" ]; then continue; fi',
    `  count=$((count + 1))`,
    `  if [ "$count" -gt ${MAX_REMOTE_ENTRIES} ]; then break; fi`,
    '  if [ -f "$entry/server.cfg" ]; then',
    '    printf "D\t%s\n" "$entry"',
    "  else",
    '    printf "d\t%s\n" "$entry"',
    "  fi",
    "done",
    "exit 0",
  ].join("\n");

  const result = await runSsh(sshTarget, ["sh", "-s"], script);
  if (result.code !== 0) {
    throw new Error(
      result.stderr.includes("__QB_DENIED__")
        ? "That folder does not exist on the host, or the SSH user cannot read it."
        : `Could not list folders on ${sshTarget}: ${result.stderr.trim() || `ssh exited ${result.code}`}`,
    );
  }

  const lines = result.stdout.split("\n").filter((line) => line.length > 0);
  const path = (lines.shift() ?? "").trim();
  if (!path.startsWith("/")) {
    throw new Error(`Unexpected reply while listing folders on ${sshTarget}.`);
  }

  const entries: RemoteDirectoryEntry[] = [];
  for (const line of lines) {
    const separator = line.indexOf("\t");
    if (separator < 0) continue;
    const name = line.slice(separator + 1).trim();
    if (name) entries.push({ name, hasServerConfig: line.startsWith("D") });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  return { path, entries };
}

/**
 * Finds a usable Node on the host so the path does not have to be guessed.
 * Checks PATH first, then the conventional install locations, and returns the
 * first candidate that actually runs.
 */
export async function detectRemoteNode(sshTarget: string): Promise<{ path: string; version: string } | null> {
  // One candidate per loop iteration; no shell line-continuations, which do not
  // survive being embedded in a TypeScript string array.
  const script = [
    'found=$(command -v node 2>/dev/null)',
    'if [ -n "$found" ] && [ -x "$found" ]; then',
    '  version=$("$found" --version 2>/dev/null)',
    '  if [ -n "$version" ]; then printf "%s\t%s\n" "$found" "$version"; exit 0; fi',
    "fi",
    'for candidate in "$HOME/.qb-studio/node/bin/node" /usr/local/bin/node /usr/bin/node /opt/node/bin/node "$HOME/.nvm/versions/node"/*/bin/node; do',
    '  [ -x "$candidate" ] || continue',
    '  version=$("$candidate" --version 2>/dev/null) || continue',
    '  [ -n "$version" ] || continue',
    '  printf "%s\t%s\n" "$candidate" "$version"',
    "  exit 0",
    "done",
    "exit 1",
  ].join("\n");

  const result = await runSsh(sshTarget, ["sh", "-s"], script);
  if (result.code !== 0) return null;
  const [nodePath, version] = result.stdout.trim().split("\t");
  return nodePath && version ? { path: nodePath, version } : null;
}
