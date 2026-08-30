import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { compareResources } from "./resourceCompare";

test("compares two contained resources while withholding credential content", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qb-studio-resource-compare-"));
  try {
    const left = path.join(root, "left");
    const right = path.join(root, "right");
    fs.mkdirSync(left);
    fs.mkdirSync(right);
    fs.writeFileSync(path.join(left, "fxmanifest.lua"), "fx_version 'cerulean'\n");
    fs.writeFileSync(path.join(right, "fxmanifest.lua"), "fx_version 'cerulean'\n");
    fs.writeFileSync(path.join(left, "main.lua"), "print('left')\n");
    fs.writeFileSync(path.join(right, "main.lua"), "print('right')\n");
    fs.writeFileSync(path.join(right, "added.bin"), Buffer.from([0, 1, 2]));
    fs.writeFileSync(path.join(right, "secrets.cfg"), "sv_licenseKey secret\n");
    const result = compareResources(root, left, right);
    assert.equal(result.totalChanged, 2);
    assert.equal(result.skippedCredentialFiles, 1);
    assert.deepEqual(result.files.map((file) => [file.relativePath, file.kind, file.previewUnavailable]), [
      ["added.bin", "added", true],
      ["main.lua", "modified", false],
    ]);
    assert.match(result.files[1].originalContent, /left/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("refuses resource paths outside the resources root", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qb-studio-resource-compare-boundary-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "qb-studio-resource-outside-"));
  try {
    fs.writeFileSync(path.join(outside, "fxmanifest.lua"), "fx_version 'cerulean'\n");
    assert.throws(() => compareResources(root, outside, outside), /outside the project folder/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});
