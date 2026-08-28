import assert from "node:assert/strict";
import test from "node:test";

import { resourceNameSchema } from "../src/tools/resources.js";

test("resource tool accepts canonical names and rejects console syntax", () => {
  assert.equal(resourceNameSchema.parse("qb-core"), "qb-core");
  assert.equal(resourceNameSchema.safeParse("foo; quit").success, false);
  assert.equal(resourceNameSchema.safeParse("../outside").success, false);
  assert.equal(resourceNameSchema.safeParse("resource name").success, false);
});
