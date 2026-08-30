import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { duplicateResource } from "./resourceDuplicate";

test("duplicates text and binary resource assets and updates a literal name directive", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qb-studio-duplicate-"));
  try {
    const source = path.join(root, "source-resource");
    fs.mkdirSync(path.join(source, "assets"), { recursive: true });
    fs.writeFileSync(path.join(source, "fxmanifest.lua"), "fx_version 'cerulean'\nname 'source-resource'\n");
    fs.writeFileSync(path.join(source, "assets", "logo.bin"), Buffer.from([0, 255, 1, 2]));
    fs.mkdirSync(path.join(source, "node_modules"));
    fs.writeFileSync(path.join(source, "node_modules", "ignored.js"), "ignored");
    const result = duplicateResource(root, source, "new-resource");
    assert.equal(result.fileCount, 2);
    assert.deepEqual(result.skippedDirectories, ["node_modules"]);
    assert.match(fs.readFileSync(path.join(result.rootPath, "fxmanifest.lua"), "utf8"), /name 'new-resource'/);
    assert.deepEqual(fs.readFileSync(path.join(result.rootPath, "assets", "logo.bin")), Buffer.from([0, 255, 1, 2]));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("refuses collisions and credential-bearing resources without publishing a partial copy", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qb-studio-duplicate-credentials-"));
  try {
    const source = path.join(root, "source");
    fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, "fxmanifest.lua"), "fx_version 'cerulean'\n");
    fs.writeFileSync(path.join(source, "secrets.cfg"), "set sv_licenseKey secret\n");
    assert.throws(() => duplicateResource(root, source, "copy"), /Credential-bearing file/);
    assert.equal(fs.existsSync(path.join(root, "copy")), false);
    assert.equal(fs.readdirSync(root).some((name) => name.startsWith(".qb-studio-duplicate-")), false);
    fs.mkdirSync(path.join(root, "existing"));
    assert.throws(() => duplicateResource(root, source, "existing"), /already exists/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
