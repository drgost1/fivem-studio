import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { readTextFileSnapshot, writeTextFile } from "./fsTree";
import { RevertStore } from "./revertStore";

function fixture(): { root: string; history: string; store: RevertStore; cleanup(): void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qb-studio-revert-workspace-"));
  const history = fs.mkdtempSync(path.join(os.tmpdir(), "qb-studio-revert-history-"));
  return {
    root,
    history,
    store: new RevertStore(history),
    cleanup: () => {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(history, { recursive: true, force: true });
    },
  };
}

function replace(target: string, content: string): void {
  const before = readTextFileSnapshot(target);
  writeTextFile(target, content, before.revision);
}

test("a multi-file programmatic batch reverts as one revision-checked action", () => {
  const { root, history, store, cleanup } = fixture();
  try {
    const first = path.join(root, "qb-one", "client.lua");
    const second = path.join(root, "qb-two", "server.lua");
    const created = path.join(root, "created.lua");
    fs.mkdirSync(path.dirname(first), { recursive: true });
    fs.mkdirSync(path.dirname(second), { recursive: true });
    fs.writeFileSync(first, "return 'one-before'\n");
    fs.writeFileSync(second, "return 'two-before'\n");

    const batch = store.prepareBatch(root, "Batch edit", [
      { filePath: first, nextContent: "return 'one-after'\n" },
      { filePath: second, nextContent: "return 'two-after'\n" },
      { filePath: created, nextContent: "return 'new'\n" },
    ]);
    assert.ok(batch);
    replace(first, "return 'one-after'\n");
    replace(second, "return 'two-after'\n");
    fs.writeFileSync(created, "return 'new'\n");
    const stored = fs.readFileSync(path.join(history, fs.readdirSync(history)[0]!), "utf8");
    assert.equal(stored.includes(root), false);

    const result = store.revertBatch(root, batch.id, "all");
    assert.equal(result.status, "reverted");
    assert.deepEqual(
      new Set(result.reverted),
      new Set([path.join("qb-one", "client.lua"), path.join("qb-two", "server.lua"), "created.lua"]),
    );
    assert.equal(fs.readFileSync(first, "utf8"), "return 'one-before'\n");
    assert.equal(fs.readFileSync(second, "utf8"), "return 'two-before'\n");
    assert.equal(fs.existsSync(created), false);
    assert.deepEqual(store.listBatches(root), []);
  } finally {
    cleanup();
  }
});

test("default revert preflights the whole batch while safe mode skips conflicts", () => {
  const { root, store, cleanup } = fixture();
  try {
    const first = path.join(root, "first.lua");
    const second = path.join(root, "second.lua");
    fs.writeFileSync(first, "first before");
    fs.writeFileSync(second, "second before");
    const batch = store.prepareBatch(root, "Conflicting edit", [
      { filePath: first, nextContent: "first after" },
      { filePath: second, nextContent: "second after" },
    ]);
    assert.ok(batch);
    replace(first, "first after");
    replace(second, "second after");
    replace(second, "second changed elsewhere");

    const blocked = store.revertBatch(root, batch.id, "all");
    assert.equal(blocked.status, "conflict");
    assert.deepEqual(blocked.reverted, []);
    assert.equal(fs.readFileSync(first, "utf8"), "first after");

    const partial = store.revertBatch(root, batch.id, "safe");
    assert.equal(partial.status, "partial");
    assert.deepEqual(partial.reverted, ["first.lua"]);
    assert.deepEqual(partial.skipped.map((entry) => entry.path), ["second.lua"]);
    assert.equal(fs.readFileSync(first, "utf8"), "first before");
    assert.equal(fs.readFileSync(second, "utf8"), "second changed elsewhere");
    assert.equal(store.listBatches(root)[0]?.fileCount, 1);
  } finally {
    cleanup();
  }
});

test("credential files and credential-bearing prior text never enter undo history", () => {
  const { root, history, store, cleanup } = fixture();
  try {
    const regular = path.join(root, "client.lua");
    const secrets = path.join(root, "secrets.cfg");
    const server = path.join(root, "server.cfg");
    const newCredential = path.join(root, "runtime.lua");
    fs.writeFileSync(regular, "return true\n");
    fs.writeFileSync(secrets, 'set rcon_password "private"\n');
    fs.writeFileSync(server, 'sv_licenseKey "private"\n');
    const batch = store.prepareBatch(root, "Mixed edit", [
      { filePath: regular, nextContent: "return false\n" },
      { filePath: secrets, nextContent: "" },
      { filePath: server, nextContent: "" },
      { filePath: newCredential, nextContent: 'api_key = "private"\n' },
    ]);
    assert.ok(batch);
    assert.equal(batch.fileCount, 1);
    assert.equal(store.listBatches(root)[0]?.fileCount, 1);
    const stored = fs.readFileSync(path.join(history, fs.readdirSync(history)[0]!), "utf8");
    assert.equal(stored.includes("private"), false);
    assert.equal(stored.includes("secrets.cfg"), false);
    assert.equal(stored.includes("server.cfg"), false);
    assert.equal(stored.includes("runtime.lua"), false);
  } finally {
    cleanup();
  }
});

test("undo history evicts oldest whole batches to respect entry and byte caps", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qb-studio-revert-cap-workspace-"));
  const history = fs.mkdtempSync(path.join(os.tmpdir(), "qb-studio-revert-cap-history-"));
  const store = new RevertStore(history, { maxEntries: 2, maxBytes: 4096 });
  try {
    for (let index = 0; index < 3; index += 1) {
      const target = path.join(root, `file-${index}.lua`);
      fs.writeFileSync(target, `before ${index}`);
      const batch = store.prepareBatch(root, `Edit ${index}`, [{ filePath: target, nextContent: `after ${index}` }]);
      assert.ok(batch);
      replace(target, `after ${index}`);
    }
    const batches = store.listBatches(root);
    assert.deepEqual(batches.map((batch) => batch.label), ["Edit 2", "Edit 1"]);
    assert.equal(batches.reduce((total, batch) => total + batch.fileCount, 0), 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(history, { recursive: true, force: true });
  }
});

test("oversized single batches fail before a write can proceed", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qb-studio-revert-oversize-workspace-"));
  const history = fs.mkdtempSync(path.join(os.tmpdir(), "qb-studio-revert-oversize-history-"));
  const store = new RevertStore(history, { maxEntries: 2, maxBytes: 1200 });
  try {
    const target = path.join(root, "large.lua");
    fs.writeFileSync(target, "x".repeat(2000));
    assert.throws(
      () => store.prepareBatch(root, "Too large", [{ filePath: target, nextContent: "after" }]),
      /larger than the bounded undo history/,
    );
    assert.equal(fs.readFileSync(target, "utf8"), "x".repeat(2000));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(history, { recursive: true, force: true });
  }
});

test("prepared batches can be finalized down to only files that actually wrote", () => {
  const { root, store, cleanup } = fixture();
  try {
    const first = path.join(root, "first.lua");
    const second = path.join(root, "second.lua");
    fs.writeFileSync(first, "first before");
    fs.writeFileSync(second, "second before");
    const batch = store.prepareBatch(root, "Partial apply", [
      { filePath: first, nextContent: "first after" },
      { filePath: second, nextContent: "second after" },
    ]);
    assert.ok(batch);
    replace(first, "first after");
    const retained = store.retainBatchEntries(root, batch.id, [first]);
    assert.equal(retained?.fileCount, 1);
    const undone = store.revertBatch(root, batch.id, "all");
    assert.equal(undone.status, "reverted");
    assert.deepEqual(undone.reverted, ["first.lua"]);
    assert.equal(fs.readFileSync(first, "utf8"), "first before");
    assert.equal(fs.readFileSync(second, "utf8"), "second before");
  } finally {
    cleanup();
  }
});
