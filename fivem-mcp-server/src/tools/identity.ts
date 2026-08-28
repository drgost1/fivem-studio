import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { config } from "../config.js";
import { SERVER_VERSION } from "../mcpServer.js";
import { buildRuntimeIdentity } from "../runtimeIdentity.js";

export function runtimeIdentity() {
  return buildRuntimeIdentity(SERVER_VERSION, {
    serverDataWorkspace: config.serverData.workspacePath,
    serverConfigPath: config.serverData.configPath,
    txAdminDataDirectory: config.txAdmin.dataDir,
    txAdminControlProfile: config.txAdmin.controlProfile,
    rconHost: config.rcon.host,
    rconPort: config.rcon.port,
    rconConfigured: Boolean(config.rcon.password && config.rcon.password !== "changeme"),
  });
}

export function registerIdentityTools(server: McpServer): void {
  server.tool(
    "get_runtime_identity",
    "Return the secret-free, versioned identity and coding capabilities of the local runtime. Use this before resource reloads to verify the active workspace matches.",
    {},
    async () => ({ content: [{ type: "text" as const, text: JSON.stringify(runtimeIdentity(), null, 2) }] }),
  );
}
