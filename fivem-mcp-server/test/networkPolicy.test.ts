import assert from "node:assert/strict";
import test from "node:test";

import {
  assertSafeMcpExposure,
  isLoopbackHost,
  isSafeProfileName,
} from "../src/networkPolicy.js";

test("recognizes supported loopback bind hosts", () => {
  assert.equal(isLoopbackHost("127.0.0.1"), true);
  assert.equal(isLoopbackHost("127.42.0.1"), true);
  assert.equal(isLoopbackHost("[::1]"), true);
  assert.equal(isLoopbackHost("localhost"), false);
  assert.equal(isLoopbackHost("127.attacker.example"), false);
  assert.equal(isLoopbackHost("127.0.0.1.evil"), false);
  assert.equal(isLoopbackHost("0.0.0.0"), false);
});

test("rejects every non-loopback control path", () => {
  assert.throws(() => assertSafeMcpExposure("0.0.0.0"), /local development only/);
  assert.throws(() => assertSafeMcpExposure("192.168.1.20"), /local development only/);
  assert.doesNotThrow(() => assertSafeMcpExposure("127.0.0.1"));
});

test("accepts profile folder names but rejects traversal", () => {
  assert.equal(isSafeProfileName("FiveMBasicServerEnhanced_908F3A.base"), true);
  assert.equal(isSafeProfileName("../production"), false);
  assert.equal(isSafeProfileName("dev\\other"), false);
});
