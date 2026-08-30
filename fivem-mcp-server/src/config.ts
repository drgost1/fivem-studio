import { config as loadDotenv } from "dotenv";
import path from "node:path";

import { assertLoopbackHost, assertSafeMcpExposure, isSafeProfileName } from "./networkPolicy.js";

loadDotenv({ quiet: true });

function optional(name: string, fallback = ""): string {
  return process.env[name] ?? fallback;
}

function requiredNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  if (Number.isNaN(n)) throw new Error(`${name} must be a number, got: ${raw}`);
  return n;
}

function enabled(name: string): boolean {
  return optional(name) === "1";
}

export const config = {
  // The coding workspace and its server.cfg are distinct from txAdmin's own
  // data/control profile, which is used only for console-log discovery.
  serverData: {
    workspacePath: optional("SERVER_DATA_WORKSPACE"),
    configPath: optional("SERVER_CONFIG_PATH"),
  },
  rcon: {
    host: optional("RCON_HOST", "127.0.0.1"),
    port: requiredNumber("RCON_PORT", 30120),
    password: optional("RCON_PASSWORD"),
  },
  // txAdmin owns the process. Its optional durable console log is addressed
  // through its data directory plus control profile; no txAdmin web/admin API
  // is used.
  txAdmin: {
    dataDir: optional("TXADMIN_DATA_DIR"), // path to txData, e.g. C:\txData
    controlProfile: optional("TXADMIN_CONTROL_PROFILE"),
  },
  mcp: {
    // "http" (default) — agents connect over the network to MCP_PORT.
    // "stdio" — classic local-process MCP client config instead.
    transport: (optional("MCP_TRANSPORT", "http") as "http" | "stdio"),
    host: optional("MCP_HOST", "127.0.0.1"),
    port: requiredNumber("MCP_PORT", 3414),
    // HTTP is authenticated by default. The unsafe switch exists only for
    // deliberate, loopback-only standalone development.
    token: optional("MCP_TOKEN"),
    unsafeAllowNoToken: enabled("MCP_UNSAFE_ALLOW_NO_TOKEN"),
  },
};

if (config.mcp.transport !== "http" && config.mcp.transport !== "stdio") {
  throw new Error(`MCP_TRANSPORT must be \"http\" or \"stdio\", got: ${config.mcp.transport}`);
}

if (config.mcp.transport === "http") {
  assertSafeMcpExposure(config.mcp.host);
}

export function assertHttpAuthentication(): void {
  if (config.mcp.transport !== "http") return;
  // Re-check at listener creation as well as module initialization. Tests and
  // embedding callers can intentionally update the exported runtime config;
  // unsafe no-token mode must never turn that into a non-loopback listener.
  assertSafeMcpExposure(config.mcp.host);
  if (!config.mcp.token && !config.mcp.unsafeAllowNoToken) {
    throw new Error(
      "HTTP MCP requires MCP_TOKEN. For deliberate loopback-only development without authentication, set MCP_UNSAFE_ALLOW_NO_TOKEN=1.",
    );
  }
}

assertLoopbackHost(config.rcon.host, "RCON_HOST");
if (!Number.isInteger(config.rcon.port) || config.rcon.port < 1 || config.rcon.port > 65535) {
  throw new Error("RCON_PORT must be a whole number between 1 and 65535.");
}
if (!Number.isInteger(config.mcp.port) || config.mcp.port < 0 || config.mcp.port > 65535) {
  throw new Error("MCP_PORT must be a whole number between 0 and 65535.");
}
if (config.txAdmin.controlProfile && !isSafeProfileName(config.txAdmin.controlProfile)) {
  throw new Error("TXADMIN_CONTROL_PROFILE must be a single profile folder name without path separators.");
}

/** Enforced by the executable entry point after tests or an embedding caller
 * have supplied configuration. A running runtime must always name its exact
 * selected workspace and server.cfg, even when txAdmin logging is disabled. */
export function assertServerDataConfig(): void {
  if (Boolean(config.txAdmin.dataDir) !== Boolean(config.txAdmin.controlProfile)) {
    throw new Error("TXADMIN_DATA_DIR and TXADMIN_CONTROL_PROFILE must either both be set or both be empty.");
  }
  if (config.txAdmin.dataDir && !path.isAbsolute(config.txAdmin.dataDir)) {
    throw new Error("TXADMIN_DATA_DIR must be an absolute path when console tailing is enabled.");
  }
  for (const [name, value] of [
    ["SERVER_DATA_WORKSPACE", config.serverData.workspacePath],
    ["SERVER_CONFIG_PATH", config.serverData.configPath],
  ] as const) {
    if (!value) throw new Error(`${name} must identify the selected server-data workspace/server.cfg.`);
    if (!path.isAbsolute(value)) throw new Error(`${name} must be an absolute path.`);
  }
  if (path.basename(config.serverData.configPath).toLowerCase() !== "server.cfg") {
    throw new Error("SERVER_CONFIG_PATH must point to server.cfg.");
  }
  const workspace = path.resolve(config.serverData.workspacePath);
  const configDirectory = path.resolve(path.dirname(config.serverData.configPath));
  const sameDirectory = process.platform === "win32"
    ? workspace.toLowerCase() === configDirectory.toLowerCase()
    : workspace === configDirectory;
  if (!sameDirectory) {
    throw new Error("SERVER_CONFIG_PATH must identify server.cfg directly inside SERVER_DATA_WORKSPACE.");
  }
}
