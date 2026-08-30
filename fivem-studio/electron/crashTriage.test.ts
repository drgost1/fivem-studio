import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { newestCrashReport } from "./crashTriage";

test("crash triage returns the newest bounded report with credentials redacted", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qb-studio-crash-"));
  try {
    const crashes = path.join(root, "crashes");
    fs.mkdirSync(path.join(crashes, "new"), { recursive: true });
    const old = path.join(crashes, "old.log");
    const newest = path.join(crashes, "new", "report.log");
    fs.writeFileSync(old, "old crash");
    fs.writeFileSync(newest, 'fatal exception\nset rcon_password "private"\nsv_licenseKey abc123\n');
    const now = Date.now();
    fs.utimesSync(old, new Date(now - 10_000), new Date(now - 10_000));
    fs.utimesSync(newest, new Date(now), new Date(now));

    const result = newestCrashReport(root);
    assert.equal(result?.relativePath, path.join("crashes", "new", "report.log"));
    assert.match(result?.excerpt ?? "", /fatal exception/);
    assert.doesNotMatch(result?.excerpt ?? "", /private|abc123/);
    assert.match(result?.excerpt ?? "", /<redacted>/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("crash triage is empty when the workspace has no crashes folder", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qb-studio-no-crash-"));
  try {
    assert.equal(newestCrashReport(root), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
