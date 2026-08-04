// tests/subagents_test.ts
import { assertEquals } from "jsr:@std/assert";
import "../tests/helpers.ts"; // truncate DB first
import { createUser } from "../auth.ts";
import { ALLOWED_MODELS, DEFAULT_MODEL, setModelForUser, setThinkingEffortForUser } from "../models.ts";
import { createProject, setActiveProjectId } from "../projects.ts";
import { subagentInheritedOptions } from "../subagents.ts";

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
