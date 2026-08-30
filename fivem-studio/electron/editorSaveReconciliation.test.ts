import assert from "node:assert/strict";
import test from "node:test";

import { PerPathSaveQueue, reconcileSuccessfulSave } from "./editorSaveReconciliation";

test("a completed save marks the unchanged buffer clean", () => {
  assert.deepEqual(
    reconcileSuccessfulSave({ content: "saved", revision: "old", dirty: true }, "saved", "new"),
    { content: "saved", revision: "new", dirty: false },
  );
});

test("edits typed during an in-flight save remain dirty and are never replaced", () => {
  assert.deepEqual(
    reconcileSuccessfulSave({ content: "typed later", revision: "old", dirty: true }, "saved earlier", "new"),
    { content: "typed later", revision: "new", dirty: true },
  );
});

test("same-path saves are serialized and a later save starts after rejection", async () => {
  const queue = new PerPathSaveQueue();
  const events: string[] = [];
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const first = queue.run("client.lua", async () => {
    events.push("first:start");
    await firstGate;
    events.push("first:end");
    throw new Error("first failed");
  });
  const second = queue.run("client.lua", async () => {
    events.push("second:start");
    return "saved";
  });

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["first:start"]);
  releaseFirst();
  await assert.rejects(first, /first failed/);
  assert.equal(await second, "saved");
  assert.deepEqual(events, ["first:start", "first:end", "second:start"]);
});
