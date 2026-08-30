import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { readTextFileSnapshot } from "./fsTree";
import { buildProjectWritePreview } from "./projectTools";

test("project write preview compares the contained disk snapshot with proposed content", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qb-studio-preview-"));
  const target = path.join(root, "qb-test", "client.lua");
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "local before = true\n", "utf8");
    const snapshot = readTextFileSnapshot(target);
    const preview = buildProjectWritePreview(root, {
      path: "qb-test/client.lua",
      content: "local after = true\n",
      expected_revision: snapshot.revision,
    });
    assert.equal(preview.path, path.join("qb-test", "client.lua"));
    assert.equal(preview.originalContent, "local before = true\n");
    assert.equal(preview.modifiedContent, "local after = true\n");
    assert.equal(preview.warning, undefined);

    const stale = buildProjectWritePreview(root, {
      path: "qb-test/client.lua",
      content: "local after = true\n",
      expected_revision: "0".repeat(64),
    });
    assert.match(stale.warning ?? "", /changed after the agent read it/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("project write preview handles new files and rejects traversal", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qb-studio-preview-new-"));
  try {
    const preview = buildProjectWritePreview(root, {
      path: "qb-test/new.lua",
      content: "return true\n",
      expected_revision: "new",
    });
    assert.equal(preview.originalContent, "");
    assert.equal(preview.warning, undefined);
    assert.throws(
      () => buildProjectWritePreview(root, { path: "../outside.lua", content: "", expected_revision: "new" }),
    /outside (?:the allowed root|the project folder)|escapes the allowed root/i,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
