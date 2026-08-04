// tests/subagents_test.ts
import { assert, assertEquals, assertRejects, assertStringIncludes } from "jsr:@std/assert";
import "../tests/helpers.ts"; // truncate DB first
import { createUser } from "../auth.ts";
import { ALLOWED_MODELS, DEFAULT_MODEL, setModelForUser, setThinkingEffortForUser } from "../models.ts";
import { createProject, setActiveProjectId } from "../projects.ts";
import { getSubagent, spawnSubagent, subagentInheritedOptions, waitForSubagent } from "../subagents.ts";

Deno.test("subagent inherits the user's model and thinking effort", async () => {
  const user = await createUser("subuser", "password123");
  const userModel = ALLOWED_MODELS.find((m) => m !== DEFAULT_MODEL) ?? DEFAULT_MODEL;
  setModelForUser(user.id, userModel);
  setThinkingEffortForUser(user.id, "high");

  assertEquals(subagentInheritedOptions(user.id), { model: userModel, thinkingEffort: "high" });
});

Deno.test("a project's pinned model wins for subagents", async () => {
  const user = await createUser("subuser2", "password123");
  setThinkingEffortForUser(user.id, "low");
  const project = createProject("subproj", ".test-data/subproj", "project-pinned-model");
  setActiveProjectId(user.id, project.id);

  assertEquals(subagentInheritedOptions(user.id), { model: "project-pinned-model", thinkingEffort: "low" });
});

Deno.test("without a user there is nothing to inherit", () => {
  assertEquals(subagentInheritedOptions(), {});
});

Deno.test("waitForSubagent rejects promptly on an aborted signal", async () => {
  const record = spawnSubagent("list directory", "waiter");
  const ctrl = new AbortController();
  ctrl.abort(new Error("stopped by user"));
  const started = Date.now();
  const err = await assertRejects(
    () => waitForSubagent(record.id, 60_000, ctrl.signal),
    Error,
    "stopped by user",
  );
  assertStringIncludes(err.message, "stopped by user");
  assert(Date.now() - started < 1000, "abort should not wait out the timeout");
  // Clean up: the mock subagent itself finishes on its own in the background.
  await waitForSubagent(record.id, 10_000);
});

Deno.test("a subagent spawned with an aborted signal stops instead of running", async () => {
  const ctrl = new AbortController();
  ctrl.abort();
  const record = spawnSubagent("list directory", "aborted-spawn", 5, undefined, undefined, ctrl.signal);
  // runAgent notices the aborted signal at its first iteration and returns.
  const finished = await waitForSubagent(record.id, 10_000);
  assertEquals(finished.status === "running", false);
  assertEquals(getSubagent(record.id)?.status, finished.status);
});
