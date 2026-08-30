// Creates a local *server-data workspace* below txData. This intentionally
// does not create txAdmin's control profile/config.json: txAdmin owns that
// schema and attaches a control profile to a data path through its own UI.

import fs from "node:fs";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import type { CfxTarget } from "./configStore";
import { createTextFile, readTextFileSnapshot, writeTextFile, type FileSnapshot } from "./fsTree";
import { resolveInsideRoot } from "./pathSafety";

const MAX_WORKSPACE_NAME_LENGTH = 64;
const WINDOWS_RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9]|clock\$)(?:\.|$)/i;

export interface LocalWorkspace {
  name: string;
  profileRoot: string;
  resourcesPath: string;
  serverCfgPath: string;
}

export interface DevelopmentRconPreviewChange {
  path: "server.cfg" | "secrets.cfg" | ".gitignore";
  action: "create" | "update" | "unchanged";
  description: "load-secret-file" | "write-redacted-password" | "ignore-secret-file";
}

export interface DevelopmentRconPreview {
  hasExistingPassword: boolean;
  changes: DevelopmentRconPreviewChange[];
}

export interface DevelopmentRconResult {
  changedPaths: string[];
  replacedExistingPassword: boolean;
}

/** Normalize a user label into the conventional txData server-data `.base` folder name. */
export function normalizeWorkspaceName(value: string): string {
  if (typeof value !== "string") throw new Error("Workspace name must be text.");
  const trimmed = value.trim();
  const baseName = trimmed.toLowerCase().endsWith(".base") ? trimmed.slice(0, -".base".length) : trimmed;
  if (
    !baseName ||
    baseName.length > MAX_WORKSPACE_NAME_LENGTH - ".base".length ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(baseName) ||
    WINDOWS_RESERVED_NAMES.test(baseName)
  ) {
    throw new Error(
      "Workspace name must use ASCII letters, numbers, ., _, or -; start with a letter or number; and not be a Windows reserved name.",
    );
  }
  return `${baseName}.base`;
}

export function assertLocalPort(value: number): number {
  if (!Number.isInteger(value) || value < 1024 || value > 65535) {
    throw new Error("Local server port must be a whole number between 1024 and 65535.");
  }
  return value;
}

export function starterServerCfg(port: number, workspaceName: string, target: CfxTarget = "legacy"): string {
  const gameSelection = target === "redm"
    ? "# RedM requires the RDR3 game runtime.\nset gamename rdr3\n\n"
    : "";
  return `# QB Studio local server-data workspace: ${workspaceName}\n` +
    "# txAdmin owns its control profile/config.json. Attach this folder through txAdmin's normal deployment flow.\n" +
    "# This template deliberately contains no license key, RCON password, or other secrets.\n\n" +
    gameSelection +
    `endpoint_add_tcp "127.0.0.1:${port}"\n` +
    `endpoint_add_udp "127.0.0.1:${port}"\n` +
    "sv_master1 \"\"\n\n" +
    `sv_hostname "QB Studio Local - ${workspaceName}"\n` +
    "sv_maxclients 8\n" +
    `sets sv_projectName "${workspaceName}"\n\n` +
    "# Copy secrets.cfg.example to secrets.cfg, add your own values, then uncomment this line.\n" +
    "# exec secrets.cfg\n\n" +
    "# Your QB Studio resources belong in resources/[local]/.\n" +
    "ensure [local]\n";
}

const GITIGNORE = `# FXServer / txAdmin runtime output\ncache/\ncrashes/\nlogs/\nlocal-database/\ndata/\n.console-history\n.id\nserver.cfg.bkp\n\n# Local credentials\nsecrets.cfg\n`;
const SECRETS_EXAMPLE = `# Copy this file to secrets.cfg. Do not commit secrets.cfg.\n# sv_licenseKey "paste-your-own-key-here"\n# set rcon_password "choose-a-local-development-password"\n`;

function writeDurableText(filePath: string, content: string): void {
  const fd = fs.openSync(filePath, "wx", 0o600);
  try {
    fs.writeFileSync(fd, content, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** Unlike existsSync, this treats a dangling symbolic link/reparse point as an
 * existing directory entry. A workspace creator must never overwrite either. */
function directoryEntryExists(target: string): boolean {
  try {
    fs.lstatSync(target);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

const ACTIVE_RCON = /^\s*(?:set\s+)?rcon_password\s+.+$/i;
const ACTIVE_SECRETS_EXEC = /^\s*exec\s+["']?secrets\.cfg["']?\s*(?:#.*)?$/i;
const COMMENTED_SECRETS_EXEC = /^\s*#\s*exec\s+["']?secrets\.cfg["']?\s*$/i;

function readOptionalSnapshot(filePath: string): FileSnapshot | null {
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${path.basename(filePath)} must be a regular file.`);
    return readTextFileSnapshot(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function appendLine(content: string, line: string): string {
  const trimmed = content.replace(/[\r\n]+$/, "");
  return `${trimmed}${trimmed ? "\n" : ""}${line}\n`;
}

function rconWorkspaceFiles(profileRoot: string): {
  serverPath: string;
  secretsPath: string;
  gitignorePath: string;
  server: FileSnapshot;
  secrets: FileSnapshot | null;
  gitignore: FileSnapshot | null;
} {
  const rootStat = fs.lstatSync(profileRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("Workspace must be a real directory.");
  const serverPath = resolveInsideRoot(profileRoot, "server.cfg");
  const secretsPath = resolveInsideRoot(profileRoot, "secrets.cfg");
  const gitignorePath = resolveInsideRoot(profileRoot, ".gitignore");
  const server = readTextFileSnapshot(serverPath);
  return {
    serverPath,
    secretsPath,
    gitignorePath,
    server,
    secrets: readOptionalSnapshot(secretsPath),
    gitignore: readOptionalSnapshot(gitignorePath),
  };
}

export function previewDevelopmentRcon(profileRoot: string, hasExistingPassword: boolean): DevelopmentRconPreview {
  const files = rconWorkspaceFiles(profileRoot);
  const serverHasExec = files.server.content.split(/\r?\n/).some((line) => ACTIVE_SECRETS_EXEC.test(line));
  const gitignoreHasSecrets = files.gitignore?.content.split(/\r?\n/).some((line) => line.trim().toLowerCase() === "secrets.cfg") ?? false;
  return {
    hasExistingPassword,
    changes: [
      {
        path: ".gitignore",
        action: files.gitignore ? (gitignoreHasSecrets ? "unchanged" : "update") : "create",
        description: "ignore-secret-file",
      },
      {
        path: "secrets.cfg",
        action: files.secrets ? "update" : "create",
        description: "write-redacted-password",
      },
      {
        path: "server.cfg",
        action: serverHasExec && !files.server.content.split(/\r?\n/).some((line) => ACTIVE_RCON.test(line)) ? "unchanged" : "update",
        description: "load-secret-file",
      },
    ],
  };
}

/** Generate and apply the credential entirely in the main process. Neither the
 * actual password nor password-bearing file content is returned or captured in
 * programmatic undo history. */
export function applyDevelopmentRcon(
  profileRoot: string,
  hasExistingPassword: boolean,
  allowOverwrite: boolean,
): DevelopmentRconResult {
  if (hasExistingPassword && !allowOverwrite) {
    throw new Error("This workspace already has an RCON password. Explicit replacement confirmation is required.");
  }
  const files = rconWorkspaceFiles(profileRoot);
  const password = randomBytes(32).toString("base64url");
  const rconLine = `set rcon_password "${password}"`;

  let gitignoreContent = files.gitignore?.content ?? "";
  if (!gitignoreContent.split(/\r?\n/).some((line) => line.trim().toLowerCase() === "secrets.cfg")) {
    gitignoreContent = appendLine(gitignoreContent, "secrets.cfg");
  }

  const secretLines = (files.secrets?.content ?? "").split(/\r?\n/);
  const nextSecretLines: string[] = [];
  let insertedRcon = false;
  for (const line of secretLines) {
    if (!ACTIVE_RCON.test(line)) {
      nextSecretLines.push(line);
      continue;
    }
    if (!insertedRcon) nextSecretLines.push(rconLine);
    insertedRcon = true;
  }
  let secretsContent = nextSecretLines.join("\n").replace(/[\r\n]+$/, "");
  if (!insertedRcon) secretsContent = appendLine(secretsContent, rconLine).replace(/\n$/, "");
  secretsContent = `${secretsContent}\n`;

  const serverLines: string[] = [];
  let removedDirectRcon = false;
  for (const line of files.server.content.split(/\r?\n/)) {
    if (ACTIVE_SECRETS_EXEC.test(line) || COMMENTED_SECRETS_EXEC.test(line)) continue;
    if (ACTIVE_RCON.test(line)) {
      if (!removedDirectRcon) serverLines.push("# RCON credential is stored in secrets.cfg by QB Studio.");
      removedDirectRcon = true;
      continue;
    }
    serverLines.push(line);
  }
  const serverContent = appendLine(serverLines.join("\n"), "exec secrets.cfg");

  // Preflight every participating path before writing the git protection,
  // credential, and finally the exec directive in that order.
  const latestServer = readTextFileSnapshot(files.serverPath);
  if (latestServer.revision !== files.server.revision) throw new Error("server.cfg changed during the RCON preview. Review it again.");
  for (const [filePath, snapshot] of [[files.gitignorePath, files.gitignore], [files.secretsPath, files.secrets]] as const) {
    const current = readOptionalSnapshot(filePath);
    if (current?.revision !== snapshot?.revision) throw new Error(`${path.basename(filePath)} changed during the RCON preview. Review it again.`);
  }

  const changedPaths: string[] = [];
  if (gitignoreContent !== (files.gitignore?.content ?? "")) {
    files.gitignore
      ? writeTextFile(files.gitignorePath, gitignoreContent, files.gitignore.revision)
      : createTextFile(files.gitignorePath, gitignoreContent);
    changedPaths.push(".gitignore");
  }
  files.secrets
    ? writeTextFile(files.secretsPath, secretsContent, files.secrets.revision)
    : createTextFile(files.secretsPath, secretsContent);
  changedPaths.push("secrets.cfg");
  if (serverContent !== files.server.content) {
    writeTextFile(files.serverPath, serverContent, files.server.revision);
    changedPaths.push("server.cfg");
  }

  return { changedPaths, replacedExistingPassword: hasExistingPassword };
}

/**
 * Atomically creates only Studio-owned server-data source files. The temporary
 * folder and final folder are direct children of the same txData root, so the
 * final rename is same-volume. No existing profile is ever modified.
 */
export function createLocalWorkspace(
  txDataPath: string,
  requestedName: string,
  requestedPort: number,
  target: CfxTarget = "legacy",
): LocalWorkspace {
  if (typeof txDataPath !== "string" || !txDataPath) throw new Error("Choose a txData folder first.");
  const rootLinkStat = fs.lstatSync(txDataPath);
  if (!rootLinkStat.isDirectory() || rootLinkStat.isSymbolicLink()) {
    throw new Error("txData path must be a real directory, not a symbolic link or junction.");
  }
  const root = fs.realpathSync(txDataPath);
  if (!fs.statSync(root).isDirectory()) throw new Error("txData path must be a directory.");

  const name = normalizeWorkspaceName(requestedName);
  const port = assertLocalPort(requestedPort);
  const finalPath = path.resolve(root, name);
  if (path.dirname(finalPath) !== root) throw new Error("Workspace must be a direct child of txData.");
  if (directoryEntryExists(finalPath)) throw new Error(`A workspace named "${name}" already exists.`);

  const stagingPath = path.join(root, `.${name}.studio-staging-${randomUUID()}`);
  if (directoryEntryExists(stagingPath)) throw new Error("Could not reserve a temporary workspace directory; try again.");

  try {
    fs.mkdirSync(stagingPath, { mode: 0o700 });
    const resourcesPath = path.join(stagingPath, "resources");
    fs.mkdirSync(path.join(resourcesPath, "[local]"), { recursive: true, mode: 0o700 });
    writeDurableText(path.join(stagingPath, "server.cfg"), starterServerCfg(port, name, target));
    writeDurableText(path.join(stagingPath, ".gitignore"), GITIGNORE);
    writeDurableText(path.join(stagingPath, "secrets.cfg.example"), SECRETS_EXAMPLE);

    // A second collision check protects concurrent Studio calls. On Windows,
    // rename refuses an existing target instead of replacing it.
    if (directoryEntryExists(finalPath)) throw new Error(`A workspace named "${name}" was created concurrently.`);
    fs.renameSync(stagingPath, finalPath);
  } catch (err) {
    try {
      if (fs.existsSync(stagingPath)) fs.rmSync(stagingPath, { recursive: true, force: true });
    } catch {
      // The staging folder contains only files created above; leave it for a
      // manual inspection if the filesystem will not remove it.
    }
    throw err;
  }

  return {
    name,
    profileRoot: finalPath,
    resourcesPath: path.join(finalPath, "resources"),
    serverCfgPath: path.join(finalPath, "server.cfg"),
  };
}
