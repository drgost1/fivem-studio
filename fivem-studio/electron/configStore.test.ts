import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  normalizeConfig,
  providerCredentialStorageAccess,
  providerCredentialStorageNames,
} from "./configStore";

test("provider credential filenames hash the complete canonical endpoint and retain the legacy migration name", () => {
  const sharedPrefix = `https://example.com/${"a".repeat(100)}`;
  const first = providerCredentialStorageNames(`${sharedPrefix}/provider-one/v1`);
  const second = providerCredentialStorageNames(`${sharedPrefix}/provider-two/v1`);
  assert.match(first.current, /^provider-[a-f0-9]{64}$/);
  assert.notEqual(first.current, second.current, "full URLs that collided under the truncated slug must stay distinct");
  assert.equal(first.legacy, second.legacy, "fixture exercises the legacy truncated-slug collision");

  assert.equal(
    providerCredentialStorageNames("https://EXAMPLE.com:443/v1").current,
    providerCredentialStorageNames("https://example.com/v1").current,
    "URL canonicalization must not fork storage for equivalent endpoints",
  );
});

test("legacy provider keys are available only to the persisted endpoint, never a colliding draft", () => {
  const sharedPrefix = `https://example.com/${"a".repeat(100)}`;
  const persisted = `${sharedPrefix}/provider-one/v1`;
  const draft = `${sharedPrefix}/provider-two/v1`;
  const persistedNames = providerCredentialStorageNames(persisted);
  const draftNames = providerCredentialStorageNames(draft);
  assert.equal(persistedNames.legacy, draftNames.legacy, "fixture must collide under the legacy slug");

  assert.deepEqual(providerCredentialStorageAccess(persisted, persisted), {
    current: persistedNames.current,
    legacy: persistedNames.legacy,
  });
  assert.deepEqual(providerCredentialStorageAccess(draft, persisted), {
    current: draftNames.current,
    legacy: null,
  }, "a draft endpoint may neither migrate nor clear the persisted endpoint's legacy key");
});

test("canonical-equivalent provider URLs retain current-endpoint migration and clear access", () => {
  const access = providerCredentialStorageAccess(
    "https://EXAMPLE.com:443/v1",
    "https://example.com/v1",
  );
  const names = providerCredentialStorageNames("https://example.com/v1");
  assert.deepEqual(access, { current: names.current, legacy: names.legacy });
});

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
  assert.equal(normalizeConfig({ theme: "custom:qb-red" }).theme, "custom:qb-red");
  assert.equal(normalizeConfig({ theme: "custom:../escape" }).theme, "system");
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

test("privacy-safe Discord presence defaults on and accepts an explicit preference", () => {
  assert.equal(normalizeConfig({}).discordPresenceEnabled, false);
  assert.equal(normalizeConfig({ discordPresenceEnabled: false }).discordPresenceEnabled, false);
  assert.equal(normalizeConfig({ discordPresenceEnabled: "false" }).discordPresenceEnabled, false);
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
