import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { RevertStore } from "./revertStore";
import { WorkspaceSearchService } from "./workspaceSearch";

function fixture(regexExecutionLimits?: { perFileMs: number; totalMs: number }) {
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
    service: new WorkspaceSearchService(store, regexExecutionLimits),
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(history, { recursive: true, force: true });
    },
  };
}

test("human search supports resource scope, context, regex options, and globs", async () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.firstResource, "client.lua"), "local before = true\nTriggerEvent('qb:open')\nlocal after = true\n");
    fs.writeFileSync(path.join(f.firstResource, "ignored.lua"), "TriggerEvent('qb:open')\n");
    fs.writeFileSync(path.join(f.secondResource, "client.lua"), "TriggerEvent('qb:open')\n");
    const result = await f.service.search(f.root, f.firstResource, {
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

test("replace previews selected capture groups, skips stale files, and undoes one successful batch", async () => {
  const f = fixture();
  try {
    const first = path.join(f.firstResource, "first.lua");
    const second = path.join(f.firstResource, "second.lua");
    fs.writeFileSync(first, "old_alpha old_beta\n");
    fs.writeFileSync(second, "old_gamma\n");
    const search = await f.service.search(f.root, f.firstResource, {
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
    assert.ok(preview.applyToken);
    assert.equal(preview.files.find((file) => file.filePath === first)?.modifiedContent, "new_alpha new_beta\n");

    fs.writeFileSync(second, "changed elsewhere\n");
    const applied = f.service.apply(f.root, preview.applyToken);
    assert.equal(applied.filesChanged, 1);
    assert.equal(applied.hitsApplied, 2);
    assert.deepEqual(applied.skipped.map((entry) => entry.path), ["qb-first/second.lua"]);
    assert.ok(applied.batchId);
    assert.equal(fs.readFileSync(first, "utf8"), "new_alpha new_beta\n");
    assert.equal(fs.readFileSync(second, "utf8"), "changed elsewhere\n");
    assert.throws(() => f.service.apply(f.root, preview.applyToken), /already applied/);

    const undone = f.store.revertBatch(f.root, applied.batchId!, "all");
    assert.equal(undone.status, "reverted");
    assert.equal(fs.readFileSync(first, "utf8"), "old_alpha old_beta\n");
    assert.equal(fs.readFileSync(second, "utf8"), "changed elsewhere\n");
  } finally {
    f.cleanup();
  }
});

test("apply is bound to the exact reviewed selection and replacement", async () => {
  const f = fixture();
  try {
    const target = path.join(f.firstResource, "client.lua");
    fs.writeFileSync(target, "old_alpha old_beta\n");
    const search = await f.service.search(f.root, f.firstResource, {
      query: "old_(\\w+)",
      regex: true,
      caseSensitive: true,
      wholeWord: false,
      include: [],
      exclude: [],
    });
    const selected = [search.files[0]!.matches[0]!.id];
    const preview = f.service.preview(f.root, search.id, selected, "reviewed_$1");
    assert.equal(preview.files[0]?.modifiedContent, "reviewed_alpha old_beta\n");

    const applied = f.service.apply(f.root, preview.applyToken);
    assert.equal(applied.hitsApplied, 1);
    assert.equal(fs.readFileSync(target, "utf8"), "reviewed_alpha old_beta\n");
  } finally {
    f.cleanup();
  }
});

test("credential-bearing files and structurally unsafe regular expressions are refused", async () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.firstResource, "secrets.cfg"), 'set rcon_password "private"\n');
    fs.writeFileSync(path.join(f.firstResource, "client.lua"), "local value = 'public'\n");
    const result = await f.service.search(f.root, f.firstResource, {
      query: "private",
      regex: false,
      caseSensitive: true,
      wholeWord: false,
      include: [],
      exclude: [],
    });
    assert.equal(result.totalMatches, 0);
    assert.equal(result.skippedCredentialFiles, 1);
    await assert.rejects(() => f.service.search(f.root, f.firstResource, {
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

test("bounded and disjoint quantified alternatives remain available", async () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.firstResource, "animals.lua"), "cat dog fox\nfoofoobar\n");
    const optional = await f.service.search(f.root, f.firstResource, {
      query: "(cat|dog)?",
      regex: true,
      caseSensitive: true,
      wholeWord: false,
      include: ["**/animals.lua"],
      exclude: [],
    });
    assert.ok(optional.totalMatches >= 2);

    const repeated = await f.service.search(f.root, f.firstResource, {
      query: "(foo|bar)+",
      regex: true,
      caseSensitive: true,
      wholeWord: false,
      include: ["**/animals.lua"],
      exclude: [],
    });
    assert.equal(repeated.totalMatches, 1);
  } finally {
    f.cleanup();
  }
});

test("raw regular-expression evaluation is terminated at the per-file deadline", async () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.firstResource, "adversarial.lua"), `${"a".repeat(100_000)}!\n`);
    const startedAt = Date.now();
    await assert.rejects(() => f.service.search(f.root, f.firstResource, {
      query: "a*a*$",
      regex: true,
      caseSensitive: true,
      wholeWord: false,
      include: ["**/*.lua"],
      exclude: [],
    }), /per-file safety limit/);
    assert.ok(Date.now() - startedAt < 4_000, "catastrophic evaluation should be terminated promptly");
  } finally {
    f.cleanup();
  }
});

test("raw regular-expression evaluation cannot consume the aggregate search budget", async () => {
  const f = fixture({ perFileMs: 1_000, totalMs: 50 });
  try {
    fs.writeFileSync(path.join(f.firstResource, "adversarial.lua"), `${"a".repeat(100_000)}!\n`);
    const startedAt = Date.now();
    await assert.rejects(() => f.service.search(f.root, f.firstResource, {
      query: "a*a*$",
      regex: true,
      caseSensitive: true,
      wholeWord: false,
      include: ["**/*.lua"],
      exclude: [],
    }), /whole-search safety limit/);
    assert.ok(Date.now() - startedAt < 1_000, "the remaining whole-search budget must cap a worker run");
  } finally {
    f.cleanup();
  }
});

test("only one search can run at a time and the guard recovers after failure", async () => {
  const f = fixture({ perFileMs: 1_000, totalMs: 50 });
  try {
    fs.writeFileSync(path.join(f.firstResource, "adversarial.lua"), `${"a".repeat(100_000)}!\n`);
    const active = f.service.search(f.root, f.firstResource, {
      query: "a*a*$",
      regex: true,
      caseSensitive: true,
      wholeWord: false,
      include: ["**/*.lua"],
      exclude: [],
    });
    await assert.rejects(() => f.service.search(f.root, f.firstResource, {
      query: "public",
      regex: false,
      caseSensitive: true,
      wholeWord: false,
      include: [],
      exclude: [],
    }), /workspace search is already running/);
    await assert.rejects(() => active, /whole-search safety limit/);

    const recovered = await f.service.search(f.root, f.root, {
      query: "fx_version",
      regex: false,
      caseSensitive: true,
      wholeWord: false,
      include: ["**/fxmanifest.lua"],
      exclude: [],
    });
    assert.equal(recovered.totalMatches, 2);
  } finally {
    f.cleanup();
  }
});
