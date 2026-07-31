// agent.ts
import { resolve } from "https://deno.land/std@0.224.0/path/mod.ts";
import { readFileTool, writeFileTool, listDirTool, workspacePath } from "./tools.ts";
import { searchCode } from "./index.ts";
import { fetchWebPage, searchWeb } from "./web.ts";
import { createApproval, isAlwaysApproved } from "./approvals.ts";
import { formatExecResult, getHostByName, sftpReadFile, sftpUploadFile, sshDeploy, sshExec, sshHomeDir, sshStatus, truncate } from "./hosts.ts";
import { getSubagent, listSubagents, spawnSubagent, statusOf, waitForSubagent } from "./subagents.ts";

// ===== Types =====
export type AgentEvent =
  | { type: "step"; step: number; action: string; args: Record<string, unknown>; result?: unknown; error?: string }
  | { type: "usage"; promptTokens: number; completionTokens: number; totalTokens: number }
  | { type: "finish"; finalAnswer: string }
  | { type: "error"; error: string };

export type ToolCall = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
};

export type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
};

export type AgentUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
};

// ===== Environment =====
function errString(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

const DEEPSEEK_API_KEY = Deno.env.get("DEEPSEEK_API_KEY");
const DEEPSEEK_BASE_URL = Deno.env.get("DEEPSEEK_BASE_URL") || "https://api.deepseek.com/v1";
const DEEPSEEK_MODEL = Deno.env.get("DEEPSEEK_MODEL") || "deepseek-v4-flash";
const MAX_TOOL_RESULT_CHARS = 25000;

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.floor(value), min), max);
}

function envInt(name: string, fallback: number, min: number, max: number): number {
  const parsed = parseInt(Deno.env.get(name) || "", 10);
  return clampInt(Number.isNaN(parsed) ? undefined : parsed, fallback, min, max);
}

export const DEFAULT_MAX_ITERATIONS = envInt("MAX_ITERATIONS", 10, 1, 100);
export const DEFAULT_SUBAGENT_MAX_ITERATIONS = envInt("MAX_SUBAGENT_ITERATIONS", DEFAULT_MAX_ITERATIONS, 1, 100);

export const SYSTEM_PROMPT = `You are a coding assistant that uses tools to complete tasks.
You have access to read_file, write_file, list_directory, search_code, and finish.
Always decide which tool to call next. When the task is complete, call the finish tool with a final answer.
If a tool call returns an error, you may retry with corrected arguments.
The workspace is limited to the directory provided.
The codebase is indexed: use search_code to find symbols or files before reading them.
This is a continuing conversation: use prior context to answer follow-up tasks.
For parallel subtasks, spawn background subagents with spawn_subagent, poll their status with check_subagent (periodically), or block for a result with wait_subagent. Use list_subagents to see active subagents.
You can also access the web: use web_search to find information and web_fetch to read a specific page (returned as markdown text).
You can manage remote servers: remote_status checks a configured host, remote_exec runs commands over SSH, remote_upload/remote_fetch transfer files via SFTP, and deploy ships the workspace to a host. Remote operations that change state require user approval.`;

// ===== Tool definitions =====
const TOOLS = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read the content of a file.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path to the file (relative to workspace)." }
        },
        required: ["path"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Write content to a file.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path to the file (relative to workspace)." },
          content: { type: "string", description: "Content to write." }
        },
        required: ["path", "content"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "list_directory",
      description: "List the contents of a directory.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Directory path (relative to workspace)." }
        },
        required: ["path"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "search_code",
      description: "Search the indexed workspace for code symbols (functions, classes, etc.) or file paths matching a query.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Substring to search for in symbol names, signatures, or file paths." }
        },
        required: ["query"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "finish",
      description: "Call this when the task is complete.",
      parameters: {
        type: "object",
        properties: {
          answer: { type: "string", description: "The final answer to the user's task." }
        },
        required: ["answer"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "spawn_subagent",
      description: "Spawn a background subagent that works on a subtask asynchronously. Returns its id; poll with check_subagent or block with wait_subagent.",
      parameters: {
        type: "object",
        properties: {
          task: { type: "string", description: "The subtask for the subagent to complete." },
          name: { type: "string", description: "Optional short name for the subagent." },
          max_iterations: { type: "number", description: `Optional max LLM iterations for the subagent (default ${DEFAULT_SUBAGENT_MAX_ITERATIONS}).` }
        },
        required: ["task"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "check_subagent",
      description: "Check the status of a subagent (running/done/error). Use periodically to poll for completion.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Subagent id as returned by spawn_subagent." }
        },
        required: ["id"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "wait_subagent",
      description: "Block until a subagent finishes (or a timeout passes) and return its status and result.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Subagent id as returned by spawn_subagent." },
          timeout_seconds: { type: "number", description: "Max seconds to wait (default 30, max 120)." }
        }
      },
      required: ["id"]
    }
  },
  {
    type: "function",
    function: {
      name: "list_subagents",
      description: "List all subagents with their status.",
      parameters: {
        type: "object",
        properties: {}
      }
    }
  },
  {
    type: "function",
    function: {
      name: "web_search",
      description: "Search the web for a query. Returns a list of titles, URLs, and snippets.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "The search query." }
        },
        required: ["query"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "web_fetch",
      description: "Fetch a web page and return its content as text/markdown.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "The http(s) URL to fetch." }
        },
        required: ["url"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "remote_exec",
      description: "Run a shell command on a configured remote host over SSH. Requires user approval in the UI.",
      parameters: {
        type: "object",
        properties: {
          host: { type: "string", description: "The name of a configured host (see /api/hosts)." },
          command: { type: "string", description: "The shell command to run on the remote host." }
        },
        required: ["host", "command"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "remote_status",
      description: "Check the status (hostname, uptime, disk, memory) of a configured remote host.",
      parameters: {
        type: "object",
        properties: {
          host: { type: "string", description: "The name of a configured host." }
        },
        required: ["host"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "remote_upload",
      description: "Upload a local file (relative to the workspace) to a remote host over SFTP. Requires user approval.",
      parameters: {
        type: "object",
        properties: {
          host: { type: "string", description: "The name of a configured host." },
          local_path: { type: "string", description: "Local file path (relative to the workspace)." },
          remote_path: { type: "string", description: "Destination path on the remote host." }
        },
        required: ["host", "local_path", "remote_path"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "remote_fetch",
      description: "Read a file from a remote host over SFTP. Requires user approval.",
      parameters: {
        type: "object",
        properties: {
          host: { type: "string", description: "The name of a configured host." },
          remote_path: { type: "string", description: "Path of the remote file to read." }
        },
        required: ["host", "remote_path"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "deploy",
      description: "Deploy the current workspace (or project) to a remote host over SFTP, optionally running a post-deploy command. Requires user approval.",
      parameters: {
        type: "object",
        properties: {
          host: { type: "string", description: "The name of a configured host." },
          project: { type: "string", description: "Optional project name to deploy; defaults to the active project." },
          remote_path: { type: "string", description: "Optional destination directory on the host (defaults to ~/yoke-deploy/<project>)." },
          post_deploy: { type: "string", description: "Optional shell command to run on the host after uploading." }
        },
        required: ["host"]
      }
    }
  }
];

// ===== Local implementations =====
// Every tool implementation receives (args, workspace) — the work directory
// of the current project (or the default workspace).
const TOOL_IMPLEMENTATIONS: Record<string, (args: any, workspace: string) => Promise<unknown>> = {
  read_file: (args, ws) => readFileTool(args.path, ws),
  write_file: (args, ws) => writeFileTool(args.path, args.content, ws),
  list_directory: (args, ws) => listDirTool(args.path, ws),
  search_code: async (args, ws) => searchCode(args.query, ws),
  spawn_subagent: async (args, ws) => {
    const record = spawnSubagent(
      String(args.task ?? ""),
      String(args.name ?? "subagent"),
      clampInt(Number(args.max_iterations), DEFAULT_SUBAGENT_MAX_ITERATIONS, 1, 100),
      ws,
    );
    return { id: record.id, name: record.name, status: record.status };
  },
  check_subagent: async (args) => {
    const record = getSubagent(String(args.id ?? ""));
    if (!record) return { error: `Unknown subagent id '${args.id}'` };
    return statusOf(record);
  },
  wait_subagent: async (args) => {
    const record = getSubagent(String(args.id ?? ""));
    if (!record) return { error: `Unknown subagent id '${args.id}'` };
    const timeoutSeconds = Math.min(Math.max(Number(args.timeout_seconds) || 30, 1), 120);
    const waited = await waitForSubagent(record.id, timeoutSeconds * 1000);
    return statusOf(waited);
  },
  list_subagents: async () => listSubagents().map(statusOf),
  web_search: async (args) => searchWeb(String(args.query ?? ""), Math.min(Math.max(Number(args.max_results) || 6, 1), 10)),
  web_fetch: async (args) => fetchWebPage(String(args.url ?? "")),
  remote_exec: async (args, ws) => {
    const host = getHostByName(String(args.host ?? ""));
    if (!host) return { error: `Unknown host '${args.host}'. Configure it via /api/hosts.` };
    const command = String(args.command ?? "").trim();
    if (!command) return { error: "Missing 'command'." };
    const label = `[ssh ${host.name}] ${command}`;
    if (!isAlwaysApproved(label) && !await createApproval(label, "agent")) {
      return { error: "Command was not approved." };
    }
    return truncate(formatExecResult(await sshExec(host, command)));
  },
  remote_status: async (args) => {
    const host = getHostByName(String(args.host ?? ""));
    if (!host) return { error: `Unknown host '${args.host}'. Configure it via /api/hosts.` };
    return await sshStatus(host);
  },
  remote_upload: async (args, ws) => {
    const host = getHostByName(String(args.host ?? ""));
    if (!host) return { error: `Unknown host '${args.host}'.` };
    const localPath = String(args.local_path ?? "").trim();
    const remotePath = String(args.remote_path ?? "").trim();
    if (!localPath || !remotePath) return { error: "local_path and remote_path are required." };
    const fullLocal = resolve(ws, localPath);
    const label = `[upload to ${host.name}] ${localPath} -> ${remotePath}`;
    if (!isAlwaysApproved(label) && !await createApproval(label, "agent")) {
      return { error: "Upload was not approved." };
    }
    const bytes = await sftpUploadFile(host, fullLocal, remotePath);
    return `Uploaded ${bytes} bytes to ${host.name}:${remotePath}.`;
  },
  remote_fetch: async (args) => {
    const host = getHostByName(String(args.host ?? ""));
    if (!host) return { error: `Unknown host '${args.host}'.` };
    const remotePath = String(args.remote_path ?? "").trim();
    if (!remotePath) return { error: "Missing 'remote_path'." };
    const label = `[fetch from ${host.name}] ${remotePath}`;
    if (!isAlwaysApproved(label) && !await createApproval(label, "agent")) {
      return { error: "Fetch was not approved." };
    }
    return truncate(await sftpReadFile(host, remotePath));
  },
  deploy: async (args, ws) => {
    const host = getHostByName(String(args.host ?? ""));
    if (!host) return { error: `Unknown host '${args.host}'.` };
    const projectName = String(args.project ?? "").trim() || "workspace";
    const remotePath = String(args.remote_path ?? "").trim();
    const remoteDir = remotePath || `${(await sshHomeDir(host)).replace(/[\\/]+$/, "")}/yoke-deploy/${projectName}`;
    const postDeploy = args.post_deploy ? String(args.post_deploy).trim() : undefined;
    const label = `[deploy to ${host.name}] ${projectName} -> ${remoteDir}`;
    if (!isAlwaysApproved(label) && !await createApproval(label, "agent")) {
      return { error: "Deploy was not approved." };
    }
    return await sshDeploy(host, ws, remoteDir, postDeploy);
  },
  finish: async (args) => args.answer,
};

// ===== DeepSeek call =====
type ApiUsage = { prompt_tokens: number; completion_tokens: number; total_tokens: number };

async function callDeepSeek(
  messages: ChatMessage[],
  model: string,
): Promise<{ toolCalls?: ToolCall[]; finishAnswer?: string; usage?: ApiUsage }> {
  if (!DEEPSEEK_API_KEY) {
    console.warn("Using mock reasoning (no DEEPSEEK_API_KEY)");
    return mockReasoning(messages);
  }

  const response = await fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${DEEPSEEK_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      messages,
      tools: TOOLS,
      tool_choice: "auto",
      temperature: 0.2,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`DeepSeek API error: ${response.status} - ${errorText}`);
  }

  const data = await response.json();
  const choice = data.choices?.[0];
  if (!choice) throw new Error("No choice from DeepSeek");

  const usage: ApiUsage | undefined = data.usage;
  const message = choice.message;
  if (message.tool_calls && message.tool_calls.length > 0) {
    return { toolCalls: message.tool_calls, usage };
  } else {
    return { finishAnswer: message.content || "", usage };
  }
}

// ===== Conversation summarization (EXPORTED) =====
export async function summarizeConversation(
  messages: ChatMessage[],
  model = DEEPSEEK_MODEL,
): Promise<{ summary: string; usage: AgentUsage }> {
  const transcript = messages
    .filter((m) => m.role !== "system")
    .map((m) => {
      if (m.role === "tool") return `[tool result] ${m.content}`;
      if (m.tool_calls && m.tool_calls.length > 0) {
        return `[assistant tools] ${m.tool_calls.map((t) => `${t.function.name}(${t.function.arguments})`).join(", ")}`;
      }
      return `[${m.role}] ${m.content}`;
    })
    .join("\n\n");

  if (!DEEPSEEK_API_KEY) {
    const last = transcript.slice(0, 300);
    return {
      summary: `(mock summary) The conversation contained ${messages.filter((m) => m.role !== "system").length} message(s). Last activity: ${last}`,
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    };
  }

  const prompt = `Summarize this conversation between a user and a coding assistant. Preserve the user's goals, key findings, file paths, symbols, and any pending or outstanding tasks. Keep it concise but complete.\n\n${transcript}\n\nSummary:`;

  const response = await fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${DEEPSEEK_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.2,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`DeepSeek API error: ${response.status} - ${errorText}`);
  }

  const data = await response.json();
  const summary = data.choices?.[0]?.message?.content || "";
  const usage: ApiUsage = data.usage;
  return {
    summary,
    usage: {
      promptTokens: usage?.prompt_tokens ?? 0,
      completionTokens: usage?.completion_tokens ?? 0,
      totalTokens: usage?.total_tokens ?? 0,
    },
  };
}

// ===== Mock (fallback) =====
function mockReasoning(messages: ChatMessage[]): { toolCalls?: ToolCall[]; finishAnswer?: string } {
  const last = messages[messages.length - 1];
  if (last.role === "tool") {
    return {
      toolCalls: [{
        id: "mock-finish",
        type: "function",
        function: {
          name: "finish",
          arguments: JSON.stringify({ answer: `Task completed (mock). Last tool result: ${last.content}` }),
        },
      }],
    };
  }

  const lastUser = [...messages].reverse().find(m => m.role === "user");
  const task = lastUser?.content || "";
  const lower = task.toLowerCase();

  if (lower.includes("read")) {
    return {
      toolCalls: [{
        id: "mock1",
        type: "function",
        function: { name: "read_file", arguments: '{"path":"example.txt"}' }
      }]
    };
  } else if (lower.includes("write")) {
    return {
      toolCalls: [{
        id: "mock2",
        type: "function",
        function: { name: "write_file", arguments: '{"path":"output.txt","content":"Hello, world!"}' }
      }]
    };
  } else if (lower.includes("list")) {
    return {
      toolCalls: [{
        id: "mock3",
        type: "function",
        function: { name: "list_directory", arguments: '{"path":"."}' }
      }]
    };
  } else if (lower.includes("spawn") || lower.includes("subagent")) {
    return {
      toolCalls: [{
        id: "mock-spawn",
        type: "function",
        function: { name: "spawn_subagent", arguments: '{"name":"worker","task":"list directory"}' }
      }]
    };
  } else {
    return {
      toolCalls: [{
        id: "mock4",
        type: "function",
        function: { name: "finish", arguments: '{"answer":"Task completed (mock)."}' }
      }]
    };
  }
}

// ===== Main agent loop (EXPORTED) =====
export async function runAgent(
  messages: ChatMessage[],
  task: string,
  onEvent: (event: AgentEvent) => void,
  options: { model?: string; maxIterations?: number; workspace?: string } = {},
): Promise<{ usage: AgentUsage }> {
  const model = options.model || DEEPSEEK_MODEL;
  const maxIterations = clampInt(options.maxIterations, DEFAULT_MAX_ITERATIONS, 1, 100);
  const workspace = options.workspace || workspacePath;
  if (!messages.some((m) => m.role === "system")) {
    messages.unshift({ role: "system", content: SYSTEM_PROMPT });
  }
  messages.push({ role: "user", content: task });

  const usage: AgentUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  const emitUsage = () => {
    if (usage.totalTokens > 0) {
      onEvent({ type: "usage", ...usage });
    }
  };
  const finish = (finalAnswer: string) => {
    emitUsage();
    onEvent({ type: "finish", finalAnswer });
  };

  let iteration = 0;

  while (iteration < maxIterations) {
    iteration++;

    let toolCalls: ToolCall[] | undefined;
    let finishAnswer: string | undefined;

    try {
      const response = await callDeepSeek(messages, model);
      toolCalls = response.toolCalls;
      finishAnswer = response.finishAnswer;
      if (response.usage) {
        usage.promptTokens += response.usage.prompt_tokens;
        usage.completionTokens += response.usage.completion_tokens;
        usage.totalTokens += response.usage.total_tokens;
      }
    } catch (err) {
      onEvent({ type: "error", error: errString(err) });
      return { usage };
    }

    if (finishAnswer !== undefined) {
      finish(finishAnswer);
      return { usage };
    }

    if (!toolCalls || toolCalls.length === 0) {
      onEvent({ type: "error", error: "LLM did not provide a tool call or final answer." });
      return { usage };
    }

    messages.push({
      role: "assistant",
      content: null,
      tool_calls: toolCalls,
    });

    // Execute EVERY tool call and push a matching tool message for each
    // tool_call_id. The API rejects an assistant tool_calls message unless
    // every tool_call_id is answered by a tool message.
    for (const toolCall of toolCalls) {
      const name = toolCall.function.name;
      let args: Record<string, unknown> = {};
      let error: string | undefined;

      try {
        args = JSON.parse(toolCall.function.arguments);
      } catch {
        error = `Invalid JSON arguments for ${name}: ${toolCall.function.arguments}`;
      }

      let result: unknown;
      if (!error) {
        const impl = TOOL_IMPLEMENTATIONS[name];
        if (!impl) {
          error = `Unknown tool: ${name}`;
        } else {
          try {
            result = await impl(args, workspace);
          } catch (err) {
            error = errString(err);
          }
        }
      }

      onEvent({ type: "step", step: iteration, action: name, args, result, error });

      let toolResponseContent: string;
      if (error) {
        toolResponseContent = `Error: ${error}`;
      } else if (result === undefined) {
        toolResponseContent = "OK";
      } else {
        toolResponseContent = JSON.stringify(result);
      }
      if (toolResponseContent.length > MAX_TOOL_RESULT_CHARS) {
        toolResponseContent = toolResponseContent.slice(0, MAX_TOOL_RESULT_CHARS) +
          "\n...[truncated]";
      }

      messages.push({
        role: "tool",
        content: toolResponseContent,
        tool_call_id: toolCall.id,
      });

      if (name === "finish" && !error) {
        finishAnswer = typeof result === "string" ? result : (args.answer as string) || "Task completed.";
      }
    }

    if (finishAnswer !== undefined) {
      finish(finishAnswer);
      return { usage };
    }
  }

  finish("Max iterations reached without finishing.");
  return { usage };
}