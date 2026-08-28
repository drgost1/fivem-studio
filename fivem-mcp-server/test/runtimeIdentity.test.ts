import assert from "node:assert/strict";
import test from "node:test";

import { buildRuntimeIdentity } from "../src/runtimeIdentity.js";

test("runtime identity is versioned, secret-free, and signals configured capabilities", () => {
  const identity = buildRuntimeIdentity("0.4.0", {
    serverDataWorkspace: "C:\\txData\\FiveMBasicServerEnhanced_908F3A.base",
    serverConfigPath: "C:\\txData\\FiveMBasicServerEnhanced_908F3A.base\\server.cfg",
    txAdminDataDirectory: "C:\\txAdmin-data",
    txAdminControlProfile: "control",
    rconHost: "127.0.0.1",
    rconPort: 30120,
    rconConfigured: true,
  });

  assert.deepEqual(identity.mcp, { name: "ghz-workbench-runtime", version: "0.4.0" });
  assert.equal(identity.contractVersion, "3");
  assert.equal(identity.runtime.serverData.workspacePath, "C:\\txData\\FiveMBasicServerEnhanced_908F3A.base");
  assert.equal(identity.runtime.serverData.configPath, "C:\\txData\\FiveMBasicServerEnhanced_908F3A.base\\server.cfg");
  assert.equal(identity.runtime.txAdmin.controlProfile, "control");
  assert.equal(identity.capabilities.console, true);
  assert.equal(identity.capabilities.resourceLifecycle, true);
  assert.equal(JSON.stringify(identity).includes("secret"), false);
});

test("runtime identity keeps optional txAdmin control separate from server-data and console capability", () => {
  const identity = buildRuntimeIdentity("0.4.0", {
    serverDataWorkspace: "C:\\workspace",
    serverConfigPath: "C:\\workspace\\server.cfg",
    txAdminDataDirectory: "",
    txAdminControlProfile: "",
    rconHost: "127.0.0.1",
    rconPort: 30120,
    rconConfigured: false,
  });

  assert.equal(identity.runtime.txAdmin.dataDirectory, null);
  assert.equal(identity.runtime.txAdmin.controlProfile, null);
  assert.equal(identity.capabilities.console, false);
  assert.equal(identity.capabilities.resourceLifecycle, false);
});
