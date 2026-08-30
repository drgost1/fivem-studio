import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { BookmarkStore } from "./bookmarkStore";

test("bookmarks toggle per workspace and ignore deleted files", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qb-studio-bookmarks-"));
  try {
    const workspace = path.join(root, "workspace");
    const storage = path.join(root, "state");
    fs.mkdirSync(workspace);
    const file = path.join(workspace, "main.lua");
    fs.writeFileSync(file, "print('hi')\n");
    const store = new BookmarkStore(storage);
    assert.equal(store.toggle(workspace, file, 1).length, 1);
    assert.equal(store.toggle(workspace, file, 1).length, 0);
    store.toggle(workspace, file, 1);
    fs.rmSync(file);
    assert.deepEqual(store.list(workspace), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
