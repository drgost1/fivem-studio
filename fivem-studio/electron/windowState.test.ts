import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadWindowState, normalizeWindowState, saveWindowState } from "./windowState";

const display = [{ x: 0, y: 0, width: 1920, height: 1080 }];

test("window state restores visible normal bounds and maximized state", () => {
  assert.deepEqual(normalizeWindowState({ x: 100, y: 80, width: 1280, height: 720, maximized: true }, display), {
    x: 100,
    y: 80,
    width: 1280,
    height: 720,
    maximized: true,
  });
});

test("window state rejects invalid or fully detached bounds", () => {
  assert.deepEqual(normalizeWindowState({ x: 5000, y: 5000, width: 1280, height: 720 }, display), {
    x: 80,
    y: 80,
    width: 1440,
    height: 900,
    maximized: false,
  });
  assert.equal(normalizeWindowState({ x: 0, y: 0, width: 20, height: 20 }, display).width, 1440);
});

test("window state persists through an app-owned atomic file", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qb-studio-window-"));
  const target = path.join(root, "window-state.json");
  try {
    saveWindowState(target, { x: 20, y: 30, width: 1200, height: 700, maximized: false });
    assert.equal(loadWindowState(target, display).width, 1200);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
