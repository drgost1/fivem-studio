import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { config } from "./config.js";
import { RconClient } from "./rcon.js";
import { registerConsoleTools } from "./tools/console.js";
import { registerResourceTools } from "./tools/resources.js";
import { registerIdentityTools } from "./tools/identity.js";

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

  // The runtime intentionally exposes only coding-session primitives: read
  // console logs and reload named resources. There are no player, gameplay,
  // arbitrary-eval, screenshot, or raw administration tools.
  registerConsoleTools(server);
  registerResourceTools(server, rcon);

  return server;
}
