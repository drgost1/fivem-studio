import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { normalizeConfig } from "./configStore";

test("single-path Enhanced settings migrate into the Enhanced slots", () => {
  const server = path.resolve("old-enhanced", "cfx-server.exe");
  const client = path.resolve("old-enhanced-client", "FiveM.exe");
  const migrated = normalizeConfig({ fxServerExePath: server, fivemExePath: client, artifactTrack: "latest" });

  assert.equal(migrated.activeCfxTarget, "enhanced");
  assert.equal(migrated.enhancedFxServerExePath, server);
  assert.equal(migrated.enhancedFivemExePath, client);
  assert.equal(migrated.legacyFxServerExePath, null);
  assert.equal(migrated.legacyFivemExePath, null);
  assert.equal(migrated.legacyArtifactTrack, "latest");
});

test("v1.1.5 active edition migrates to the matching Cfx target", () => {
  const migrated = normalizeConfig({ activeCfxEdition: "enhanced" });
  assert.equal(migrated.activeCfxTarget, "enhanced");
});

test("explicit FiveM and RedM paths remain separate", () => {
  const legacyServer = path.resolve("legacy", "FXServer.exe");
  const enhancedServer = path.resolve("enhanced", "cfx-server.exe");
  const redmServer = path.resolve("redm", "FXServer.exe");
  const legacyClient = path.resolve("legacy-client", "FiveM.exe");
  const enhancedClient = path.resolve("enhanced-client", "FiveM.exe");
  const redmClient = path.resolve("redm-client", "RedM.exe");
  const normalized = normalizeConfig({
    activeCfxTarget: "redm",
    legacyFxServerExePath: legacyServer,
    enhancedFxServerExePath: enhancedServer,
    redmFxServerExePath: redmServer,
    legacyFivemExePath: legacyClient,
    enhancedFivemExePath: enhancedClient,
    redmClientExePath: redmClient,
    redmArtifactTrack: "latest",
  });

  assert.equal(normalized.activeCfxTarget, "redm");
  assert.equal(normalized.legacyFxServerExePath, legacyServer);
  assert.equal(normalized.enhancedFxServerExePath, enhancedServer);
  assert.equal(normalized.redmFxServerExePath, redmServer);
  assert.equal(normalized.legacyFivemExePath, legacyClient);
  assert.equal(normalized.enhancedFivemExePath, enhancedClient);
  assert.equal(normalized.redmClientExePath, redmClient);
  assert.equal(normalized.redmArtifactTrack, "latest");
});

test("console refresh accepts supported intervals and defaults invalid values", () => {
  for (const interval of [0, 1_000, 2_000, 5_000, 10_000, 30_000]) {
    assert.equal(normalizeConfig({ consoleRefreshIntervalMs: interval }).consoleRefreshIntervalMs, interval);
  }

  for (const interval of [-1, 500, 2_500, 60_000, "2000", null]) {
    assert.equal(normalizeConfig({ consoleRefreshIntervalMs: interval }).consoleRefreshIntervalMs, 2_000);
  }
});
