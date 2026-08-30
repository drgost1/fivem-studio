import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { readTextFileSnapshot } from "./fsTree";
import {
  buildProjectWritePreview,
  readProjectFileForAgent,
  sanitizeEditorContextForAgent,
  searchProjectForAgent,
} from "./projectTools";

test("project write preview compares the contained disk snapshot with proposed content", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qb-studio-preview-"));
  const target = path.join(root, "qb-test", "client.lua");
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "local before = true\n", "utf8");
    const snapshot = readTextFileSnapshot(target);
    const preview = buildProjectWritePreview(root, {
      path: "qb-test/client.lua",
      content: "local after = true\n",
      expected_revision: snapshot.revision,
    });
    assert.equal(preview.path, path.join("qb-test", "client.lua"));
    assert.equal(preview.originalContent, "local before = true\n");
    assert.equal(preview.modifiedContent, "local after = true\n");
    assert.equal(preview.warning, undefined);

    const stale = buildProjectWritePreview(root, {
      path: "qb-test/client.lua",
      content: "local after = true\n",
      expected_revision: "0".repeat(64),
    });
    assert.match(stale.warning ?? "", /changed after the agent read it/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("project write preview handles new files and rejects traversal", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qb-studio-preview-new-"));
  try {
    const preview = buildProjectWritePreview(root, {
      path: "qb-test/new.lua",
      content: "return true\n",
      expected_revision: "new",
    });
    assert.equal(preview.originalContent, "");
    assert.equal(preview.warning, undefined);
    assert.throws(
      () => buildProjectWritePreview(root, { path: "../outside.lua", content: "", expected_revision: "new" }),
    /outside (?:the allowed root|the project folder)|escapes the allowed root/i,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("hosted-agent reads withhold credential paths and credential-bearing content", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qb-studio-agent-read-secret-"));
  try {
    fs.writeFileSync(path.join(root, ".env"), "OPENAI_API_KEY=sk-test-secret-value\n", "utf8");
    fs.writeFileSync(path.join(root, ".token"), "opaque-raw-secret-value\n", "utf8");
    fs.writeFileSync(path.join(root, "client.lua"), 'local config = { api_key = "sk-test-secret-value" }\n', "utf8");
    fs.writeFileSync(path.join(root, "server.cfg"), 'set discord_token "discord-secret-value"\n', "utf8");
    fs.writeFileSync(path.join(root, "safe.lua"), "return true\n", "utf8");

    const envResult = readProjectFileForAgent(root, ".env");
    assert.match(envResult, /withheld/);
    assert.doesNotMatch(envResult, /sk-test-secret-value/);

    const tokenResult = readProjectFileForAgent(root, ".token");
    assert.match(tokenResult, /withheld/);
    assert.doesNotMatch(tokenResult, /opaque-raw-secret-value/);

    const contentResult = readProjectFileForAgent(root, "client.lua");
    assert.match(contentResult, /content withheld/);
    assert.doesNotMatch(contentResult, /sk-test-secret-value/);

    const convarResult = readProjectFileForAgent(root, "server.cfg");
    assert.match(convarResult, /content withheld/);
    assert.doesNotMatch(convarResult, /discord-secret-value/);

    assert.match(readProjectFileForAgent(root, "safe.lua"), /return true/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("hosted-agent search omits credential files without hiding ordinary matches", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qb-studio-agent-search-secret-"));
  try {
    fs.writeFileSync(path.join(root, "secrets.cfg"), 'set rcon_password "needle-secret"\n', "utf8");
    fs.writeFileSync(path.join(root, "server.lua"), "local needle = true\n", "utf8");
    const result = searchProjectForAgent(root, "", "needle");
    assert.match(result, /server\.lua:1/);
    assert.match(result, /credential-bearing file\(s\) were not searched/);
    assert.doesNotMatch(result, /needle-secret/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("hosted-agent editor context withholds credential files and redacts selected secrets", () => {
  const sensitivePath = sanitizeEditorContextForAgent({
    path: path.resolve("resource", ".env"),
    selectedText: "OPENAI_API_KEY=sk-test-secret-value",
    startLine: 1,
    endLine: 1,
  });
  assert.equal(sensitivePath.selectedText, "[credential-bearing selection withheld]");

  const selectedSecret = sanitizeEditorContextForAgent({
    path: path.resolve("resource", "server.lua"),
    selectedText: 'Authorization: Bearer sk-test-secret-value',
    startLine: 3,
    endLine: 3,
  });
  assert.match(selectedSecret.selectedText, /<redacted>/);
  assert.doesNotMatch(selectedSecret.selectedText, /sk-test-secret-value/);
});
