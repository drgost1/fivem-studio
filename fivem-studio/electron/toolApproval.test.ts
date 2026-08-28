import assert from "node:assert/strict";
import test from "node:test";

import { requestToolApproval, resolveToolApproval, toolRisk } from "./toolApproval";

test("classifies coding-oriented reads, writes, and unknown tools", () => {
  assert.equal(toolRisk("read_project_file"), null);
  assert.equal(toolRisk("list_resources"), null);
  assert.equal(toolRisk("write_project_file"), "write");
  assert.equal(toolRisk("restart_resource"), "write");
  assert.equal(toolRisk("future_tool"), "dangerous");
});

test("waits for an explicit one-time approval", async () => {
  const events: unknown[] = [];
  const pending = requestToolApproval("call-1", "restart_resource", { name: "my-resource" }, (event) => events.push(event));
  const request = events[0] as { type: string; approvalId: string };
  assert.equal(request.type, "approval_request");
  const approvalId = request.approvalId;
  assert.equal(resolveToolApproval(approvalId, true), true);
  assert.equal(await pending, true);
  assert.deepEqual(events.map((event) => (event as { type: string }).type), ["approval_request", "approval_resolved"]);
});
