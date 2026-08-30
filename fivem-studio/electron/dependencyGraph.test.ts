import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildResourceDependencyGraph } from "./dependencyGraph";

test("dependency graph discovers nested resources, missing dependencies, and transitive dependents", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qb-studio-graph-"));
  try {
    const resources = path.join(root, "resources");
    const make = (group: string, name: string, manifest: string) => {
      const target = path.join(resources, group, name);
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(path.join(target, "fxmanifest.lua"), manifest);
    };
    make("[core]", "qb-core", "fx_version 'cerulean'\n");
    make("[qb]", "qb-garages", "dependency 'qb-core'\n");
    make("[custom]", "my-garage-ui", "dependencies { 'qb-garages', 'missing-lib' }\n");

    const graph = buildResourceDependencyGraph(resources);
    const core = graph.nodes.find((node) => node.name === "qb-core")!;
    const custom = graph.nodes.find((node) => node.name === "my-garage-ui")!;
    assert.deepEqual(core.dependents, ["my-garage-ui", "qb-garages"]);
    assert.deepEqual(custom.missingDependencies, ["missing-lib"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
