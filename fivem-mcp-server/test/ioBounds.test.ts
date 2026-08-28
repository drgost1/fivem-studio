import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { tailConsoleLog } from "../src/logs.js";
import { RconClient } from "../src/rcon.js";

test("console tail returns recent and filtered lines", () => {
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

test("RCON rejects oversized commands before opening a socket", async () => {
  const rcon = new RconClient({ host: "127.0.0.1", port: 30120, password: "development" });
  await assert.rejects(() => rcon.command("x".repeat(4097)), /4096-byte/);
});
