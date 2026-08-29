import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { assertLocalPort, createLocalWorkspace, normalizeWorkspaceName } from "./workspaceCreator";

test("workspace name normalization rejects traversal and Windows-reserved names", () => {
  assert.equal(normalizeWorkspaceName("my-local-dev"), "my-local-dev.base");
  assert.equal(normalizeWorkspaceName("my-local-dev.base"), "my-local-dev.base");
  for (const invalid of ["../outside", "name/child", "CON", ".", "", "café"]) {
    assert.throws(() => normalizeWorkspaceName(invalid));
  }
  assert.throws(() => normalizeWorkspaceName("CON.notes"));
  assert.throws(() => assertLocalPort(80));
  assert.throws(() => assertLocalPort(65536));
});

test("local workspace creation is staged, minimal, and collision-safe", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fivem-studio-workspace-"));
  try {
    const created = createLocalWorkspace(root, "sandbox", 30120);
    assert.equal(created.name, "sandbox.base");
    assert.equal(fs.readFileSync(created.serverCfgPath, "utf8").includes("127.0.0.1:30120"), true);
    assert.equal(fs.readFileSync(created.serverCfgPath, "utf8").includes('sv_master1 ""'), true);
    assert.equal(fs.existsSync(path.join(created.resourcesPath, "[local]")), true);
    assert.equal(fs.existsSync(path.join(created.profileRoot, "config.json")), false);
    assert.equal(fs.existsSync(path.join(created.profileRoot, "data")), false);
    const secretsExample = fs.readFileSync(path.join(created.profileRoot, "secrets.cfg.example"), "utf8");
    assert.equal(secretsExample.includes("paste-your-own-key"), true);
    assert.equal(secretsExample.includes('set rcon_password "choose-a-local-development-password"'), true);
    assert.throws(() => createLocalWorkspace(root, "sandbox", 30121), /already exists/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a dangling symbolic-link collision is refused", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fivem-studio-workspace-"));
  const collision = path.join(root, "linked.base");
  try {
    try {
      fs.symlinkSync("missing-target", collision, "file");
    } catch (err) {
      // Creating symlinks is disabled on some Windows developer machines. The
      // production behavior is exercised wherever the platform permits it.
      if ((err as NodeJS.ErrnoException).code === "EPERM") {
        t.skip("creating symbolic links requires Windows Developer Mode or elevation");
        return;
      }
      throw err;
    }
    assert.throws(() => createLocalWorkspace(root, "linked", 30120), /already exists/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
