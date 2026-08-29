import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { findWorkspaceResources, formatResourceStatuses, listResourceStatuses } from "../src/resourceStatus.js";

test("resource discovery finds manifests in nested categories and does not follow links", (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ghz-resource-status-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.mkdirSync(path.join(workspace, "resources", "[local]", "alpha"), { recursive: true });
  fs.mkdirSync(path.join(workspace, "resources", "[local]", "[nested]", "bravo"), { recursive: true });
  fs.mkdirSync(path.join(workspace, "resources", "not-a-resource", "client"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "resources", "[local]", "alpha", "fxmanifest.lua"), "game 'gta5'");
  fs.writeFileSync(path.join(workspace, "resources", "[local]", "[nested]", "bravo", "__resource.lua"), "");
  assert.deepEqual(findWorkspaceResources(workspace), ["alpha", "bravo"]);
});

test("resource status merges detected resources with started server resources", async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ghz-resource-status-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.mkdirSync(path.join(workspace, "resources", "[local]", "alpha"), { recursive: true });
  fs.mkdirSync(path.join(workspace, "resources", "[local]", "bravo"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "resources", "[local]", "alpha", "fxmanifest.lua"), "");
  fs.writeFileSync(path.join(workspace, "resources", "[local]", "bravo", "fxmanifest.lua"), "");

  const server = http.createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ resources: ["alpha", "hardcap"] }));
  });
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const result = await listResourceStatuses(workspace, "127.0.0.1", address.port);
  assert.equal(result.serverStateAvailable, true);
  assert.deepEqual(result.resources, [
    { name: "alpha", state: "started" },
    { name: "bravo", state: "stopped" },
    { name: "hardcap", state: "started" },
  ]);
  assert.equal(formatResourceStatuses(result), "started alpha\nstopped bravo\nstarted hardcap");
});
