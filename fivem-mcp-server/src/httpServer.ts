import http from "node:http";
import { randomUUID } from "node:crypto";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { assertHttpAuthentication, config } from "./config.js";
import { createMcpServer } from "./mcpServer.js";

const MCP_PATH = "/mcp";
const MAX_SESSIONS = 16;
const SESSION_IDLE_MS = 10 * 60_000;
const MAX_REQUEST_BYTES = 1_000_000;
const REQUEST_TIMEOUT_MS = 15_000;

function isAuthorized(req: http.IncomingMessage): boolean {
  if (!config.mcp.token) return config.mcp.unsafeAllowNoToken;
  const header = req.headers["authorization"];
  const expected = `Bearer ${config.mcp.token}`;
  return header === expected;
}

export function startHttpServer(): http.Server {
  assertHttpAuthentication();
  // Each connecting agent gets its own McpServer + transport pair, keyed by
  // the MCP session id the transport generates on initialize.
  const transports = new Map<string, { transport: StreamableHTTPServerTransport; lastUsed: number }>();

  const closeIdleSessions = () => {
    const now = Date.now();
    for (const [sessionId, session] of transports) {
      if (now - session.lastUsed > SESSION_IDLE_MS) {
        transports.delete(sessionId);
        void session.transport.close().catch(() => undefined);
      }
    }
  };
  const cleanupTimer = setInterval(closeIdleSessions, 60_000);
  cleanupTimer.unref();

  const httpServer = http.createServer(async (req, res) => {
    res.setTimeout(REQUEST_TIMEOUT_MS, () => {
      if (!res.headersSent) res.writeHead(408, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "request timed out" }));
    });

    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, server: "qb-studio-runtime" }));
      return;
    }

    if (req.url !== MCP_PATH) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `no route ${req.method} ${req.url} — MCP is served at ${MCP_PATH}` }));
      return;
    }

    if (!isAuthorized(req)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized — missing/incorrect Authorization: Bearer <MCP_TOKEN>" }));
      return;
    }

    const rawContentLength = req.headers["content-length"];
    if (req.method === "POST" && (rawContentLength === undefined || req.headers["transfer-encoding"] !== undefined)) {
      res.writeHead(411, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "POST requests require a fixed Content-Length" }));
      return;
    }
    if (rawContentLength !== undefined && !/^\d+$/.test(rawContentLength)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "invalid Content-Length" }));
      return;
    }
    const contentLength = rawContentLength && /^\d+$/.test(rawContentLength) ? Number(rawContentLength) : 0;
    if (!Number.isSafeInteger(contentLength) || contentLength < 0 || contentLength > MAX_REQUEST_BYTES) {
      res.writeHead(413, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `request body exceeds ${MAX_REQUEST_BYTES} bytes` }));
      return;
    }

    try {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      let active = sessionId ? transports.get(sessionId) : undefined;
      let transport = active?.transport;
      if (active) active.lastUsed = Date.now();

      if (!transport) {
        if (req.method !== "POST") {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "no active session — send an initialize request first" }));
          return;
        }

        closeIdleSessions();
        if (transports.size >= MAX_SESSIONS) {
          res.writeHead(503, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "MCP session limit reached; close an idle client and retry" }));
          return;
        }

        // A POST with no known session ID is treated as a fresh
        // initialize attempt; StreamableHTTPServerTransport itself reads
        // the raw request body and rejects it (per the MCP Streamable HTTP
        // spec) if it isn't actually an initialize request.
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            transports.set(sid, { transport: transport as StreamableHTTPServerTransport, lastUsed: Date.now() });
          },
        });

        transport.onclose = () => {
          if (transport?.sessionId) transports.delete(transport.sessionId);
        };

        const server = createMcpServer();
        await server.connect(transport);
      }

      await transport.handleRequest(req, res);
    } catch (err) {
      console.error("qb-studio-runtime: error handling HTTP MCP request:", err);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "internal error" }));
      }
    }
  });

  httpServer.requestTimeout = REQUEST_TIMEOUT_MS;
  httpServer.headersTimeout = 15_000;
  httpServer.keepAliveTimeout = 10_000;
  httpServer.maxHeadersCount = 100;
  httpServer.on("close", () => clearInterval(cleanupTimer));

  httpServer.listen(config.mcp.port, config.mcp.host, () => {
    const address = httpServer.address();
    const port = address && typeof address === "object" ? address.port : config.mcp.port;
    const authNote = config.mcp.token
      ? "an Authorization: Bearer token is required (MCP_TOKEN is set)"
      : "UNSAFE unauthenticated loopback development mode is enabled";
    console.error(
      `qb-studio-runtime listening on http://${config.mcp.host}:${port}${MCP_PATH} (${authNote})`,
    );
    if (typeof process.send === "function") {
      process.send({ type: "ready", port, protocolVersion: 1 });
    }
  });

  return httpServer;
}
