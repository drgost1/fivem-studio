import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveResourceContext, resourceAtDirectory } from "./resourceContext";

test("resource context resolves the nearest nested manifest root", (t) => {
  const resources = fs.mkdtempSync(path.join(os.tmpdir(), "qb-studio-resource-context-"));
  t.after(() => fs.rmSync(resources, { recursive: true, force: true }));
  const resource = path.join(resources, "[local]", "qb-example");
  const script = path.join(resource, "client", "main.lua");
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.writeFileSync(path.join(resource, "fxmanifest.lua"), "fx_version 'cerulean'", "utf8");
  fs.writeFileSync(script, "return true", "utf8");

  assert.deepEqual(resolveResourceContext(resources, script), {
    name: "qb-example",
    rootPath: resource,
    manifestPath: path.join(resource, "fxmanifest.lua"),
  });
  assert.equal(resolveResourceContext(resources, path.join(resources, "[local]")), null);
});

test("resource context refuses traversal and does not accept linked manifests", (t) => {
  const resources = fs.mkdtempSync(path.join(os.tmpdir(), "qb-studio-resource-context-"));
  t.after(() => fs.rmSync(resources, { recursive: true, force: true }));
  const resource = path.join(resources, "linked-resource");
  fs.mkdirSync(resource);
  const outside = path.join(path.dirname(resources), `${path.basename(resources)}-manifest.lua`);
  fs.writeFileSync(outside, "", "utf8");
  t.after(() => fs.rmSync(outside, { force: true }));
  try {
    fs.symlinkSync(outside, path.join(resource, "fxmanifest.lua"), "file");
  } catch {
    t.skip("creating symbolic links requires Windows Developer Mode or elevation");
    return;
  }

  assert.equal(resourceAtDirectory(resources, resource), null);
  assert.throws(() => resolveResourceContext(resources, path.join(resources, "..", "outside.lua")), /outside the project folder/i);
});
