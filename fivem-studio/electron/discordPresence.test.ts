import assert from "node:assert/strict";
import test from "node:test";

import {
  DISCORD_ACTIVITY_BUTTONS,
  DISCORD_APPLICATION_ID,
  DISCORD_LARGE_IMAGE_KEY,
  DiscordFrameDecoder,
  buildDiscordActivity,
  discordLanguageLabel,
  discordVersionTooltip,
  encodeDiscordFrame,
  normalizeDiscordActivityContext,
  safeDiscordFilename,
} from "./discordPresence";

test("Discord RPC framing supports split and combined messages", () => {
  const first = encodeDiscordFrame(0, { v: 1, client_id: DISCORD_APPLICATION_ID });
  const second = encodeDiscordFrame(3, { hello: "world" });
  const decoder = new DiscordFrameDecoder();
  assert.deepEqual(decoder.push(first.subarray(0, 5)), []);
  assert.deepEqual(decoder.push(Buffer.concat([first.subarray(5), second])), [
    { opcode: 0, payload: { v: 1, client_id: DISCORD_APPLICATION_ID } },
    { opcode: 3, payload: { hello: "world" } },
  ]);
});

test("Discord activity shows a basename, language, target, version, and fixed actions", () => {
  const context = normalizeDiscordActivityContext({
    view: "editor",
    filePath: "C:\\Private Customer\\secret-resource\\client.lua",
  });
  const activity = buildDiscordActivity("enhanced", 1234, context, "1.4.0");
  assert.deepEqual(activity, {
    type: 0,
    details: "Editing client.lua",
    state: "FiveM Enhanced · Lua",
    timestamps: { start: 1234 },
    assets: { large_image: DISCORD_LARGE_IMAGE_KEY, large_text: "FiveM Studio v1.4.0" },
    buttons: [
      { label: "Visit QBCore", url: "https://qbcore.org" },
      { label: "Download FiveM Studio", url: "https://github.com/drgost1/fivem-studio/releases/latest" },
    ],
  });
  assert.equal(activity.buttons.length, 2);
  assert.deepEqual(activity.buttons, DISCORD_ACTIVITY_BUTTONS);
  const serialized = JSON.stringify(activity);
  assert.equal(serialized.includes("Private Customer"), false);
  assert.equal(serialized.includes("secret-resource"), false);
  assert.equal(serialized.includes("C:\\"), false);
});

test("Discord contexts produce concise activity labels without stale filenames", () => {
  const cases = [
    ["startup", "Developing with FiveM Studio"],
    ["viewport", "Testing in the viewport"],
    ["console", "Monitoring the console"],
    ["resources", "Browsing resources"],
    ["assistant", "Working with the assistant"],
    ["setup", "Setting up FiveM Studio"],
    ["settings", "Customizing FiveM Studio"],
  ] as const;
  for (const [view, details] of cases) {
    const context = normalizeDiscordActivityContext({ view, filePath: "C:\\should-not-leak\\server.cfg" });
    assert.deepEqual(context, { view, filename: null });
    assert.equal(buildDiscordActivity("redm", 1, context).details, details);
  }
  const review = normalizeDiscordActivityContext({ view: "review", filePath: "/private/project/fxmanifest.lua" });
  assert.equal(buildDiscordActivity("legacy", 1, review).details, "Reviewing fxmanifest.lua");
  assert.equal(buildDiscordActivity("legacy", 1, review).state, "FiveM Legacy · Lua");
});

test("Discord filename normalization strips paths, controls, and excessive length", () => {
  assert.equal(safeDiscordFilename("C:\\workspace\\resource\\server.cfg"), "server.cfg");
  assert.equal(safeDiscordFilename("/workspace/resource/\u202eclient.lua"), "client.lua");
  assert.equal(safeDiscordFilename(".."), null);
  assert.equal(safeDiscordFilename(42), null);
  assert.equal(safeDiscordFilename("x".repeat(32_768)), null);
  const longName = safeDiscordFilename(`/private/${"a".repeat(120)}.lua`);
  assert.ok(longName);
  assert.ok(Array.from(longName).length <= 80);
  assert.ok(longName.endsWith(".lua"));
  assert.throws(() => normalizeDiscordActivityContext({ view: "project-secrets", filePath: "secret.lua" }), /Unsupported/);
  assert.throws(() => normalizeDiscordActivityContext([]), /must be an object/);
});

test("Discord language and version labels use a fixed safe vocabulary", () => {
  assert.equal(discordLanguageLabel("client.lua"), "Lua");
  assert.equal(discordLanguageLabel("config.json"), "JSON");
  assert.equal(discordLanguageLabel("server.cfg"), "CFG");
  assert.equal(discordLanguageLabel("main.tsx"), "TypeScript");
  assert.equal(discordLanguageLabel("notes.unknown"), "Plain text");
  assert.equal(discordLanguageLabel(null), null);
  assert.equal(discordVersionTooltip("0.0.0-development"), "FiveM Studio development build");
  assert.equal(discordVersionTooltip("v1.4.0"), "FiveM Studio v1.4.0");
});
