import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { RevertStore } from "./revertStore";
import { WorkspaceSearchService } from "./workspaceSearch";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qb-studio-search-workspace-"));
  const history = fs.mkdtempSync(path.join(os.tmpdir(), "qb-studio-search-history-"));
  const firstResource = path.join(root, "qb-first");
  const secondResource = path.join(root, "qb-second");
  fs.mkdirSync(firstResource);
  fs.mkdirSync(secondResource);
  fs.writeFileSync(path.join(firstResource, "fxmanifest.lua"), "fx_version 'cerulean'\n");
  fs.writeFileSync(path.join(secondResource, "fxmanifest.lua"), "fx_version 'cerulean'\n");
  const store = new RevertStore(history);
  return {
    root,
    history,
    firstResource,
    secondResource,
    store,
    service: new WorkspaceSearchService(store),
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(history, { recursive: true, force: true });
    },
  };
}

test("human search supports resource scope, context, regex options, and globs", () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.firstResource, "client.lua"), "local before = true\nTriggerEvent('qb:open')\nlocal after = true\n");
    fs.writeFileSync(path.join(f.firstResource, "ignored.lua"), "TriggerEvent('qb:open')\n");
    fs.writeFileSync(path.join(f.secondResource, "client.lua"), "TriggerEvent('qb:open')\n");
    const result = f.service.search(f.root, f.firstResource, {
      query: "trigger(event)",
      regex: true,
      caseSensitive: false,
      wholeWord: false,
      include: ["**/*.lua"],
      exclude: ["**/ignored.lua"],
    });
    assert.equal(result.totalMatches, 1);
    assert.equal(result.files[0]?.relativePath, "qb-first/client.lua");
    assert.deepEqual(result.files[0]?.matches[0]?.before, ["local before = true"]);
    assert.deepEqual(result.files[0]?.matches[0]?.after, ["local after = true", ""]);
  } finally {
    f.cleanup();
  }
});

test("replace previews selected capture groups, skips stale files, and undoes one successful batch", () => {
  const f = fixture();
  try {
    const first = path.join(f.firstResource, "first.lua");
    const second = path.join(f.firstResource, "second.lua");
    fs.writeFileSync(first, "old_alpha old_beta\n");
    fs.writeFileSync(second, "old_gamma\n");
    const search = f.service.search(f.root, f.firstResource, {
      query: "old_(\\w+)",
      regex: true,
      caseSensitive: true,
      wholeWord: false,
      include: [],
      exclude: [],
    });
    const selected = search.files.flatMap((file) => file.matches.map((match) => match.id));
    const preview = f.service.preview(f.root, search.id, selected, "new_$1");
    assert.equal(preview.totalHits, 3);
    assert.equal(preview.files.find((file) => file.filePath === first)?.modifiedContent, "new_alpha new_beta\n");

    fs.writeFileSync(second, "changed elsewhere\n");
    const applied = f.service.apply(f.root, search.id, selected, "new_$1");
    assert.equal(applied.filesChanged, 1);
    assert.equal(applied.hitsApplied, 2);
    assert.deepEqual(applied.skipped.map((entry) => entry.path), ["qb-first/second.lua"]);
    assert.ok(applied.batchId);
    assert.equal(fs.readFileSync(first, "utf8"), "new_alpha new_beta\n");
    assert.equal(fs.readFileSync(second, "utf8"), "changed elsewhere\n");

    const undone = f.store.revertBatch(f.root, applied.batchId!, "all");
    assert.equal(undone.status, "reverted");
    assert.equal(fs.readFileSync(first, "utf8"), "old_alpha old_beta\n");
    assert.equal(fs.readFileSync(second, "utf8"), "changed elsewhere\n");
  } finally {
    f.cleanup();
  }
});

test("credential-bearing files and unsafe regular expressions are refused", () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.firstResource, "secrets.cfg"), 'set rcon_password "private"\n');
    fs.writeFileSync(path.join(f.firstResource, "client.lua"), "local value = 'public'\n");
    const result = f.service.search(f.root, f.firstResource, {
      query: "private",
      regex: false,
      caseSensitive: true,
      wholeWord: false,
      include: [],
      exclude: [],
    });
    assert.equal(result.totalMatches, 0);
    assert.equal(result.skippedCredentialFiles, 1);
    assert.throws(() => f.service.search(f.root, f.firstResource, {
      query: "(a+)+$",
      regex: true,
      caseSensitive: true,
      wholeWord: false,
      include: [],
      exclude: [],
    }), /Nested regular-expression quantifiers/);
  } finally {
    f.cleanup();
  }
});
