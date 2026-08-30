import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ThemePackStore, customThemeId, customThemePreference, parseThemePack } from "./themePacks";

const valid = {
  schemaVersion: 1,
  id: "qb-red",
  name: "QB Red",
  author: "QBCore",
  base: "dark",
  colors: { "accent": "#d9232e", "bg-0": "#101010" },
  editor: { colors: { "editor.background": "#101010" }, tokens: { keyword: "#ff6670" } },
};

test("theme packs normalize safe colors and produce stable preferences", () => {
  const pack = parseThemePack(valid);
  assert.equal(pack.colors.accent, "#d9232e");
  assert.equal(customThemePreference(pack.id), "custom:qb-red");
  assert.equal(customThemeId("custom:qb-red"), "qb-red");
});

test("theme packs reject arbitrary CSS, editor keys, and malformed ids", () => {
  assert.throws(() => parseThemePack({ ...valid, id: "../escape" }), /Theme id/);
  assert.throws(() => parseThemePack({ ...valid, colors: { accent: "url(https://example.test/a)" } }), /hexadecimal/);
  assert.throws(() => parseThemePack({ ...valid, colors: { accent: "#12345" } }), /hexadecimal/);
  assert.throws(() => parseThemePack({ ...valid, editor: { colors: { "editor.evil": "#fff" } } }), /unsupported/);
});

test("theme store imports normalized JSON and ignores broken or linked packs", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qb-studio-themes-"));
  const source = path.join(root, "source.json");
  const installed = path.join(root, "installed");
  try {
    fs.writeFileSync(source, JSON.stringify(valid));
    const store = new ThemePackStore(installed);
    store.import(source);
    fs.writeFileSync(source, JSON.stringify({ ...valid, name: "QB Red Updated" }));
    assert.equal(store.import(source).name, "QB Red Updated");
    fs.writeFileSync(path.join(installed, "broken.json"), "not json");
    try {
      fs.symlinkSync(source, path.join(installed, "linked.json"), "file");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
      t.diagnostic("file links unavailable; ordinary-file coverage still applies");
    }
    assert.deepEqual(store.list().map((pack) => pack.id), ["qb-red"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("theme store leaves conflicting directories untouched", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qb-studio-theme-conflict-"));
  const source = path.join(root, "source.json");
  const installed = path.join(root, "installed");
  const conflict = path.join(installed, "qb-red.json");
  try {
    fs.writeFileSync(source, JSON.stringify(valid));
    fs.mkdirSync(conflict, { recursive: true });
    const store = new ThemePackStore(installed);
    assert.throws(() => store.import(source), /directory conflicts/);
    assert.equal(fs.statSync(conflict).isDirectory(), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
