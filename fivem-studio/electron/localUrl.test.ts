import assert from "node:assert/strict";
import test from "node:test";

import { isLoopbackHostname, parseLoopbackHttpUrl, parseProviderUrl } from "./localUrl";

test("accepts local MCP hosts", () => {
  for (const host of ["127.0.0.1", "127.12.34.56", "::1", "[::1]"]) {
    assert.equal(isLoopbackHostname(host), true, host);
  }
});

test("rejects non-loopback and wildcard MCP hosts", () => {
  for (const host of ["localhost", "example.com", "192.168.1.10", "10.0.0.4", "0.0.0.0", "localhost.example.com", "127.attacker.example", "127.0.0.1.evil"]) {
    assert.equal(isLoopbackHostname(host), false, host);
  }
});

test("rejects non-local URLs and embedded credentials", () => {
  assert.throws(() => parseLoopbackHttpUrl("https://example.com/mcp"), /numeric loopback/);
  assert.throws(() => parseLoopbackHttpUrl("file:///tmp/mcp"), /http/);
  assert.throws(() => parseLoopbackHttpUrl("http://user:secret@127.0.0.1:3414/mcp"), /credentials/);
  assert.equal(parseLoopbackHttpUrl("http://127.0.0.1:3414/mcp").pathname, "/mcp");
});

test("requires encryption for hosted model providers", () => {
  assert.equal(parseProviderUrl("https://api.example.com/v1").protocol, "https:");
  assert.equal(parseProviderUrl("http://127.0.0.1:11434/v1").hostname, "127.0.0.1");
  assert.throws(() => parseProviderUrl("http://localhost:11434/v1"), /numeric loopback/);
  assert.throws(() => parseProviderUrl("http://api.example.com/v1"), /must use HTTPS/);
  assert.throws(() => parseProviderUrl("https://key@example.com/v1"), /credentials/);
});
