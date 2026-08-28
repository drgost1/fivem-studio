import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createTextFile, readTextFileSnapshot, writeTextFile } from "./fsTree";

test("atomic editor saves reject a stale revision", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fivem-studio-save-"));
  const target = path.join(root, "client.lua");
  try {
    fs.writeFileSync(target, "first", "utf8");
    const opened = readTextFileSnapshot(target);
    fs.writeFileSync(target, "external edit", "utf8");
    assert.throws(() => writeTextFile(target, "stale editor edit", opened.revision), /changed on disk/);
    assert.equal(fs.readFileSync(target, "utf8"), "external edit");

    const current = readTextFileSnapshot(target);
    const revision = writeTextFile(target, "merged edit", current.revision);
    assert.equal(readTextFileSnapshot(target).revision, revision);
    assert.equal(fs.readFileSync(target, "utf8"), "merged edit");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("atomic agent creates refuse an existing target", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ghz-workbench-create-"));
  const target = path.join(root, "fxmanifest.lua");
  try {
    const revision = createTextFile(target, "fx_version 'cerulean'\n");
    assert.equal(readTextFileSnapshot(target).revision, revision);
    assert.throws(() => createTextFile(target, "replacement"), /created by another process/);
    assert.equal(fs.readFileSync(target, "utf8"), "fx_version 'cerulean'\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
