import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { config } from "./config.js";
import { RconClient } from "./rcon.js";
import { registerConsoleTools } from "./tools/console.js";
import { registerResourceTools } from "./tools/resources.js";
import { registerIdentityTools } from "./tools/identity.js";
import { registerFileTools } from "./tools/files.js";
import { registerBatchTool } from "./tools/batch.js";
import { registerVerifyTools } from "./tools/verify.js";
import { registerGitTools } from "./tools/git.js";
import { registerRawRconTool, registerShellTool } from "./tools/exec.js";

export const SERVER_NAME = "fivem-studio-runtime";
export const SERVER_VERSION = "0.0.0-development";

/**
 * Builds a fresh McpServer with every tool registered. Called once per
 * stdio process, or once per HTTP session (the streamable-HTTP transport
 * binds 1:1 to a server instance, so each connecting agent gets its own —
 * registration itself is cheap and stateless, all the real state lives in
 * the shared RconClient/bridge clients underneath).
 */
export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  const rcon = new RconClient({
    host: config.rcon.host,
    port: config.rcon.port,
    password: config.rcon.password,
  });

  // This is deliberately registered first: every Studio session should
  // compare its selected workspace with this runtime before mutating either.
  registerIdentityTools(server);

  // The base surface is coding-session primitives only: read console logs and
  // reload named resources. No player, gameplay, arbitrary-eval, screenshot,
  // or raw administration tools.
  registerConsoleTools(server);
  registerResourceTools(server, rcon);
  // Composed from the two above and adding no privilege of their own: they
  // collapse the edit -> restart -> "did it break?" loop into one round trip.
  registerVerifyTools(server, rcon);

  // Everything below is opt-in through the runtime env file and stays absent
  // from a stock deployment. These exist so an agent working over one MCP
  // connection can read, edit, verify and push without a shell round trip per
  // step; each is jailed to the configured workspace roots.
  if (config.capabilities.files) {
    registerFileTools(server);
    registerBatchTool(server);
  }
  if (config.capabilities.git) registerGitTools(server);
  if (config.capabilities.rawRcon) registerRawRconTool(server, rcon);
  if (config.capabilities.shell) registerShellTool(server);

  return server;
}
