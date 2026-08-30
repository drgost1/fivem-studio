import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { normalizeConfig } from "./configStore";
import { listRecentWorkspaces, recordRecentWorkspace, resolveRecentWorkspace } from "./recentWorkspaces";

test("recent workspaces are bounded, opaque to the renderer, and resolve from app-owned state", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qb-studio-recents-"));
  try {
    const state = path.join(root, "recents.json");
    const txData = path.join(root, "txData");
    fs.mkdirSync(path.join(txData, "alpha"), { recursive: true });
    const config = normalizeConfig({ txDataPath: txData, selectedProfile: "alpha", activeCfxTarget: "redm" });
    recordRecentWorkspace(state, config);

    const [summary] = listRecentWorkspaces(state);
    assert.equal(summary.label, "alpha");
    assert.equal(summary.target, "redm");
    assert.equal(JSON.stringify(summary).includes(txData), false);
    assert.deepEqual(resolveRecentWorkspace(state, summary.id), { txDataPath: txData, profile: "alpha", target: "redm" });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("missing recent workspace directories are not exposed", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qb-studio-recents-missing-"));
  try {
    const state = path.join(root, "recents.json");
    const txData = path.join(root, "txData");
    fs.mkdirSync(path.join(txData, "gone"), { recursive: true });
    recordRecentWorkspace(state, normalizeConfig({ txDataPath: txData, selectedProfile: "gone" }));
    fs.rmSync(path.join(txData, "gone"), { recursive: true });
    assert.deepEqual(listRecentWorkspaces(state), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
