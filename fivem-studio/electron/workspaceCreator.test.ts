import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  applyDevelopmentRcon,
  assertLocalPort,
  createLocalWorkspace,
  normalizeWorkspaceName,
  previewDevelopmentRcon,
} from "./workspaceCreator";

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

test("RedM workspace creation selects the rdr3 game runtime", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fivem-studio-redm-workspace-"));
  try {
    const created = createLocalWorkspace(root, "redm-sandbox", 30130, "redm");
    const config = fs.readFileSync(created.serverCfgPath, "utf8");
    assert.match(config, /^set gamename rdr3$/m);
    assert.equal(config.includes("127.0.0.1:30130"), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("development RCON setup previews redacted structure and applies a protected secret", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qb-studio-rcon-setup-"));
  try {
    const created = createLocalWorkspace(root, "rcon-sandbox", 30140);
    const preview = previewDevelopmentRcon(created.profileRoot, false);
    assert.equal(JSON.stringify(preview).includes("rcon_password"), false);
    assert.deepEqual(preview.changes.map((change) => [change.path, change.action]), [
      [".gitignore", "unchanged"],
      ["secrets.cfg", "create"],
      ["server.cfg", "update"],
    ]);

    const result = applyDevelopmentRcon(created.profileRoot, false, false);
    assert.deepEqual(new Set(result.changedPaths), new Set(["secrets.cfg", "server.cfg"]));
    const secrets = fs.readFileSync(path.join(created.profileRoot, "secrets.cfg"), "utf8");
    assert.match(secrets, /^set rcon_password "[A-Za-z0-9_-]{43}"$/m);
    assert.equal(secrets.includes("choose-a-local-development-password"), false);
    const server = fs.readFileSync(created.serverCfgPath, "utf8");
    assert.equal(server.match(/^exec secrets\.cfg$/gm)?.length, 1);
    assert.equal(server.trimEnd().endsWith("exec secrets.cfg"), true);
    assert.match(fs.readFileSync(path.join(created.profileRoot, ".gitignore"), "utf8"), /^secrets\.cfg$/m);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("development RCON setup refuses to rotate an existing password without explicit confirmation", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qb-studio-rcon-existing-"));
  try {
    const created = createLocalWorkspace(root, "existing-rcon", 30141);
    fs.writeFileSync(path.join(created.profileRoot, "secrets.cfg"), 'set rcon_password "existing-secret"\n');
    assert.throws(() => applyDevelopmentRcon(created.profileRoot, true, false), /confirmation is required/);
    assert.equal(fs.readFileSync(path.join(created.profileRoot, "secrets.cfg"), "utf8"), 'set rcon_password "existing-secret"\n');

    const rotated = applyDevelopmentRcon(created.profileRoot, true, true);
    assert.equal(rotated.replacedExistingPassword, true);
    const next = fs.readFileSync(path.join(created.profileRoot, "secrets.cfg"), "utf8");
    assert.equal(next.includes("existing-secret"), false);
    assert.match(next, /^set rcon_password "[A-Za-z0-9_-]{43}"$/m);
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
