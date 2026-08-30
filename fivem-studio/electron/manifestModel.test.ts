import assert from "node:assert/strict";
import test from "node:test";

import { parseManifestForm, updateManifestForm } from "./manifestModel";

test("manifest form parses common scalar, singular, and list directives", () => {
  const parsed = parseManifestForm(`fx_version 'cerulean'\ngame 'gta5'\nclient_script 'client.lua'\ndependencies { 'qb-core', 'oxmysql' }\n`);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.values.fx_version, "cerulean");
  assert.deepEqual(parsed.values.client_scripts, ["client.lua"]);
  assert.deepEqual(parsed.values.dependencies, ["qb-core", "oxmysql"]);
});

test("manifest form changes modeled fields while preserving comments and unknown constructs", () => {
  const source = `-- heading\nfx_version 'cerulean' -- keep this\ncustom_directive SOME_VALUE\nclient_script 'old.lua'\n`;
  const parsed = parseManifestForm(source);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const updated = updateManifestForm(source, { ...parsed.values, client_scripts: ["client/main.lua", "client/events.lua"] });
  assert.match(updated, /-- heading/);
  assert.match(updated, /-- keep this/);
  assert.match(updated, /custom_directive SOME_VALUE/);
  assert.match(updated, /client_scripts \{/);
  assert.match(updated, /client\/events\.lua/);
});

test("manifest form refuses dynamic modeled values instead of rewriting them", () => {
  const parsed = parseManifestForm("fx_version version_name\n");
  assert.equal(parsed.ok, false);
  if (!parsed.ok) assert.match(parsed.reason, /dynamic value/);
});
