import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { assertHttpAuthentication, assertServerDataConfig, config } from "../src/config.js";

test("HTTP authentication is mandatory unless unsafe loopback development is explicit", () => {
  const previous = { ...config.mcp };
  try {
    config.mcp.transport = "http";
    config.mcp.token = "";
    config.mcp.unsafeAllowNoToken = false;
    assert.throws(() => assertHttpAuthentication(), /requires MCP_TOKEN/);
    config.mcp.token = "secret";
    assert.doesNotThrow(() => assertHttpAuthentication());
    config.mcp.token = "";
    config.mcp.unsafeAllowNoToken = true;
    assert.doesNotThrow(() => assertHttpAuthentication());
    config.mcp.host = "0.0.0.0";
    assert.throws(() => assertHttpAuthentication(), /numeric loopback address/);
    config.mcp.host = "127.0.0.1";
    config.mcp.transport = "stdio";
    config.mcp.unsafeAllowNoToken = false;
    assert.doesNotThrow(() => assertHttpAuthentication());
  } finally {
    Object.assign(config.mcp, previous);
  }
});

test("production server-data identity requires server.cfg directly inside the workspace", () => {
  const previous = { ...config.serverData };
  const previousTxAdmin = { ...config.txAdmin };
  try {
    config.txAdmin.dataDir = "";
    config.txAdmin.controlProfile = "";
    const workspace = path.resolve("test-server-data");
    config.serverData.workspacePath = workspace;
    config.serverData.configPath = path.join(workspace, "server.cfg");
    assert.doesNotThrow(() => assertServerDataConfig());

    config.serverData.configPath = path.resolve("another-workspace", "server.cfg");
    assert.throws(() => assertServerDataConfig(), /directly inside/);
  } finally {
    config.serverData.workspacePath = previous.workspacePath;
    config.serverData.configPath = previous.configPath;
    config.txAdmin.dataDir = previousTxAdmin.dataDir;
    config.txAdmin.controlProfile = previousTxAdmin.controlProfile;
  }
});
