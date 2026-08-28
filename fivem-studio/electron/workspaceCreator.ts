// Creates a local *server-data workspace* below txData. This intentionally
// does not create txAdmin's control profile/config.json: txAdmin owns that
// schema and attaches a control profile to a data path through its own UI.

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const MAX_WORKSPACE_NAME_LENGTH = 64;
const WINDOWS_RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9]|clock\$)(?:\.|$)/i;

export interface LocalWorkspace {
  name: string;
  profileRoot: string;
  resourcesPath: string;
  serverCfgPath: string;
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

export function starterServerCfg(port: number, workspaceName: string): string {
  return `# Ghz Workbench local server-data workspace: ${workspaceName}\n` +
    "# txAdmin owns its control profile/config.json. Attach this folder through txAdmin's normal deployment flow.\n" +
    "# This template deliberately contains no license key, RCON password, or other secrets.\n\n" +
    `endpoint_add_tcp "127.0.0.1:${port}"\n` +
    `endpoint_add_udp "127.0.0.1:${port}"\n` +
    "sv_master1 \"\"\n\n" +
    `sv_hostname "Ghz Workbench Local - ${workspaceName}"\n` +
    "sv_maxclients 8\n" +
    `sets sv_projectName "${workspaceName}"\n\n` +
    "# Copy secrets.cfg.example to secrets.cfg, add your own values, then uncomment this line.\n" +
    "# exec secrets.cfg\n\n" +
    "# Your Ghz Workbench resources belong in resources/[local]/.\n" +
    "ensure [local]\n";
}

const GITIGNORE = `# FXServer / txAdmin runtime output\ncache/\ncrashes/\nlogs/\nlocal-database/\ndata/\n.console-history\n.id\nserver.cfg.bkp\n\n# Local credentials\nsecrets.cfg\n`;
const SECRETS_EXAMPLE = `# Copy this file to secrets.cfg. Do not commit secrets.cfg.\n# sv_licenseKey "paste-your-own-key-here"\n# rcon_password "choose-a-local-development-password"\n`;

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

/**
 * Atomically creates only Studio-owned server-data source files. The temporary
 * folder and final folder are direct children of the same txData root, so the
 * final rename is same-volume. No existing profile is ever modified.
 */
export function createLocalWorkspace(txDataPath: string, requestedName: string, requestedPort: number): LocalWorkspace {
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
    writeDurableText(path.join(stagingPath, "server.cfg"), starterServerCfg(port, name));
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
