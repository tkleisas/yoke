// tests/llm_test.ts
import { assert, assertEquals, assertRejects, assertStringIncludes } from "jsr:@std/assert";
import {
  backoffDelay,
  callLLM,
  isRetryableStatus,
  type LLMMessage,
  parseRetryAfter,
  toAnthropicMessages,
  toResponsesInput,
} from "../llm.ts";

// ===== Test infrastructure =====
type FetchCall = { url: string; body: Record<string, unknown>; headers: Headers };
// deno-lint-ignore no-explicit-any
type FetchStub = (url: string, init?: RequestInit) => Promise<Response> | Response;

const ENV_KEYS = [
  "DEEPSEEK_API_KEY",
  "DEEPSEEK_BASE_URL",
  "LLM_API_FORMAT",
  "DEEPSEEK_API_FORMAT",
  "DEEPSEEK_RETRY_BASE_MS",
  "DEEPSEEK_RETRY_MAX_MS",
  "DEEPSEEK_TIMEOUT_MS",
];

// Installs a fetch stub and test env values, restoring both afterwards.
async function withStubbedFetch(
  format: string,
  stub: FetchStub,
  fn: (calls: FetchCall[]) => Promise<void> | void,
): Promise<void> {
  const savedEnv = ENV_KEYS.map((k) => [k, Deno.env.get(k)] as const);
  const originalFetch = globalThis.fetch;
  Deno.env.set("DEEPSEEK_API_KEY", "test-key");
  Deno.env.set("DEEPSEEK_BASE_URL", "https://api.test/v1");
  Deno.env.set("LLM_API_FORMAT", format);
  Deno.env.delete("DEEPSEEK_API_FORMAT");
  // Tiny delays so retries stay fast.
  Deno.env.set("DEEPSEEK_RETRY_BASE_MS", "1");
  Deno.env.set("DEEPSEEK_RETRY_MAX_MS", "4");
  Deno.env.set("DEEPSEEK_TIMEOUT_MS", "5000");

  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      body: init?.body ? JSON.parse(String(init.body)) : {},
      headers: new Headers(init?.headers),
    });
    return await stub(String(input), init);
  }) as typeof fetch;

  try {
    await fn(calls);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of savedEnv) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
  }
}

const sse = (text: string) =>
  new Response(text, { status: 200, headers: { "Content-Type": "text/event-stream" } });

const sseEvents = (events: Array<Record<string, unknown>>) =>
  events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");

const dataLines = (chunks: unknown[]) =>
  chunks.map((c) => (typeof c === "string" ? `data: ${c}\n\n` : `data: ${JSON.stringify(c)}\n\n`)).join("");

const TOOL_DEFS = [{
  type: "function",
  function: {
    name: "read_file",
    description: "Read a file.",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
}];

const CONVERSATION: LLMMessage[] = [
  { role: "system", content: "You are helpful." },
  { role: "user", content: "read a.txt" },
  {
    role: "assistant",
    content: null,
    tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"a.txt"}' } }],
  },
  { role: "tool", content: "file contents", tool_call_id: "call_1" },
  { role: "user", content: "thanks" },
];

// ===== Pure helpers =====
Deno.test("backoffDelay stays within growing jitter bounds and is capped", () => {
  for (let attempt = 0; attempt < 6; attempt++) {
    const cap = Math.min(1000 * 2 ** attempt, 30000);
    for (let i = 0; i < 50; i++) {
      const d = backoffDelay(attempt, 1000, 30000);
      assert(d >= 0 && d <= cap, `attempt ${attempt}: ${d} not in [0, ${cap}]`);
    }
  }
  for (let i = 0; i < 100; i++) {
    assert(backoffDelay(20, 1000, 30000) <= 30000, "must be capped at maxMs");
  }
});

Deno.test("isRetryableStatus classifies status codes", () => {
  for (const status of [408, 409, 425, 429, 500, 502, 503]) {
    assertEquals(isRetryableStatus(status), true, `${status} should retry`);
  }
  for (const status of [200, 400, 401, 403, 404, 422]) {
    assertEquals(isRetryableStatus(status), false, `${status} should not retry`);
  }
});

Deno.test("parseRetryAfter parses seconds and HTTP dates", () => {
  assertEquals(parseRetryAfter(null), undefined);
  assertEquals(parseRetryAfter("garbage"), undefined);
  assertEquals(parseRetryAfter("2"), 2000);
  assertEquals(parseRetryAfter("0"), 0);
  const future = parseRetryAfter(new Date(Date.now() + 60_000).toUTCString());
  assert(future !== undefined && future > 50_000 && future <= 60_000, `http date: ${future}`);
});

// ===== Message conversion =====
Deno.test("toAnthropicMessages extracts system and maps tool flow to blocks", () => {
  const { system, messages } = toAnthropicMessages(CONVERSATION);
  assertEquals(system, "You are helpful.");
  assertEquals(messages.some((m) => (m as { role: string }).role === "tool"), false);
  // Consecutive same-role messages are merged (tool_result + following user text).
  assertEquals(messages.map((m) => m.role), ["user", "assistant", "user"]);
  assertEquals(messages[1].content, [{ type: "tool_use", id: "call_1", name: "read_file", input: { path: "a.txt" } }]);
  assertEquals(messages[2].content, [
    { type: "tool_result", tool_use_id: "call_1", content: "file contents" },
    { type: "text", text: "thanks" },
  ]);
});

Deno.test("toResponsesInput extracts instructions and maps tool flow to items", () => {
  const { instructions, input } = toResponsesInput(CONVERSATION);
  assertEquals(instructions, "You are helpful.");
  assertEquals(input[0], { type: "message", role: "user", content: "read a.txt" });
  assertEquals(input[1], {
    type: "function_call",
    call_id: "call_1",
    name: "read_file",
    arguments: '{"path":"a.txt"}',
  });
  assertEquals(input[2], { type: "function_call_output", call_id: "call_1", output: "file contents" });
  assertEquals(input[3], { type: "message", role: "user", content: "thanks" });
});

// ===== Chat format =====
Deno.test("chat streaming parses deltas, tool calls and usage", async () => {
  const stream = dataLines([
    { choices: [{ delta: { reasoning_content: "thinking " } }] },
    { choices: [{ delta: { content: "Hello" } }] },
    { choices: [{ delta: { content: " world" } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "read_file", arguments: '{"path":' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"a.txt"}' } }] } }] },
    { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
    "[DONE]",
  ]);

  await withStubbedFetch("chat", () => sse(stream), async (calls) => {
    const deltas: Array<[string, string]> = [];
    const result = await callLLM({
      messages: [{ role: "user", content: "hi" }],
      tools: TOOL_DEFS,
      toolChoice: "auto",
      model: "deepseek-v4-flash",
      stream: true,
      onDelta: (content, reasoning) => deltas.push([content, reasoning]),
    });

    assertEquals(calls.length, 1);
    assertEquals(calls[0].url, "https://api.test/v1/chat/completions");
    assertEquals(calls[0].headers.get("authorization"), "Bearer test-key");
    assertEquals(calls[0].body.stream, true);
    assertEquals(calls[0].body.tool_choice, "auto");

    assertEquals(result.content, "Hello world");
    assertEquals(result.reasoning, "thinking ");
    assertEquals(result.toolCalls, [{ id: "call_1", name: "read_file", arguments: '{"path":"a.txt"}' }]);
    assertEquals(result.usage, { promptTokens: 10, completionTokens: 5, totalTokens: 15 });
    assertEquals(deltas, [["", "thinking "], ["Hello", ""], [" world", ""]]);
  });
});

Deno.test("chat non-streaming parses tool calls", async () => {
  const payload = {
    choices: [{
      message: {
        content: null,
        tool_calls: [{ id: "call_7", type: "function", function: { name: "read_file", arguments: '{"path":"x"}' } }],
      },
    }],
    usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
  };
  await withStubbedFetch("chat", () => Response.json(payload), async (calls) => {
    const result = await callLLM({ messages: [{ role: "user", content: "hi" }], model: "m" });
    assertEquals(calls[0].body.stream, undefined);
    assertEquals(result.toolCalls, [{ id: "call_7", name: "read_file", arguments: '{"path":"x"}' }]);
    assertEquals(result.usage, { promptTokens: 3, completionTokens: 2, totalTokens: 5 });
  });
});

// ===== Responses format =====
Deno.test("responses streaming parses events and builds the request", async () => {
  const stream = sseEvents([
    { type: "response.output_text.delta", delta: "Hi" },
    { type: "response.reasoning_text.delta", delta: "hmm" },
    { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '{"pa' },
    { type: "response.function_call_arguments.done", item_id: "fc_1", arguments: '{"path":"a.txt"}' },
    {
      type: "response.output_item.done",
      item: { type: "function_call", call_id: "call_9", name: "read_file", arguments: '{"path":"a.txt"}' },
    },
    { type: "response.completed", response: { usage: { input_tokens: 12, output_tokens: 7, total_tokens: 19 } } },
  ]);

  await withStubbedFetch("responses", () => sse(stream), async (calls) => {
    const deltas: Array<[string, string]> = [];
    const result = await callLLM({
      messages: CONVERSATION,
      tools: TOOL_DEFS,
      toolChoice: "auto",
      model: "deepseek-v4-flash",
      reasoningEffort: "high",
      stream: true,
      onDelta: (content, reasoning) => deltas.push([content, reasoning]),
    });

    assertEquals(calls.length, 1);
    // Trailing /v1 is stripped for the responses endpoint.
    assertEquals(calls[0].url, "https://api.test/responses");
    const body = calls[0].body;
    assertEquals(body.instructions, "You are helpful.");
    assertEquals(body.stream, true);
    assertEquals(body.reasoning, { effort: "high" });
    assertEquals(body.tools, [{
      type: "function",
      name: "read_file",
      description: "Read a file.",
      parameters: TOOL_DEFS[0].function.parameters,
    }]);
    // deno-lint-ignore no-explicit-any
    const input = body.input as any[];
    assertEquals(input.some((i) => i.type === "function_call" && i.call_id === "call_1"), true);
    assertEquals(input.some((i) => i.type === "function_call_output" && i.output === "file contents"), true);

    assertEquals(result.content, "Hi");
    assertEquals(result.reasoning, "hmm");
    assertEquals(result.toolCalls, [{ id: "call_9", name: "read_file", arguments: '{"path":"a.txt"}' }]);
    assertEquals(result.usage, { promptTokens: 12, completionTokens: 7, totalTokens: 19 });
    assertEquals(deltas, [["Hi", ""], ["", "hmm"]]);
  });
});

// ===== Anthropic format =====
Deno.test("anthropic streaming parses content blocks and builds the request", async () => {
  const stream = sseEvents([
    { type: "message_start", message: { usage: { input_tokens: 20, output_tokens: 1 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OK" } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "read_file" } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"path":' } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '"b.txt"}' } },
    { type: "content_block_stop", index: 1 },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 9 } },
    { type: "message_stop" },
  ]);

  await withStubbedFetch("anthropic", () => sse(stream), async (calls) => {
    const result = await callLLM({
      messages: CONVERSATION,
      tools: TOOL_DEFS,
      model: "deepseek-v4-flash",
      reasoningEffort: "high",
      stream: true,
      onDelta: () => {},
    });

    assertEquals(calls.length, 1);
    assertEquals(calls[0].url, "https://api.test/anthropic/v1/messages");
    assertEquals(calls[0].headers.get("x-api-key"), "test-key");
    assertEquals(calls[0].headers.get("anthropic-version"), "2023-06-01");
    const body = calls[0].body;
    assertEquals(body.max_tokens, 8192);
    assertEquals(body.system, "You are helpful.");
    assertEquals(body.stream, true);
    assertEquals(body.thinking, { type: "enabled", budget_tokens: 1024 });
    assertEquals(body.tools, [{
      name: "read_file",
      description: "Read a file.",
      input_schema: TOOL_DEFS[0].function.parameters,
    }]);
    assertEquals(body.tool_choice, { type: "auto" });
    // deno-lint-ignore no-explicit-any
    const messages = body.messages as any[];
    assertEquals(messages.some((m) => m.role === "tool"), false);
    assertEquals(
      messages.some((m) =>
        // deno-lint-ignore no-explicit-any
        m.content.some((b: any) => b.type === "tool_result" && b.tool_use_id === "call_1")
      ),
      true,
    );

    assertEquals(result.content, "OK");
    assertEquals(result.toolCalls, [{ id: "toolu_1", name: "read_file", arguments: '{"path":"b.txt"}' }]);
    assertEquals(result.usage, { promptTokens: 20, completionTokens: 9, totalTokens: 29 });
  });
});

// ===== Retry / timeout behavior =====
Deno.test("retries 500s with backoff then succeeds", async () => {
  let attempts = 0;
  const stub: FetchStub = () => {
    attempts++;
    if (attempts < 3) return new Response("server error", { status: 500 });
    return Response.json({ choices: [{ message: { content: "done" } }] });
  };
  await withStubbedFetch("chat", stub, async (calls) => {
    const result = await callLLM({ messages: [{ role: "user", content: "hi" }], model: "m" });
    assertEquals(calls.length, 3);
    assertEquals(result.content, "done");
  });
});

Deno.test("network errors are retried", async () => {
  let attempts = 0;
  const stub: FetchStub = () => {
    attempts++;
    if (attempts < 3) throw new TypeError("connection reset");
    return Response.json({ choices: [{ message: { content: "ok" } }] });
  };
  await withStubbedFetch("chat", stub, async (calls) => {
    const result = await callLLM({ messages: [{ role: "user", content: "hi" }], model: "m" });
    assertEquals(calls.length, 3);
    assertEquals(result.content, "ok");
  });
});

Deno.test("400 does not retry", async () => {
  await withStubbedFetch("chat", () => new Response("bad request", { status: 400 }), async (calls) => {
    const err = await assertRejects(
      () => callLLM({ messages: [{ role: "user", content: "hi" }], model: "m" }),
      Error,
      "DeepSeek API error: 400",
    );
    assertStringIncludes(err.message, "bad request");
    assertEquals(calls.length, 1);
  });
});

Deno.test("Retry-After header is honored on 429", async () => {
  let attempts = 0;
  const stub: FetchStub = () => {
    attempts++;
    if (attempts === 1) return new Response("slow down", { status: 429, headers: { "Retry-After": "0" } });
    return Response.json({ choices: [{ message: { content: "ok" } }] });
  };
  await withStubbedFetch("chat", stub, async (calls) => {
    const result = await callLLM({ messages: [{ role: "user", content: "hi" }], model: "m" });
    assertEquals(calls.length, 2);
    assertEquals(result.content, "ok");
  });
});

Deno.test("caller abort is not retried", async () => {
  await withStubbedFetch("chat", () => new Response("err", { status: 500 }), async (calls) => {
    const ctrl = new AbortController();
    ctrl.abort(new Error("cancelled by user"));
    await assertRejects(
      () => callLLM({ messages: [{ role: "user", content: "hi" }], model: "m", signal: ctrl.signal }),
      Error,
      "cancelled by user",
    );
    assertEquals(calls.length, 0);
  });
});

Deno.test("stream failure before the first delta is retried", async () => {
  let attempts = 0;
  const stub: FetchStub = () => {
    attempts++;
    if (attempts === 1) {
      return new Response(
        new ReadableStream({
          start(ctrl) {
            ctrl.error(new Error("boom"));
          },
        }),
        { status: 200 },
      );
    }
    return sse(dataLines([{ choices: [{ delta: { content: "recovered" } }] }, "[DONE]"]));
  };
  await withStubbedFetch("chat", stub, async (calls) => {
    const result = await callLLM({
      messages: [{ role: "user", content: "hi" }],
      model: "m",
      stream: true,
      onDelta: () => {},
    });
    assertEquals(calls.length, 2);
    assertEquals(result.content, "recovered");
  });
});

Deno.test("stream failure after a delta surfaces without retry", async () => {
  const stub: FetchStub = () => {
    let sent = false;
    return new Response(
      new ReadableStream({
        pull(ctrl) {
          if (!sent) {
            sent = true;
            ctrl.enqueue(new TextEncoder().encode(dataLines([{ choices: [{ delta: { content: "partial" } }] }])));
          } else {
            ctrl.error(new Error("boom"));
          }
        },
      }),
      { status: 200 },
    );
  };
  await withStubbedFetch("chat", stub, async (calls) => {
    const err = await assertRejects(
      () => callLLM({ messages: [{ role: "user", content: "hi" }], model: "m", stream: true, onDelta: () => {} }),
      Error,
      "interrupted after partial output",
    );
    assertStringIncludes(err.message, "boom");
    assertEquals(calls.length, 1);
  });
});
