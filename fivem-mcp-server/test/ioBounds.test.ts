import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { getConsoleTailMetrics, resetConsoleTailCache, tailConsoleLog } from "../src/logs.js";
import { RconClient } from "../src/rcon.js";

test("console tail returns recent and filtered lines", () => {
  resetConsoleTailCache();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fivem-mcp-logs-"));
  const logDir = path.join(dataDir, "dev", "logs");
  try {
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(path.join(logDir, "fxserver-2026-08-28.log"), "alpha\nbeta match\ngamma\ndelta match\n", "utf8");
    assert.equal(tailConsoleLog({ dataDir, profile: "dev", lines: 2 }), "gamma\ndelta match");
    assert.equal(tailConsoleLog({ dataDir, profile: "dev", lines: 1, filter: "MATCH" }), "delta match");
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("console tail reads only appended bytes after priming the cache", () => {
  resetConsoleTailCache();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fivem-mcp-logs-incremental-"));
  const logDir = path.join(dataDir, "dev", "logs");
  const logFile = path.join(logDir, "fxserver-current.log");
  try {
    fs.mkdirSync(logDir, { recursive: true });
    const initial = `${"old line\n".repeat(10_000)}partial`;
    fs.writeFileSync(logFile, initial, "utf8");
    assert.equal(tailConsoleLog({ dataDir, profile: "dev", lines: 1 }), "partial");
    const primed = getConsoleTailMetrics();

    fs.appendFileSync(logFile, " completed\nnew line\n", "utf8");
    assert.equal(tailConsoleLog({ dataDir, profile: "dev", lines: 2 }), "partial completed\nnew line");
    const appended = getConsoleTailMetrics();
    assert.equal(appended.cacheRebuilds, primed.cacheRebuilds);
    assert.equal(appended.bytesRead - primed.bytesRead, Buffer.byteLength(" completed\nnew line\n"));

    assert.equal(tailConsoleLog({ dataDir, profile: "dev", lines: 1 }), "new line");
    assert.equal(getConsoleTailMetrics().bytesRead, appended.bytesRead);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("console tail rebuilds safely after truncation and rotation", () => {
  resetConsoleTailCache();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fivem-mcp-logs-rotate-"));
  const logDir = path.join(dataDir, "dev", "logs");
  const first = path.join(logDir, "fxserver-first.log");
  const second = path.join(logDir, "fxserver-second.log");
  try {
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(first, "before one\nbefore two\n", "utf8");
    assert.equal(tailConsoleLog({ dataDir, profile: "dev", lines: 2 }), "before one\nbefore two");

    fs.truncateSync(first, 0);
    fs.appendFileSync(first, "after truncate\n", "utf8");
    assert.equal(tailConsoleLog({ dataDir, profile: "dev", lines: 5 }), "after truncate");

    fs.writeFileSync(second, "after rotation\n", "utf8");
    const future = new Date(Date.now() + 2_000);
    fs.utimesSync(second, future, future);
    assert.equal(tailConsoleLog({ dataDir, profile: "dev", lines: 5 }), "after rotation");
    assert.equal(getConsoleTailMetrics().cacheRebuilds, 3);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("RCON rejects oversized commands before opening a socket", async () => {
  const rcon = new RconClient({ host: "127.0.0.1", port: 30120, password: "development" });
  await assert.rejects(() => rcon.command("x".repeat(4097)), /4096-byte/);
});
