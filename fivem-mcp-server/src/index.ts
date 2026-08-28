#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { assertServerDataConfig, config } from "./config.js";
import { createMcpServer, SERVER_NAME } from "./mcpServer.js";
import { startHttpServer } from "./httpServer.js";

async function main() {
  assertServerDataConfig();
  if (config.mcp.transport === "stdio") {
    const server = createMcpServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error(`${SERVER_NAME} running on stdio`);
    return;
  }

  // The desktop app uses private loopback HTTP. Stdio remains available for
  // focused runtime development without exposing a network listener.
  startHttpServer();
}

main().catch((err) => {
  console.error("ghz-workbench-runtime failed to start:", err);
  process.exit(1);
});
