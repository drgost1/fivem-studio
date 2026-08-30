import assert from "node:assert/strict";
import test from "node:test";

import { appendConsoleSnapshot } from "./consoleViewModel";

test("cleared console view shows only lines appended to an unchanged tail", () => {
  assert.equal(appendConsoleSnapshot("one\ntwo", "one\ntwo\nthree", ""), "three");
  assert.equal(appendConsoleSnapshot("one\ntwo\nthree", "one\ntwo\nthree", "three"), "three");
});

test("cleared console view survives rolling tails and log rotation", () => {
  assert.equal(appendConsoleSnapshot("one\ntwo\nthree", "two\nthree\nfour", ""), "four");
  assert.equal(appendConsoleSnapshot("old", "new-a\nnew-b", ""), "new-a\nnew-b");
});

test("cleared console view remains bounded", () => {
  assert.equal(appendConsoleSnapshot("a", "a\nb\nc", "x", 2), "b\nc");
});
