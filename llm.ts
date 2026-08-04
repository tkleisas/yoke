// llm.ts
// Provider layer for LLM calls. Three wire formats — OpenAI chat
// completions ("chat"), OpenAI Responses API ("responses"), and the
// Anthropic messages API ("anthropic") — behind one normalized entry
// point, with retries (exponential backoff + jitter), timeouts, and
// robust SSE parsing. Internal messages stay OpenAI-style; conversion
// to/from the other formats happens here.

// ===== Types =====
export type LLMMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
};

export type LLMToolCall = { id: string; name: string; arguments: string };

export type LLMUsage = { promptTokens: number; completionTokens: number; totalTokens: number };

export type LLMResult = {
  content: string;
  reasoning: string;
  toolCalls: LLMToolCall[];
  usage?: LLMUsage;
};

export type CallLLMOptions = {
  messages: LLMMessage[];
  tools?: unknown[]; // OpenAI chat-completions tool defs
  toolChoice?: unknown;
  model: string;
  temperature?: number;
  reasoningEffort?: string;
  stream?: boolean;
  onDelta?: (content: string, reasoning: string) => void;
  signal?: AbortSignal;
};

// ===== Configuration =====
type ApiFormat = "chat" | "responses" | "anthropic";

type LLMConfig = {
  apiKey: string;
  format: ApiFormat;
  chatUrl: string;
  responsesUrl: string;
  anthropicUrl: string;
  maxRetries: number;
  retryBaseMs: number;
  retryMaxMs: number;
  timeoutMs: number;
};

// Required by the Anthropic messages API; DeepSeek ignores the thinking budget.
const ANTHROPIC_MAX_TOKENS = 8192;
const ANTHROPIC_VERSION = "2023-06-01";

function envInt(name: string, fallback: number, min: number, max: number): number {
  const parsed = parseInt(Deno.env.get(name) || "", 10);
  if (Number.isNaN(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

// Read at call time so tests (and late env changes) take effect.
function getConfig(): LLMConfig {
  const rawFormat = (Deno.env.get("LLM_API_FORMAT") || Deno.env.get("DEEPSEEK_API_FORMAT") || "chat").toLowerCase();
  const format: ApiFormat = rawFormat === "responses" || rawFormat === "anthropic" ? rawFormat : "chat";
  const base = (Deno.env.get("DEEPSEEK_BASE_URL") || "https://api.deepseek.com/v1").replace(/\/+$/, "");
  // Chat lives under whatever base the user configured (which may include
  // /v1); responses/anthropic resolve against the API root.
  const root = base.replace(/\/v1$/, "");
  return {
    apiKey: Deno.env.get("DEEPSEEK_API_KEY") || "",
    format,
    chatUrl: `${base}/chat/completions`,
    responsesUrl: `${root}/responses`,
    anthropicUrl: `${root}/anthropic/v1/messages`,
    maxRetries: envInt("DEEPSEEK_MAX_RETRIES", 4, 0, 20),
    retryBaseMs: envInt("DEEPSEEK_RETRY_BASE_MS", 1000, 1, 60000),
    retryMaxMs: envInt("DEEPSEEK_RETRY_MAX_MS", 30000, 1, 300000),
    timeoutMs: envInt("DEEPSEEK_TIMEOUT_MS", 120000, 1000, 600000),
  };
}

function errString(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

// ===== Retry helpers (exported for tests) =====
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

// Full-jitter exponential backoff: uniform in [0, min(maxMs, baseMs * 2^attempt)).
export function backoffDelay(attempt: number, baseMs: number, maxMs: number): number {
  const cap = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt));
  return Math.floor(Math.random() * cap);
}

export function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return undefined;
}

class HttpError extends Error {
  constructor(public status: number, body: string, public retryAfterMs?: number) {
    super(`DeepSeek API error: ${status} - ${body}`);
  }
}

// Failure while reading a response stream (distinct from connect failures so
// streaming retries can be limited to the pre-first-delta window).
class StreamError extends Error {}

// ===== HTTP plumbing =====
// Combines the caller's abort signal with a per-request timeout.
function composeSignal(caller: AbortSignal | undefined, timeoutMs: number) {
  const ctrl = new AbortController();
  const timer = setTimeout(
    () => ctrl.abort(new Error(`DeepSeek request timed out after ${timeoutMs}ms`)),
    timeoutMs,
  );
  const onCallerAbort = () => ctrl.abort(caller!.reason);
  if (caller) {
    if (caller.aborted) ctrl.abort(caller.reason);
    else caller.addEventListener("abort", onCallerAbort, { once: true });
  }
  const clearTimer = () => clearTimeout(timer);
  const clear = () => {
    clearTimer();
    caller?.removeEventListener("abort", onCallerAbort);
  };
  return { signal: ctrl.signal, clear, clearTimer };
}

function sleep(ms: number, caller?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(caller!.reason ?? new Error("aborted"));
    };
    const timer = setTimeout(() => {
      caller?.removeEventListener("abort", onAbort);
      resolve();
    }, Math.max(0, ms));
    if (caller) {
      if (caller.aborted) {
        clearTimeout(timer);
        reject(caller.reason ?? new Error("aborted"));
        return;
      }
      caller.addEventListener("abort", onAbort, { once: true });
    }
  });
}

async function fetchOnce(
  url: string,
  init: RequestInit,
  cfg: LLMConfig,
  caller: AbortSignal | undefined,
): Promise<{ response: Response; clear: () => void; clearTimer: () => void }> {
  const { signal, clear, clearTimer } = composeSignal(caller, cfg.timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new HttpError(response.status, text, parseRetryAfter(response.headers.get("retry-after")));
    }
    return { response, clear, clearTimer };
  } catch (err) {
    clear();
    throw err;
  }
}

async function withRetry<T>(
  cfg: LLMConfig,
  caller: AbortSignal | undefined,
  attemptFn: () => Promise<T>,
  retryable: (err: unknown) => boolean,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    if (caller?.aborted) throw caller.reason ?? new Error("aborted");
    try {
      return await attemptFn();
    } catch (err) {
      if (caller?.aborted) throw err; // caller abort is never retried
      if (attempt >= cfg.maxRetries || !retryable(err)) throw err;
      const retryAfterMs = err instanceof HttpError ? err.retryAfterMs : undefined;
      await sleep(retryAfterMs ?? backoffDelay(attempt, cfg.retryBaseMs, cfg.retryMaxMs), caller);
    }
  }
}

// ===== SSE parsing =====
type SSEEvent = { event?: string; data: string };

// Line-buffered SSE reader: yields one event per blank-line-terminated
// block, ignores comments and malformed lines. A caller abort cancels the
// underlying reader (read() would otherwise hang on a slow stream) and the
// abort reason is thrown instead of a stream error.
async function* readSSE(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<SSEEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventName: string | undefined;
  let dataLines: string[] = [];

  const onAbort = () => reader.cancel(signal!.reason ?? new Error("aborted")).catch(() => {});
  if (signal && !signal.aborted) signal.addEventListener("abort", onAbort, { once: true });

  const flushEvent = (): SSEEvent | undefined => {
    if (dataLines.length === 0) {
      eventName = undefined;
      return undefined;
    }
    const ev = { event: eventName, data: dataLines.join("\n") };
    eventName = undefined;
    dataLines = [];
    return ev;
  };

  const handleLine = (line: string): SSEEvent | undefined => {
    if (line === "") return flushEvent();
    if (line.startsWith(":")) return undefined; // comment / keepalive
    if (line.startsWith("event:")) {
      eventName = line.slice(6).trim();
      return undefined;
    }
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
      return undefined;
    }
    return undefined;
  };

  try {
    while (true) {
      if (signal?.aborted) throw signal.reason ?? new Error("aborted");
      const { done, value } = await reader.read();
      // reader.cancel() resolves read() with done — still surface the abort.
      if (signal?.aborted) throw signal.reason ?? new Error("aborted");
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const raw of lines) {
        const ev = handleLine(raw.replace(/\r$/, ""));
        if (ev) yield ev;
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) {
      const ev = handleLine(buffer.replace(/\r$/, ""));
      if (ev) yield ev;
    }
    const tail = flushEvent();
    if (tail) yield tail;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
}

// deno-lint-ignore no-explicit-any
function parseJSON(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// ===== Usage mapping =====
// deno-lint-ignore no-explicit-any
function openAIUsage(u: any): LLMUsage | undefined {
  if (!u) return undefined;
  return {
    promptTokens: u.prompt_tokens ?? 0,
    completionTokens: u.completion_tokens ?? 0,
    totalTokens: u.total_tokens ?? 0,
  };
}

// Responses/Anthropic style: input_tokens/output_tokens.
// deno-lint-ignore no-explicit-any
function tokensUsage(u: any): LLMUsage | undefined {
  if (!u) return undefined;
  const input = u.input_tokens ?? 0;
  const output = u.output_tokens ?? 0;
  return { promptTokens: input, completionTokens: output, totalTokens: u.total_tokens ?? input + output };
}

// ===== Chat (OpenAI chat completions) =====
function chatRequest(opts: CallLLMOptions, stream: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: opts.model,
    messages: opts.messages,
    temperature: opts.temperature ?? 0.2,
  };
  if (opts.tools) {
    body.tools = opts.tools;
    body.tool_choice = opts.toolChoice ?? "auto";
  }
  // OpenAI-compatible "reasoning effort" knob; only sent when the user picked one.
  if (opts.reasoningEffort) body.reasoning_effort = opts.reasoningEffort;
  if (stream) {
    body.stream = true;
    body.stream_options = { include_usage: true };
  }
  return body;
}

// deno-lint-ignore no-explicit-any
function parseChatCompletion(data: any): LLMResult {
  const choice = data.choices?.[0];
  if (!choice) throw new Error("No choice from DeepSeek");
  const message = choice.message ?? {};
  // deno-lint-ignore no-explicit-any
  const toolCalls: LLMToolCall[] = (message.tool_calls ?? [])
    // deno-lint-ignore no-explicit-any
    .filter((tc: any) => tc?.function?.name)
    // deno-lint-ignore no-explicit-any
    .map((tc: any) => ({ id: tc.id ?? "", name: tc.function.name, arguments: tc.function.arguments ?? "" }));
  return {
    content: message.content || "",
    reasoning: message.reasoning_content ?? message.reasoning ?? "",
    toolCalls,
    usage: openAIUsage(data.usage),
  };
}

async function parseChatStream(
  body: ReadableStream<Uint8Array>,
  onDelta: (content: string, reasoning: string) => void,
  signal?: AbortSignal,
): Promise<LLMResult> {
  let content = "";
  let reasoning = "";
  const toolCalls: LLMToolCall[] = [];
  let usage: LLMUsage | undefined;

  for await (const ev of readSSE(body, signal)) {
    if (signal?.aborted) throw signal.reason ?? new Error("aborted");
    if (ev.data === "[DONE]") continue;
    const json = parseJSON(ev.data);
    if (!json) continue;
    if (json.usage) usage = openAIUsage(json.usage);
    const delta = json.choices?.[0]?.delta;
    if (!delta) continue;
    const r = delta.reasoning_content ?? delta.reasoning;
    if (r) {
      reasoning += r;
      onDelta("", r);
    }
    if (delta.content) {
      content += delta.content;
      onDelta(delta.content, "");
    }
    // deno-lint-ignore no-explicit-any
    for (const tc of (delta.tool_calls ?? []) as any[]) {
      const index = tc.index ?? 0;
      toolCalls[index] ??= { id: "", name: "", arguments: "" };
      if (tc.id) toolCalls[index].id = tc.id;
      if (tc.function?.name) toolCalls[index].name += tc.function.name;
      if (tc.function?.arguments) toolCalls[index].arguments += tc.function.arguments;
    }
  }

  return { content, reasoning, toolCalls: toolCalls.filter((tc) => tc.id && tc.name), usage };
}

// ===== Responses (OpenAI Responses API) =====
// deno-lint-ignore no-explicit-any
type ResponsesItem = Record<string, any>;

// Converts OpenAI-style messages to Responses input items. System text
// becomes top-level `instructions`; tool calls/results become
// function_call / function_call_output items.
export function toResponsesInput(messages: LLMMessage[]): { instructions?: string; input: ResponsesItem[] } {
  const systemParts: string[] = [];
  const input: ResponsesItem[] = [];
  for (const m of messages) {
    if (m.role === "system") {
      if (m.content) systemParts.push(m.content);
      continue;
    }
    if (m.role === "user") {
      input.push({ type: "message", role: "user", content: m.content ?? "" });
      continue;
    }
    if (m.role === "assistant") {
      if (m.content) input.push({ type: "message", role: "assistant", content: m.content });
      for (const tc of m.tool_calls ?? []) {
        input.push({
          type: "function_call",
          call_id: tc.id,
          name: tc.function.name,
          arguments: tc.function.arguments,
        });
      }
      continue;
    }
    input.push({ type: "function_call_output", call_id: m.tool_call_id ?? "", output: m.content ?? "" });
  }
  return { instructions: systemParts.join("\n\n") || undefined, input };
}

function responsesRequest(opts: CallLLMOptions, stream: boolean): Record<string, unknown> {
  const { instructions, input } = toResponsesInput(opts.messages);
  const body: Record<string, unknown> = {
    model: opts.model,
    input,
    stream,
    temperature: opts.temperature ?? 0.2,
  };
  if (instructions) body.instructions = instructions;
  if (opts.tools) {
    // deno-lint-ignore no-explicit-any
    body.tools = (opts.tools as any[]).map((t) => ({
      type: "function",
      name: t.function?.name ?? t.name,
      description: t.function?.description ?? t.description,
      parameters: t.function?.parameters ?? t.parameters ?? {},
    }));
    body.tool_choice = opts.toolChoice ?? "auto";
  }
  if (opts.reasoningEffort) body.reasoning = { effort: opts.reasoningEffort };
  return body;
}

// deno-lint-ignore no-explicit-any
function parseResponsesResult(data: any): LLMResult {
  let content = "";
  let reasoning = "";
  const toolCalls: LLMToolCall[] = [];
  // deno-lint-ignore no-explicit-any
  for (const item of (data.output ?? []) as any[]) {
    if (item.type === "message") {
      // deno-lint-ignore no-explicit-any
      for (const part of (item.content ?? []) as any[]) {
        if (part.type === "output_text") content += part.text ?? "";
      }
    } else if (item.type === "reasoning") {
      // deno-lint-ignore no-explicit-any
      for (const part of (item.summary ?? item.content ?? []) as any[]) {
        reasoning += part.text ?? "";
      }
    } else if (item.type === "function_call") {
      toolCalls.push({ id: item.call_id ?? item.id ?? "", name: item.name ?? "", arguments: item.arguments ?? "" });
    }
  }
  return { content, reasoning, toolCalls, usage: tokensUsage(data.usage) };
}

async function parseResponsesStream(
  body: ReadableStream<Uint8Array>,
  onDelta: (content: string, reasoning: string) => void,
  signal?: AbortSignal,
): Promise<LLMResult> {
  let content = "";
  let reasoning = "";
  const toolCalls: LLMToolCall[] = [];
  let usage: LLMUsage | undefined;
  // deno-lint-ignore no-explicit-any
  let completed: any;

  for await (const ev of readSSE(body, signal)) {
    if (signal?.aborted) throw signal.reason ?? new Error("aborted");
    const json = parseJSON(ev.data);
    if (!json) continue;
    const type = json.type ?? ev.event;
    switch (type) {
      case "response.output_text.delta":
        if (json.delta) {
          content += json.delta;
          onDelta(json.delta, "");
        }
        break;
      case "response.reasoning_text.delta":
        if (json.delta) {
          reasoning += json.delta;
          onDelta("", json.delta);
        }
        break;
      case "response.output_item.done":
        if (json.item?.type === "function_call") {
          toolCalls.push({
            id: json.item.call_id ?? "",
            name: json.item.name ?? "",
            arguments: json.item.arguments ?? "",
          });
        }
        break;
      case "response.completed":
      case "response.incomplete":
        completed = json.response;
        usage = tokensUsage(json.response?.usage);
        break;
      case "response.failed":
        throw new Error(`DeepSeek responses API failed: ${json.response?.error?.message ?? "unknown error"}`);
      // function_call_arguments.delta/.done carry partial/full arguments;
      // the completed item arrives via response.output_item.done.
    }
  }

  // Fallback: some streams only carry the final response object.
  if (completed && (toolCalls.length === 0 || !content)) {
    const final = parseResponsesResult(completed);
    if (!content && final.content) content = final.content;
    if (toolCalls.length === 0 && final.toolCalls.length > 0) toolCalls.push(...final.toolCalls);
  }
  return { content, reasoning, toolCalls, usage };
}

// ===== Anthropic (messages API) =====
// deno-lint-ignore no-explicit-any
type AnthropicBlock = Record<string, any>;

// Converts OpenAI-style messages to Anthropic messages. System text moves
// to the top-level `system` string, tool results become tool_result blocks
// inside user messages, and consecutive same-role messages are merged
// (Anthropic requires alternating roles).
export function toAnthropicMessages(
  messages: LLMMessage[],
): { system?: string; messages: Array<{ role: "user" | "assistant"; content: AnthropicBlock[] }> } {
  const systemParts: string[] = [];
  const out: Array<{ role: "user" | "assistant"; content: AnthropicBlock[] }> = [];
  const push = (role: "user" | "assistant", block: AnthropicBlock) => {
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(block);
    else out.push({ role, content: [block] });
  };

  for (const m of messages) {
    if (m.role === "system") {
      if (m.content) systemParts.push(m.content);
      continue;
    }
    if (m.role === "user") {
      push("user", { type: "text", text: m.content ?? "" });
      continue;
    }
    if (m.role === "assistant") {
      if (m.content) push("assistant", { type: "text", text: m.content });
      for (const tc of m.tool_calls ?? []) {
        let input: unknown = {};
        try {
          input = JSON.parse(tc.function.arguments);
        } catch {
          // keep {} for unparseable arguments
        }
        push("assistant", { type: "tool_use", id: tc.id, name: tc.function.name, input });
      }
      continue;
    }
    push("user", { type: "tool_result", tool_use_id: m.tool_call_id ?? "", content: m.content ?? "" });
  }
  return { system: systemParts.join("\n\n") || undefined, messages: out };
}

function anthropicRequest(opts: CallLLMOptions, stream: boolean): Record<string, unknown> {
  const { system, messages } = toAnthropicMessages(opts.messages);
  const body: Record<string, unknown> = {
    model: opts.model,
    max_tokens: ANTHROPIC_MAX_TOKENS,
    messages,
    stream,
    temperature: opts.temperature ?? 0.2,
  };
  if (system) body.system = system;
  if (opts.tools) {
    // deno-lint-ignore no-explicit-any
    body.tools = (opts.tools as any[]).map((t) => ({
      name: t.function?.name ?? t.name,
      description: t.function?.description ?? t.description,
      input_schema: t.function?.parameters ?? t.parameters ?? {},
    }));
    body.tool_choice = { type: "auto" };
  }
  if (opts.reasoningEffort) body.thinking = { type: "enabled", budget_tokens: 1024 };
  return body;
}

// deno-lint-ignore no-explicit-any
function parseAnthropicResult(data: any): LLMResult {
  let content = "";
  let reasoning = "";
  const toolCalls: LLMToolCall[] = [];
  // deno-lint-ignore no-explicit-any
  for (const block of (data.content ?? []) as any[]) {
    if (block.type === "text") content += block.text ?? "";
    else if (block.type === "thinking") reasoning += block.thinking ?? "";
    else if (block.type === "tool_use") {
      toolCalls.push({ id: block.id ?? "", name: block.name ?? "", arguments: JSON.stringify(block.input ?? {}) });
    }
  }
  return { content, reasoning, toolCalls, usage: tokensUsage(data.usage) };
}

async function parseAnthropicStream(
  body: ReadableStream<Uint8Array>,
  onDelta: (content: string, reasoning: string) => void,
  signal?: AbortSignal,
): Promise<LLMResult> {
  let content = "";
  let reasoning = "";
  const pending = new Map<number, LLMToolCall>(); // content-block index -> tool_use in progress
  const toolCalls: LLMToolCall[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let sawUsage = false;

  for await (const ev of readSSE(body, signal)) {
    if (signal?.aborted) throw signal.reason ?? new Error("aborted");
    const json = parseJSON(ev.data);
    if (!json) continue;
    const type = json.type ?? ev.event;
    switch (type) {
      case "message_start":
        if (json.message?.usage) {
          inputTokens = json.message.usage.input_tokens ?? 0;
          outputTokens = json.message.usage.output_tokens ?? 0;
          sawUsage = true;
        }
        break;
      case "content_block_start":
        if (json.content_block?.type === "tool_use") {
          pending.set(json.index, {
            id: json.content_block.id ?? "",
            name: json.content_block.name ?? "",
            arguments: "",
          });
        }
        break;
      case "content_block_delta": {
        const delta = json.delta ?? {};
        if (delta.type === "text_delta" && delta.text) {
          content += delta.text;
          onDelta(delta.text, "");
        } else if (delta.type === "thinking_delta" && delta.thinking) {
          reasoning += delta.thinking;
          onDelta("", delta.thinking);
        } else if (delta.type === "input_json_delta") {
          const tc = pending.get(json.index);
          if (tc) tc.arguments += delta.partial_json ?? "";
        }
        break;
      }
      case "content_block_stop": {
        const tc = pending.get(json.index);
        if (tc) {
          toolCalls.push(tc);
          pending.delete(json.index);
        }
        break;
      }
      case "message_delta":
        if (json.usage) {
          outputTokens = json.usage.output_tokens ?? outputTokens;
          sawUsage = true;
        }
        break;
      case "error":
        throw new Error(`DeepSeek anthropic API error: ${json.error?.message ?? "unknown error"}`);
    }
  }

  for (const tc of pending.values()) toolCalls.push(tc); // unterminated blocks, best effort
  const usage = sawUsage
    ? { promptTokens: inputTokens, completionTokens: outputTokens, totalTokens: inputTokens + outputTokens }
    : undefined;
  return { content, reasoning, toolCalls, usage };
}

// ===== Normalized entry point =====
export async function callLLM(opts: CallLLMOptions): Promise<LLMResult> {
  const cfg = getConfig();
  if (!cfg.apiKey) throw new Error("DEEPSEEK_API_KEY is not set");
  const stream = opts.stream ?? false;

  let url: string;
  let headers: Record<string, string>;
  let body: Record<string, unknown>;
  // deno-lint-ignore no-explicit-any
  let parseResult: (data: any) => LLMResult;
  let parseStream: (
    body: ReadableStream<Uint8Array>,
    onDelta: (content: string, reasoning: string) => void,
    signal?: AbortSignal,
  ) => Promise<LLMResult>;

  if (cfg.format === "responses") {
    url = cfg.responsesUrl;
    headers = { "Content-Type": "application/json", "Authorization": `Bearer ${cfg.apiKey}` };
    body = responsesRequest(opts, stream);
    parseResult = parseResponsesResult;
    parseStream = parseResponsesStream;
  } else if (cfg.format === "anthropic") {
    url = cfg.anthropicUrl;
    headers = {
      "Content-Type": "application/json",
      "x-api-key": cfg.apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
    };
    body = anthropicRequest(opts, stream);
    parseResult = parseAnthropicResult;
    parseStream = parseAnthropicStream;
  } else {
    url = cfg.chatUrl;
    headers = { "Content-Type": "application/json", "Authorization": `Bearer ${cfg.apiKey}` };
    body = chatRequest(opts, stream);
    parseResult = parseChatCompletion;
    parseStream = parseChatStream;
  }

  const init: RequestInit = { method: "POST", headers, body: JSON.stringify(body) };

  if (!stream) {
    return await withRetry(cfg, opts.signal, async () => {
      const { response, clear } = await fetchOnce(url, init, cfg, opts.signal);
      try {
        return parseResult(await response.json());
      } finally {
        clear();
      }
    }, defaultRetryable);
  }

  // Streaming retries are only safe before the first delta was delivered;
  // after that, a retry would duplicate streamed content.
  let deltaDelivered = false;
  const onDelta = (content: string, reasoning: string) => {
    deltaDelivered = true;
    opts.onDelta?.(content, reasoning);
  };

  return await withRetry(cfg, opts.signal, async () => {
    const { response, clear, clearTimer } = await fetchOnce(url, init, cfg, opts.signal);
    // The timeout covers the connect only — but the caller-abort listener
    // must stay live until the body is fully consumed, so a stop mid-stream
    // still aborts the in-flight fetch and unblocks the reader.
    clearTimer();
    if (!response.body) {
      clear();
      throw new Error("DeepSeek stream had no body");
    }
    try {
      return await parseStream(response.body, onDelta, opts.signal);
    } catch (err) {
      if (opts.signal?.aborted) throw opts.signal.reason ?? err;
      const prefix = deltaDelivered ? "LLM stream interrupted after partial output" : "LLM stream failed";
      throw new StreamError(`${prefix}: ${errString(err)}`);
    } finally {
      clear();
    }
  }, (err) => {
    if (err instanceof StreamError) return !deltaDelivered;
    return defaultRetryable(err);
  });
}

function defaultRetryable(err: unknown): boolean {
  if (err instanceof HttpError) return isRetryableStatus(err.status);
  return true; // network errors and timeouts
}
