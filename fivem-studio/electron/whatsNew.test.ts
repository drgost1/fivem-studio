import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { consumeWhatsNew } from "./whatsNew";

test("what's new appears only after a packaged version changes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qb-studio-whats-new-"));
  const state = path.join(root, "version.json");
  try {
    assert.equal(consumeWhatsNew(state, "1.2.0", true), null);
    assert.equal(consumeWhatsNew(state, "1.2.0", true), null);
    assert.deepEqual(consumeWhatsNew(state, "1.3.0", true), { previousVersion: "1.2.0", currentVersion: "1.3.0" });
    assert.equal(consumeWhatsNew(state, "development", true), null);
    assert.equal(consumeWhatsNew(state, "1.4.0", false), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
