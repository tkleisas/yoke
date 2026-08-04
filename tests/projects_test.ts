// tests/projects_test.ts
import { assertEquals } from "jsr:@std/assert";
import "../tests/helpers.ts"; // truncate DB first
import { createUser } from "../auth.ts";
import { appendConversation, getHistory } from "../context.ts";
import { createProject, deleteProject, getActiveProjectId, getProject, setActiveProjectId } from "../projects.ts";

Deno.test("deleteProject removes the project and its messages", async () => {
  const user = await createUser("projuser", "password123");
  const project = createProject("delproj", ".test-data/delproj");
  setActiveProjectId(user.id, project.id);
  appendConversation(user.id, project.id, [{ role: "user", content: "hello" }]);
  appendConversation(user.id, project.id, [{ role: "assistant", content: "hi" }]);
  assertEquals(getHistory(user.id, project.id).length, 2);

  const deleted = deleteProject(project.id);
  assertEquals(deleted, true);

  // Project, its conversation history, and the user's active-project link are gone.
  assertEquals(getProject(project.id), null);
  assertEquals(getHistory(user.id, project.id).length, 0);
  assertEquals(getActiveProjectId(user.id), null);

  // Deleting again is a no-op, not an error.
  assertEquals(deleteProject(project.id), false);
});

Deno.test("deleteProject leaves other projects' messages alone", async () => {
  const user = await createUser("projuser2", "password123");
  const doomed = createProject("doomed", ".test-data/doomed");
  const kept = createProject("kept", ".test-data/kept");
  appendConversation(user.id, doomed.id, [{ role: "user", content: "in doomed" }]);
  appendConversation(user.id, kept.id, [{ role: "user", content: "in kept" }]);

  deleteProject(doomed.id);

  assertEquals(getHistory(user.id, doomed.id).length, 0);
  assertEquals(getHistory(user.id, kept.id).length, 1);
  assertEquals(getProject(kept.id)?.name, "kept");
});
