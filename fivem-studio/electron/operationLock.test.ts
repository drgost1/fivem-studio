import assert from "node:assert/strict";
import test from "node:test";

import { OperationLock } from "./operationLock";

test("operation lock rejects overlapping work and releases after completion", async () => {
  const lock = new OperationLock();
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });

  const first = lock.run("server start", () => pending);
  assert.equal(lock.active, "server start");
  await assert.rejects(lock.run("artifact update", async () => undefined), /Wait for server start/);

  release();
  await first;
  assert.equal(lock.active, null);
  await lock.run("artifact update", async () => undefined);
});

test("operation lock releases after an operation throws", async () => {
  const lock = new OperationLock();
  await assert.rejects(
    lock.run("server stop", async () => {
      throw new Error("stop failed");
    }),
    /stop failed/,
  );
  assert.equal(lock.active, null);
  lock.assertIdle("changing Settings");
});
