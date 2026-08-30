import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { importResourceFolder } from "./resourceImport";

test("imports a manifest-rooted external folder with binary assets", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "qb-studio-import-"));
  try {
    const resources = path.join(base, "resources");
    const external = path.join(base, "external-resource");
    fs.mkdirSync(resources);
    fs.mkdirSync(path.join(external, "assets"), { recursive: true });
    fs.writeFileSync(path.join(external, "fxmanifest.lua"), "fx_version 'cerulean'\n");
    fs.writeFileSync(path.join(external, "assets", "asset.bin"), Buffer.from([0, 2, 4]));
    const result = importResourceFolder(resources, external);
    assert.equal(result.name, "external-resource");
    assert.equal(result.fileCount, 2);
    assert.deepEqual(fs.readFileSync(path.join(result.rootPath, "assets", "asset.bin")), Buffer.from([0, 2, 4]));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("refuses non-resources, collisions, and credentials without publishing partial imports", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "qb-studio-import-refusal-"));
  try {
    const resources = path.join(base, "resources");
    const external = path.join(base, "external");
    fs.mkdirSync(resources);
    fs.mkdirSync(external);
    assert.throws(() => importResourceFolder(resources, external), /not a Cfx resource/);
    fs.writeFileSync(path.join(external, "fxmanifest.lua"), "fx_version 'cerulean'\n");
    fs.writeFileSync(path.join(external, ".env"), "API_KEY=secret\n");
    assert.throws(() => importResourceFolder(resources, external), /Credential-bearing file/);
    assert.equal(fs.existsSync(path.join(resources, "external")), false);
    assert.equal(fs.readdirSync(resources).some((name) => name.startsWith(".qb-studio-import-")), false);
    fs.mkdirSync(path.join(resources, "external"));
    assert.throws(() => importResourceFolder(resources, external), /already exists/);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
