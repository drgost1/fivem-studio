import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";

import { assertFxServerPortAvailable } from "./portPreflight";

test("port preflight accepts a free loopback endpoint", async () => {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  assert.equal(typeof address, "object");
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  await assertFxServerPortAvailable("127.0.0.1", port);
});

test("port preflight reports a held TCP endpoint before launch", async () => {
  const held = net.createServer();
  await new Promise<void>((resolve) => held.listen(0, "127.0.0.1", resolve));
  const address = held.address();
  const port = typeof address === "object" && address ? address.port : 0;
  try {
    await assert.rejects(assertFxServerPortAvailable("127.0.0.1", port), /already in use/);
  } finally {
    await new Promise<void>((resolve, reject) => held.close((error) => error ? reject(error) : resolve()));
  }
});
