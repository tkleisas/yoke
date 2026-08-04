// tests/agent_test.ts
// Agent-loop abort behavior. Runs in mock mode (no DEEPSEEK_API_KEY in
// .env.test), where the mock LLM issues one tool call and then finishes.
import { assertEquals } from "jsr:@std/assert";
import "../tests/helpers.ts"; // truncate DB first
import { runAgent, type AgentEvent, type ChatMessage } from "../agent.ts";

Deno.test("runAgent stops between tool calls when the signal aborts", async () => {
  const ctrl = new AbortController();
  const events: AgentEvent[] = [];
  const messages: ChatMessage[] = [];
  await runAgent(messages, "read example.txt", (event) => {
    events.push(event);
    // Abort as soon as the first tool call has executed.
    if (event.type === "step") ctrl.abort();
  }, { signal: ctrl.signal, workspace: "tests/fixtures" });

  const types = events.map((e) => e.type);
  assertEquals(types[0], "tool_start");
  assertEquals(types[1], "step");
  assertEquals(types[types.length - 1], "cancelled");
  assertEquals(types.includes("finish"), false);

  // The saved conversation must keep valid assistant/tool pairing: every
  // tool_call_id is answered by a tool message.
  const assistant = messages.find((m) => m.role === "assistant" && m.tool_calls);
  assertEquals(assistant !== undefined, true);
  for (const tc of assistant!.tool_calls!) {
    assertEquals(
      messages.some((m) => m.role === "tool" && m.tool_call_id === tc.id),
      true,
      `missing tool response for ${tc.id}`,
    );
  }
});

Deno.test("runAgent with a pre-aborted signal cancels immediately", async () => {
  const ctrl = new AbortController();
  ctrl.abort();
  const events: string[] = [];
  await runAgent([], "read example.txt", (event) => events.push(event.type), {
    signal: ctrl.signal,
    workspace: "tests/fixtures",
  });
  assertEquals(events, ["cancelled"]);
});
