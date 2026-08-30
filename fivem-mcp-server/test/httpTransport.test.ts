import assert from "node:assert/strict";
import { once } from "node:events";
import path from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { config } from "../src/config.js";
import { startHttpServer } from "../src/httpServer.js";

test("HTTP transport initializes, lists tools, and returns runtime identity", async () => {
  config.mcp.host = "127.0.0.1";
  config.mcp.port = 0;
  config.mcp.token = "transport-test-token";
  config.mcp.unsafeAllowNoToken = false;
  config.serverData.workspacePath = path.resolve("test-server-data");
  config.serverData.configPath = path.join(config.serverData.workspacePath, "server.cfg");
  const httpServer = startHttpServer();
  let client: Client | null = null;
  try {
    await once(httpServer, "listening");
    const address = httpServer.address();
    assert.ok(address && typeof address === "object");

    client = new Client({ name: "transport-test", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`), {
      requestInit: { headers: { Authorization: "Bearer transport-test-token" } },
    });
    await client.connect(transport);

    const tools = await client.listTools();
    assert.deepEqual(
      tools.tools.map((tool) => tool.name).sort(),
      ["get_console_output", "get_runtime_identity", "list_resources", "restart_resource", "start_resource", "stop_resource"],
    );

    const result = await client.callTool({ name: "get_runtime_identity", arguments: {} });
    const block = (result.content as Array<{ type: string; text?: string }>).find((item) => item.type === "text");
    const identity = JSON.parse(block?.text ?? "null") as {
      contractVersion?: string;
      runtime?: { serverData?: { workspacePath?: string | null; configPath?: string | null } };
    } | null;
    assert.equal(identity?.contractVersion, "3");
    assert.ok(identity?.runtime?.serverData?.workspacePath);
    assert.ok(identity?.runtime?.serverData?.configPath);

    const resources = await client.callTool({ name: "list_resources", arguments: {} });
    const structured = resources.structuredContent as {
      resources?: Array<{ name?: unknown; state?: unknown }>;
      serverStateAvailable?: unknown;
    } | undefined;
    assert.ok(Array.isArray(structured?.resources));
    assert.equal(typeof structured?.serverStateAvailable, "boolean");
    for (const resource of structured.resources) {
      assert.equal(typeof resource.name, "string");
      assert.ok(resource.state === "started" || resource.state === "stopped");
    }
  } finally {
    await client?.close().catch(() => undefined);
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  }
});

test("HTTP transport fails closed without a token unless unsafe loopback mode is explicit", () => {
  const previous = { ...config.mcp };
  try {
    config.mcp.transport = "http";
    config.mcp.host = "127.0.0.1";
    config.mcp.port = 0;
    config.mcp.token = "";
    config.mcp.unsafeAllowNoToken = false;
    assert.throws(() => startHttpServer(), /requires MCP_TOKEN/);

    config.mcp.unsafeAllowNoToken = true;
    const server = startHttpServer();
    server.close();
  } finally {
    Object.assign(config.mcp, previous);
  }
});
