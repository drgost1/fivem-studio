import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  discoverTxAdminControlProfile,
  loadLocalServerConfig,
  ManagedRuntimeGeneration,
  parseLocalServerConfig,
} from "./managedRuntime";

test("parses a loopback FXServer endpoint and keeps the RCON secret main-process-only", () => {
  assert.deepEqual(
    parseLocalServerConfig(`
      endpoint_add_tcp "127.0.0.1:30120"
      endpoint_add_udp "127.0.0.1:30121"
      rcon_password "local secret"
    `),
    { host: "127.0.0.1", port: 30121, rconPassword: "local secret" },
  );
});

test("rejects missing and non-loopback FXServer endpoints", () => {
  assert.throws(() => parseLocalServerConfig('rcon_password "x"'), /no endpoint_add/);
  assert.throws(() => parseLocalServerConfig('endpoint_add_udp "0.0.0.0:30120"'), /numeric loopback/);
  assert.throws(() => parseLocalServerConfig('endpoint_add_tcp "192.168.1.5:30120"'), /numeric loopback/);
  assert.throws(() => parseLocalServerConfig('endpoint_add_tcp "localhost:30120"'), /numeric loopback/);
  assert.throws(() => parseLocalServerConfig('endpoint_add_tcp "127.attacker.example:30120"'), /numeric loopback/);
});

test("recursively loads workspace-local config includes before enforcing loopback", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fivem-studio-config-"));
  try {
    fs.writeFileSync(path.join(root, "server.cfg"), 'endpoint_add_udp "127.0.0.1:30120"\nexec nested.cfg\n');
    fs.writeFileSync(path.join(root, "nested.cfg"), 'endpoint_add_tcp "0.0.0.0:30120"\n');
    assert.throws(() => parseLocalServerConfig(loadLocalServerConfig(root)), /numeric loopback/);

    fs.writeFileSync(path.join(root, "nested.cfg"), 'exec ../outside.cfg\n');
    assert.throws(() => loadLocalServerConfig(root), /outside the project folder/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("recursive config loading rejects include cycles", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fivem-studio-config-"));
  try {
    fs.writeFileSync(path.join(root, "server.cfg"), "exec nested.cfg\n");
    fs.writeFileSync(path.join(root, "nested.cfg"), "exec server.cfg\n");
    assert.throws(() => loadLocalServerConfig(root), /include cycle/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("discovers a txAdmin control profile separately from its server-data workspace", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ghz-workbench-txdata-"));
  try {
    const workspace = path.join(root, "local-dev.base");
    const control = path.join(root, "default");
    fs.mkdirSync(workspace);
    fs.mkdirSync(control);
    fs.writeFileSync(
      path.join(control, "config.json"),
      JSON.stringify({ version: 2, server: { dataPath: `${workspace}${path.sep}` } }),
    );
    assert.equal(discoverTxAdminControlProfile(root, workspace), "default");

    const second = path.join(root, "second");
    fs.mkdirSync(second);
    fs.writeFileSync(path.join(second, "config.json"), JSON.stringify({ server: { dataPath: workspace } }));
    assert.equal(discoverTxAdminControlProfile(root, workspace), null, "ambiguous control profiles disable console discovery");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a stale managed-runtime launch cannot own a newer launch", () => {
  const generation = new ManagedRuntimeGeneration();
  const first = generation.start();
  generation.invalidate();
  const second = generation.start();
  assert.equal(generation.owns(first), false);
  assert.equal(generation.owns(second), true);
});
