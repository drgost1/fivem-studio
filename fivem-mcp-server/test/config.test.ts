import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { assertServerDataConfig, config } from "../src/config.js";

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
