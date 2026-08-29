import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { normalizeConfig } from "./configStore";

test("single-path Enhanced settings migrate into the Enhanced slots", () => {
  const server = path.resolve("old-enhanced", "cfx-server.exe");
  const client = path.resolve("old-enhanced-client", "FiveM.exe");
  const migrated = normalizeConfig({ fxServerExePath: server, fivemExePath: client, artifactTrack: "latest" });

  assert.equal(migrated.activeCfxEdition, "enhanced");
  assert.equal(migrated.enhancedFxServerExePath, server);
  assert.equal(migrated.enhancedFivemExePath, client);
  assert.equal(migrated.legacyFxServerExePath, null);
  assert.equal(migrated.legacyFivemExePath, null);
  assert.equal(migrated.legacyArtifactTrack, "latest");
});

test("explicit Legacy and Enhanced paths remain separate", () => {
  const legacyServer = path.resolve("legacy", "FXServer.exe");
  const enhancedServer = path.resolve("enhanced", "cfx-server.exe");
  const legacyClient = path.resolve("legacy-client", "FiveM.exe");
  const enhancedClient = path.resolve("enhanced-client", "FiveM.exe");
  const normalized = normalizeConfig({
    activeCfxEdition: "legacy",
    legacyFxServerExePath: legacyServer,
    enhancedFxServerExePath: enhancedServer,
    legacyFivemExePath: legacyClient,
    enhancedFivemExePath: enhancedClient,
  });

  assert.equal(normalized.activeCfxEdition, "legacy");
  assert.equal(normalized.legacyFxServerExePath, legacyServer);
  assert.equal(normalized.enhancedFxServerExePath, enhancedServer);
  assert.equal(normalized.legacyFivemExePath, legacyClient);
  assert.equal(normalized.enhancedFivemExePath, enhancedClient);
});
