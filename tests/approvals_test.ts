// tests/approvals_test.ts
import { assertEquals, assertFalse } from "jsr:@std/assert";
import { createApproval, isAlwaysApproved, listPendingApprovals, respondApproval } from "../approvals.ts";

Deno.test("createApproval registers a pending approval", async () => {
  const promise = createApproval("echo hi", "alice");
  const pending = listPendingApprovals();
  assertEquals(pending.length, 1);
  assertEquals(pending[0].command, "echo hi");
  assertEquals(pending[0].requester, "alice");
  respondApproval(pending[0].id, true, false);
  assertEquals(await promise, true);
  assertEquals(listPendingApprovals().length, 0);
});

Deno.test("approve resolves true, deny resolves false", async () => {
  const approvePromise = createApproval("cmd-a", "alice");
  respondApproval(listPendingApprovals()[0].id, true, false);
  assertEquals(await approvePromise, true);

  const denyPromise = createApproval("cmd-b", "bob");
  respondApproval(listPendingApprovals()[0].id, false, false);
  assertEquals(await denyPromise, false);
});

Deno.test("approve with always remembers the command", async () => {
  const promise = createApproval("reboot", "alice");
  assertFalse(isAlwaysApproved("reboot"));
  respondApproval(listPendingApprovals()[0].id, true, true);
  await promise;
  assertEquals(isAlwaysApproved("reboot"), true);
});

Deno.test("responding twice or to an unknown id fails", async () => {
  const promise = createApproval("cmd-c", "alice");
  const id = listPendingApprovals()[0].id;
  assertEquals(respondApproval(id, true, false), true);
  await promise;
  assertEquals(respondApproval(id, true, false), false);
  assertEquals(respondApproval("does-not-exist", true, false), false);
});
