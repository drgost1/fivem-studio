import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { detectConventionalClientInstalls } from "./clientInstallDiscovery";

test("client discovery finds only conventional FiveM, Enhanced, and RedM launchers", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qb-studio-client-discovery-"));
  try {
    const legacy = path.join(root, "FiveM", "FiveM.exe");
    const enhanced = path.join(root, "FiveM Enhanced", "FiveM.exe");
    const redm = path.join(root, "RedM", "RedM.exe");
    for (const target of [legacy, enhanced, redm]) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, "launcher");
    }
    fs.mkdirSync(path.join(root, "Custom"));
    fs.writeFileSync(path.join(root, "Custom", "FiveM.exe"), "untrusted");

    assert.deepEqual(detectConventionalClientInstalls(root), { legacy, enhanced, redm });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("client discovery returns empty findings for missing or linked candidates", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qb-studio-client-discovery-link-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "qb-studio-client-discovery-outside-"));
  try {
    fs.writeFileSync(path.join(outside, "FiveM.exe"), "launcher");
    try {
      fs.symlinkSync(outside, path.join(root, "FiveM"), "junction");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        t.skip("creating directory links requires Windows Developer Mode or elevation");
        return;
      }
      throw error;
    }
    assert.deepEqual(detectConventionalClientInstalls(root), { legacy: null, enhanced: null, redm: null });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});
