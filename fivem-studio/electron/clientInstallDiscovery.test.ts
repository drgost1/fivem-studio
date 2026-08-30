import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { detectConventionalClientInstalls, detectConventionalExecutables } from "./clientInstallDiscovery";

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

test("executable discovery probes conventional server folders without recursive scanning", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qb-studio-executable-discovery-"));
  try {
    const txData = path.join(root, "txData");
    const legacy = path.join(root, "FiveMServer", "FXServer.exe");
    const enhanced = path.join(root, "fivemserverenhanced", "cfx-server.exe");
    const redm = path.join(root, "RedMServer", "FXServer.exe");
    for (const target of [txData, path.dirname(legacy), path.dirname(enhanced), path.dirname(redm), path.join(root, "random", "nested")]) {
      fs.mkdirSync(target, { recursive: true });
    }
    for (const target of [
      path.join(path.dirname(legacy), "citizen", "system_resources"),
      path.join(path.dirname(enhanced), "system_resources"),
      path.join(path.dirname(redm), "citizen", "system_resources"),
    ]) fs.mkdirSync(target, { recursive: true });
    for (const target of [legacy, enhanced, redm, path.join(root, "random", "nested", "FXServer.exe")]) fs.writeFileSync(target, "server");
    assert.deepEqual(detectConventionalExecutables({ txDataPath: txData }), {
      clients: { legacy: null, enhanced: null, redm: null },
      servers: { legacy, enhanced, redm },
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("artifact records restore target-specific server paths", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qb-studio-artifact-discovery-"));
  try {
    const artifactRoot = path.join(root, "custom-location");
    const executable = path.join(artifactRoot, "cfx-server.exe");
    const state = path.join(root, "artifact-install-enhanced.json");
    fs.mkdirSync(artifactRoot);
    fs.mkdirSync(path.join(artifactRoot, "system_resources"));
    fs.writeFileSync(executable, "server");
    fs.writeFileSync(state, JSON.stringify({ schemaVersion: 1, artifactRoot, executableName: "cfx-server.exe" }));
    assert.equal(detectConventionalExecutables({ artifactStatePaths: { enhanced: state } }).servers.enhanced, executable);
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
