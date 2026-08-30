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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qb-studio-create-"));
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

test("editor reads refuse binary and malformed UTF-8 before decoding", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qb-studio-binary-read-"));
  try {
    const nulBytes = path.join(root, "asset.bin");
    fs.writeFileSync(nulBytes, Buffer.from([0x61, 0x00, 0x62]));
    assert.throws(() => readTextFileSnapshot(nulBytes), /binary or non-UTF-8/);

    const invalidUtf8 = path.join(root, "invalid.lua");
    fs.writeFileSync(invalidUtf8, Buffer.from([0x70, 0x72, 0x69, 0x6e, 0x74, 0x28, 0xff, 0x29]));
    assert.throws(() => readTextFileSnapshot(invalidUtf8), /binary or non-UTF-8/);

    const unicode = path.join(root, "unicode.lua");
    fs.writeFileSync(unicode, "print('你好')\n", "utf8");
    assert.equal(readTextFileSnapshot(unicode).content, "print('你好')\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
