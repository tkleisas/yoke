// tests/context_test.ts
import { assertEquals } from "jsr:@std/assert";
import "../tests/helpers.ts"; // truncate DB first
import { createUser } from "../auth.ts";
import {
  appendConversation, archiveAllActive, compactConversation, estimateTokens, getConversation,
  getHistory, getMaxIterationsForUser, resetConversation, restoreConversation, setMaxIterationsForUser,
  type HistoryMessage,
} from "../context.ts";
import { createProject } from "../projects.ts";

let userId: number;
let projectId: number;
let compactProjectId = 0;

function userMessage(content: string) {
  return { role: "user", content } as const;
}

Deno.test("conversation is empty until used", () => {
  const messages = getConversation(9999);
  assertEquals(messages.length, 1);
  assertEquals(messages[0].role, "system");
});

Deno.test("messages persist and accumulate across appends", async () => {
  const user = await createUser("ctxuser", "password123");
  userId = user.id;

  appendConversation(userId, 0, [userMessage("first")]);
  appendConversation(userId, 0, [userMessage("second"), { role: "assistant", content: "reply" }]);

  const conversation = getConversation(userId, 0);
  assertEquals(conversation.length, 4); // system + 3
  assertEquals(conversation[1].content, "first");
  assertEquals(conversation[2].content, "second");
  assertEquals(conversation[3].content, "reply");
  assertEquals(conversation.filter((m) => m.role !== "system").length, 3);
});

Deno.test("tool calls and responses round-trip through storage", () => {
  const toolCall = {
    id: "call_1",
    type: "function" as const,
    function: { name: "write_file", arguments: '{"path":"a.txt","content":"hi"}' },
  };
  appendConversation(userId, 0, [
    { role: "assistant", content: null, tool_calls: [toolCall] },
    { role: "tool", content: "Wrote 2 characters.", tool_call_id: "call_1" },
  ]);

  const conversation = getConversation(userId, 0);
  const assistant = conversation[conversation.length - 2];
  const tool = conversation[conversation.length - 1];
  assertEquals(assistant, { role: "assistant", content: null, tool_calls: [toolCall] });
  assertEquals(tool, { role: "tool", content: "Wrote 2 characters.", tool_call_id: "call_1" });
});

Deno.test("conversations are scoped per (user, project)", () => {
  resetConversation(userId, 0);
  const project = createProject("ctxproj", ".test-data/ctxproj");
  projectId = project.id;

  appendConversation(userId, 0, [userMessage("in default")]);
  appendConversation(userId, projectId, [userMessage("in project")]);

  assertEquals(getConversation(userId, 0).length, 2); // system + 1
  assertEquals(getConversation(userId, projectId).length, 2);
  assertEquals(getConversation(userId, 0)[1].content, "in default");
  assertEquals(getConversation(userId, projectId)[1].content, "in project");
});

Deno.test("compact archives old messages but keeps full history", () => {
  // Use a dedicated project so history counts are exact.
  const project = createProject("cmpproj", ".test-data/cmpproj");
  compactProjectId = project.id;
  for (let i = 0; i < 10; i++) appendConversation(userId, compactProjectId, [userMessage(`msg ${i}`)]);

  const compacted = compactConversation(userId, compactProjectId, 3);
  assertEquals(compacted.filter((m) => m.role !== "system").length, 3);
  assertEquals(compacted[compacted.length - 1].content, "msg 9");

  const history = getHistory(userId, compactProjectId);
  assertEquals(history.length, 10);
  assertEquals(history.filter((m) => m.status === "active").length, 3);
  assertEquals(history.filter((m) => m.status === "archived").length, 7);
});

Deno.test("restore brings archived messages back into context", () => {
  const restored = restoreConversation(userId, compactProjectId);
  assertEquals(restored, 7);

  const conversation = getConversation(userId, compactProjectId);
  assertEquals(conversation.filter((m) => m.role !== "system").length, 10);
  assertEquals(getHistory(userId, compactProjectId).every((m) => m.status === "active"), true);
});

Deno.test("reset archives everything but history is preserved", () => {
  resetConversation(userId, compactProjectId);

  const conversation = getConversation(userId, compactProjectId);
  assertEquals(conversation.length, 1);
  assertEquals(conversation[0].role, "system");

  const history = getHistory(userId, compactProjectId);
  assertEquals(history.length, 10);
  assertEquals(history.every((m) => m.status === "archived"), true);

  // getHistory is newest-first, so the most recent message is first.
  const newest = history[0] as HistoryMessage;
  assertEquals(newest.content, "msg 9");
});

Deno.test("archiveAllActive clears context but keeps rows", () => {
  resetConversation(userId, 0);
  appendConversation(userId, 0, [userMessage("fresh msg")]);
  assertEquals(getConversation(userId, 0).length, 2);

  archiveAllActive(userId, 0);
  assertEquals(getConversation(userId, 0).length, 1);
  assertEquals(getHistory(userId, 0).every((m) => m.status === "archived"), true);
});

Deno.test("estimateTokens approximates message size", () => {
  const tokens = estimateTokens([
    { role: "user", content: "hello" },
    { role: "assistant", content: null, tool_calls: [{ id: "1", type: "function", function: { name: "read_file", arguments: '{"path":"a"}' } }] },
  ]);
  assertEquals(tokens > 0, true);
});

Deno.test("max iterations setting round-trips", () => {
  assertEquals(getMaxIterationsForUser(userId), null);
  setMaxIterationsForUser(userId, 25);
  assertEquals(getMaxIterationsForUser(userId), 25);
});
