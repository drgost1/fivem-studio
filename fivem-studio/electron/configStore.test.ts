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

test("theme preferences migrate to system and accept every supported explicit theme", () => {
  assert.equal(normalizeConfig({}).theme, "system");
  for (const theme of ["system", "dark", "light", "high-contrast"] as const) {
    assert.equal(normalizeConfig({ theme }).theme, theme);
  }
  assert.equal(normalizeConfig({ theme: "neon" }).theme, "system");
});

test("UI scale is bounded to supported zoom factors", () => {
  assert.equal(normalizeConfig({}).uiScale, 1);
  for (const uiScale of [0.8, 0.9, 1, 1.1, 1.25, 1.5]) {
    assert.equal(normalizeConfig({ uiScale }).uiScale, uiScale);
  }
  assert.equal(normalizeConfig({ uiScale: 4 }).uiScale, 1);
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

test("unexpected server-exit notifications default on and accept an explicit preference", () => {
  assert.equal(normalizeConfig({}).notifyOnServerExit, true);
  assert.equal(normalizeConfig({ notifyOnServerExit: false }).notifyOnServerExit, false);
  assert.equal(normalizeConfig({ notifyOnServerExit: "false" }).notifyOnServerExit, true);
});

test("agent spend warnings are configurable and bounded", () => {
  assert.equal(normalizeConfig({}).agentSpendWarningUsd, 5);
  for (const threshold of [0, 1, 2, 5, 10, 20]) {
    assert.equal(normalizeConfig({ agentSpendWarningUsd: threshold }).agentSpendWarningUsd, threshold);
  }
  assert.equal(normalizeConfig({ agentSpendWarningUsd: -1 }).agentSpendWarningUsd, 5);
});

test("editor preferences are bounded and migrate from missing settings", () => {
  assert.deepEqual(normalizeConfig({}).editor, {
    fontSize: 13,
    wordWrap: false,
    minimap: false,
    stickyScroll: true,
    formatOnSave: false,
    restartResourceOnSave: false,
    luaIntelligence: "balanced",
  });
  assert.deepEqual(normalizeConfig({
    editor: {
      fontSize: 18,
      wordWrap: true,
      minimap: true,
      stickyScroll: false,
      formatOnSave: true,
      restartResourceOnSave: true,
      luaIntelligence: "full",
    },
  }).editor, {
    fontSize: 18,
    wordWrap: true,
    minimap: true,
    stickyScroll: false,
    formatOnSave: true,
    restartResourceOnSave: true,
    luaIntelligence: "full",
  });
  assert.equal(normalizeConfig({ editor: { fontSize: 99 } }).editor.fontSize, 13);
  assert.equal(normalizeConfig({ editor: { luaIntelligence: "turbo" } }).editor.luaIntelligence, "balanced");
});
