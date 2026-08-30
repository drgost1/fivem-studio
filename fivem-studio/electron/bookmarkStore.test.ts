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

test("bookmarks are remapped and removed with renamed or deleted paths", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qb-studio-bookmark-paths-"));
  try {
    const workspace = path.join(root, "workspace");
    const storage = path.join(root, "state");
    const oldDirectory = path.join(workspace, "old");
    const oldFile = path.join(oldDirectory, "main.lua");
    fs.mkdirSync(oldDirectory, { recursive: true });
    fs.writeFileSync(oldFile, "print('hi')\n");
    const store = new BookmarkStore(storage);
    store.toggle(workspace, oldFile, 1);

    const newDirectory = path.join(workspace, "new");
    fs.renameSync(oldDirectory, newDirectory);
    assert.deepEqual(store.remapPath(workspace, oldDirectory, newDirectory).map((entry) => entry.path), [path.join(newDirectory, "main.lua")]);

    const rollbackRename = store.remapPathWithRollback(workspace, newDirectory, oldDirectory);
    assert.deepEqual(store.list(workspace), []);
    rollbackRename();
    assert.equal(store.list(workspace).length, 1);

    store.removePath(workspace, newDirectory);
    assert.deepEqual(store.list(workspace), []);

    store.toggle(workspace, path.join(newDirectory, "main.lua"), 1);
    const rollback = store.removePathWithRollback(workspace, newDirectory);
    assert.deepEqual(store.list(workspace), []);
    rollback();
    assert.equal(store.list(workspace).length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
