// main.ts
import { serve, serveTls } from "https://deno.land/std@0.224.0/http/server.ts";
import { resolve } from "https://deno.land/std@0.224.0/path/mod.ts";
import { db } from "./db.ts";
import { runAgent, summarizeConversation, SYSTEM_PROMPT, type AgentEvent, type ChatMessage } from "./agent.ts";
import { ensureWorkspace, workspacePath } from "./tools.ts";
import { loadOrCreateTls } from "./certs.ts";
import { AuthError, cleanupExpiredSessions, extractToken, getUserByToken, loginUser, logoutSession, type AuthUser } from "./auth.ts";
import { indexWorkspace, indexStats, searchSymbols, searchFiles } from "./index.ts";
import { compactConversation, estimateTokens, getConversation, getMaxIterationsForUser, recordUsage, resetConversation, saveConversation, setMaxIterationsForUser, usageSummary } from "./context.ts";
import { ALLOWED_MODELS, getModelForUser, setModelForUser } from "./models.ts";
import { spawnSubagent, listSubagents, statusOf } from "./subagents.ts";
import { DEFAULT_MAX_ITERATIONS, DEFAULT_SUBAGENT_MAX_ITERATIONS } from "./agent.ts";
import { createProject, deleteProject, getActiveProjectId, getEffectiveModel, getEffectiveWorkspace, getProject, listProjects, setActiveProjectId } from "./projects.ts";
import { fetchWebPage, searchWeb } from "./web.ts";
import { createApproval, isAlwaysApproved, listPendingApprovals, respondApproval } from "./approvals.ts";

function errString(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

const PORT = parseInt(Deno.env.get("PORT") || "8080");

try {
  await ensureWorkspace();
} catch (err) {
  console.warn(`Warning: could not create workspace directory: ${errString(err)}`);
}

// Backfill index rows created before the workspace column existed.
try {
  db.prepare("UPDATE indexed_files SET workspace = ? WHERE workspace = ''").run(resolve(workspacePath));
} catch {
  // ignored
}

// Check Deno's run permission so we can route approvals through the web UI
// instead of letting Deno prompt on the terminal.
function hasRunPermission(): boolean {
  try {
    return Deno.permissions.querySync({ name: "run" }).state === "granted";
  } catch {
    return false;
  }
}

if (!hasRunPermission()) {
  console.warn(
    "⚠️  Deno run permission is NOT granted. Shell commands (!cmd) will be rejected until Yoke " +
    "is restarted with the --allow-run flag (approvals then happen in the web UI, not the terminal).",
  );
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function errorResponse(err: unknown): Response {
  if (err instanceof AuthError) return json({ error: err.message }, err.status);
  return json({ error: errString(err) }, 500);
}

type Auth = { token: string; user: AuthUser };

function requireAuth(request: Request): Auth | Response {
  const token = extractToken(request);
  const user = getUserByToken(token);
  if (!user) return json({ error: "Unauthorized: invalid or expired session." }, 401);
  return { token: token!, user };
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = await request.json();
    if (typeof body !== "object" || body === null) throw new Error();
    return body as Record<string, unknown>;
  } catch {
    throw new AuthError(400, "Invalid JSON body.");
  }
}

// ===== Shell execution (used by the "!command" UI operator) =====
const SHELL_TIMEOUT_MS = 15_000;
const MAX_SHELL_OUTPUT_CHARS = 50_000;

async function runShellCommand(command: string, cwd: string): Promise<string> {
  const isWindows = Deno.build.os === "windows";
  const shell = isWindows ? "cmd" : "sh";
  const args = isWindows ? ["/c", command] : ["-c", command];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SHELL_TIMEOUT_MS);
  try {
    const result = await new Deno.Command(shell, {
      args,
      cwd,
      stdout: "piped",
      stderr: "piped",
      signal: controller.signal,
    }).output();
    const decoder = new TextDecoder();
    let output = `${decoder.decode(result.stdout)}${decoder.decode(result.stderr)}`.trim();
    if (output.length > MAX_SHELL_OUTPUT_CHARS) {
      output = output.slice(0, MAX_SHELL_OUTPUT_CHARS) + "\n...[truncated]";
    }
    if (!output) output = `(exit code ${result.code}, no output)`;
    else if (result.code !== 0) output = `(exit code ${result.code})\n${output}`;
    return output;
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      return `Command timed out after ${SHELL_TIMEOUT_MS / 1000} seconds.`;
    }
    throw new Error(`Failed to run command: ${errString(err)}`);
  } finally {
    clearTimeout(timer);
  }
}

async function handleApi(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  if (path === "/api/login" && method === "POST") {
    try {
      const body = await readJson(request);
      const { token, user } = await loginUser(
        String(body.username ?? ""),
        String(body.password ?? ""),
      );
      return json({ token, user });
    } catch (err) {
      return errorResponse(err);
    }
  }

  if (path === "/api/logout" && method === "POST") {
    logoutSession(extractToken(request));
    return json({ ok: true });
  }

  if (path === "/api/me" && method === "GET") {
    const auth = requireAuth(request);
    if (auth instanceof Response) return auth;
    return json({ user: auth.user });
  }

  if (path === "/api/status" && method === "GET") {
    const auth = requireAuth(request);
    if (auth instanceof Response) return auth;
    const projectId = getActiveProjectId(auth.user.id);
    const project = projectId != null ? getProject(projectId) : null;
    const workspace = getEffectiveWorkspace(auth.user.id, projectId);
    const messages = getConversation(auth.user.id, projectId ?? 0);
    return json({
      user: auth.user,
      model: getEffectiveModel(auth.user.id, projectId),
      user_model: getModelForUser(auth.user.id),
      models: ALLOWED_MODELS,
      max_iterations: getMaxIterationsForUser(auth.user.id) ?? DEFAULT_MAX_ITERATIONS,
      project,
      projects: listProjects(),
      workspace,
      index: indexStats(workspace),
      context: {
        messages: messages.length,
        estimated_tokens: estimateTokens(messages),
      },
      usage: usageSummary(auth.user.id),
    });
  }

  if (path === "/api/projects" && method === "GET") {
    const auth = requireAuth(request);
    if (auth instanceof Response) return auth;
    return json({ projects: listProjects() });
  }

  if (path === "/api/projects" && method === "POST") {
    const auth = requireAuth(request);
    if (auth instanceof Response) return auth;
    try {
      const body = await readJson(request);
      const project = createProject(
        String(body.name ?? ""),
        String(body.path ?? ""),
        String(body.model ?? ""),
      );
      await Deno.mkdir(project.path, { recursive: true });
      return json({ project }, 201);
    } catch (err) {
      return errorResponse(err);
    }
  }

  if (path.startsWith("/api/projects/") && method === "DELETE") {
    const auth = requireAuth(request);
    if (auth instanceof Response) return auth;
    const id = Number(path.slice("/api/projects/".length));
    if (!Number.isInteger(id) || id <= 0) return json({ error: "Invalid project id." }, 400);
    if (!deleteProject(id)) return json({ error: "Project not found." }, 404);
    return json({ ok: true });
  }

  if (path === "/api/project" && method === "POST") {
    const auth = requireAuth(request);
    if (auth instanceof Response) return auth;
    try {
      const body = await readJson(request);
      const projectId = body.project_id == null ? null : Number(body.project_id);
      if (projectId !== null && (!Number.isInteger(projectId) || projectId < 1)) {
        return json({ error: "Invalid project_id." }, 400);
      }
      if (!setActiveProjectId(auth.user.id, projectId)) {
        return json({ error: "Project not found." }, 404);
      }
      const effectiveProject = projectId != null ? getProject(projectId) : null;
      return json({
        project: effectiveProject,
        workspace: getEffectiveWorkspace(auth.user.id, projectId),
        model: getEffectiveModel(auth.user.id, projectId),
      });
    } catch (err) {
      return errorResponse(err);
    }
  }

  if (path === "/api/maxtries" && method === "POST") {
    const auth = requireAuth(request);
    if (auth instanceof Response) return auth;
    try {
      const body = await readJson(request);
      const n = Number(body.max_iterations);
      if (!Number.isFinite(n) || n < 1 || n > 100) {
        return json({ error: "max_iterations must be a number between 1 and 100." }, 400);
      }
      setMaxIterationsForUser(auth.user.id, Math.floor(n));
      return json({ max_iterations: getMaxIterationsForUser(auth.user.id) ?? DEFAULT_MAX_ITERATIONS });
    } catch (err) {
      return errorResponse(err);
    }
  }

  if (path === "/api/model" && method === "POST") {
    const auth = requireAuth(request);
    if (auth instanceof Response) return auth;
    try {
      const body = await readJson(request);
      const model = String(body.model ?? "").trim();
      if (!setModelForUser(auth.user.id, model)) {
        return json({ error: `Unknown model '${model}'. Available: ${ALLOWED_MODELS.join(", ")}` }, 400);
      }
      return json({ model });
    } catch (err) {
      return errorResponse(err);
    }
  }

  if (path === "/api/compact" && method === "POST") {
    const auth = requireAuth(request);
    if (auth instanceof Response) return auth;
    const projectId = getActiveProjectId(auth.user.id) ?? 0;
    let keep = 8;
    try {
      const body = await readJson(request);
      if (typeof body.keep === "number") {
        keep = Math.max(1, Math.min(100, Math.floor(body.keep)));
      }
    } catch {
      // empty body → default keep
    }
    const messages = compactConversation(auth.user.id, projectId, keep);
    return json({
      kept: messages.filter((m) => m.role !== "system").length,
      messages: messages.length,
      estimated_tokens: estimateTokens(messages),
    });
  }

  if (path === "/api/reset" && method === "POST") {
    const auth = requireAuth(request);
    if (auth instanceof Response) return auth;
    resetConversation(auth.user.id, getActiveProjectId(auth.user.id) ?? 0);
    return json({ ok: true });
  }

  if (path === "/api/summarize" && method === "POST") {
    const auth = requireAuth(request);
    if (auth instanceof Response) return auth;
    try {
      const projectId = getActiveProjectId(auth.user.id) ?? 0;
      const model = getEffectiveModel(auth.user.id, projectId || null);
      const messages = getConversation(auth.user.id, projectId);
      const nonSystem = messages.filter((m) => m.role !== "system");
      if (nonSystem.length === 0) return json({ error: "Nothing to summarize yet." }, 400);
      const { summary, usage } = await summarizeConversation(messages, model);
      const newContext: ChatMessage[] = [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: `Summary of the conversation so far:\n\n${summary}` },
      ];
      saveConversation(auth.user.id, newContext, projectId);
      recordUsage(auth.user.id, usage, model);
      return json({
        summary,
        kept: newContext.filter((m) => m.role !== "system").length,
        estimated_tokens: estimateTokens(newContext),
      });
    } catch (err) {
      return errorResponse(err);
    }
  }

  if (path === "/api/shell" && method === "POST") {
    const auth = requireAuth(request);
    if (auth instanceof Response) return auth;
    try {
      // Never attempt execution without Deno's run permission: that would
      // trigger a prompt on the server terminal. Fail with a clear message.
      if (!hasRunPermission()) {
        return json({
          error: "Shell execution requires Deno run permission. Restart Yoke with the --allow-run flag so approvals happen in the web UI.",
        }, 403);
      }
      const body = await readJson(request);
      const command = String(body.command ?? "").trim();
      if (!command) return json({ error: "Missing 'command' field" }, 400);
      const cwd = getEffectiveWorkspace(auth.user.id);

      // Human-in-the-loop approval: unless this exact command was already
      // approved ("allow always"), wait for the user to approve it in the UI.
      if (!isAlwaysApproved(command)) {
        const approved = await createApproval(command, auth.user.username);
        if (!approved) {
          return json({ error: "Command was not approved." }, 403);
        }
      }

      return json({ output: await runShellCommand(command, cwd) });
    } catch (err) {
      return errorResponse(err);
    }
  }

  if (path === "/api/subagents" && method === "GET") {
    const auth = requireAuth(request);
    if (auth instanceof Response) return auth;
    return json({ subagents: listSubagents().map(statusOf) });
  }

  if (path === "/api/subagents" && method === "POST") {
    const auth = requireAuth(request);
    if (auth instanceof Response) return auth;
    try {
      const body = await readJson(request);
      const task = String(body.task ?? "").trim();
      if (!task) return json({ error: "Missing 'task' field" }, 400);
      const record = spawnSubagent(
        task,
        String(body.name ?? "subagent"),
        Number.isFinite(Number(body.max_iterations))
          ? Math.min(Math.max(Math.floor(Number(body.max_iterations)), 1), 100)
          : DEFAULT_SUBAGENT_MAX_ITERATIONS,
        getEffectiveWorkspace(auth.user.id),
      );
      return json({ subagent: statusOf(record) }, 201);
    } catch (err) {
      return errorResponse(err);
    }
  }

  if (path === "/api/web" && method === "POST") {
    const auth = requireAuth(request);
    if (auth instanceof Response) return auth;
    try {
      const body = await readJson(request);
      const action = String(body.action ?? "");
      if (action === "fetch") {
        const url = String(body.url ?? "").trim();
        if (!url) return json({ error: "Missing 'url' field." }, 400);
        return json({ result: await fetchWebPage(url) });
      }
      if (action === "search") {
        const query = String(body.query ?? "").trim();
        if (!query) return json({ error: "Missing 'query' field." }, 400);
        return json({ result: await searchWeb(query, Math.min(Math.max(Number(body.max_results) || 6, 1), 10)) });
      }
      return json({ error: "action must be 'fetch' or 'search'." }, 400);
    } catch (err) {
      // Invalid URLs, blocked protocols, and remote failures are all client-visible errors.
      return json({ error: errString(err) }, 400);
    }
  }

  if (path === "/api/approvals" && method === "GET") {
    const auth = requireAuth(request);
    if (auth instanceof Response) return auth;
    return json({ approvals: listPendingApprovals() });
  }

  if (path.startsWith("/api/approvals/") && method === "POST") {
    const auth = requireAuth(request);
    if (auth instanceof Response) return auth;
    try {
      const id = path.slice("/api/approvals/".length);
      const body = await readJson(request);
      const action = String(body.action ?? "");
      if (action !== "approve" && action !== "deny") {
        return json({ error: "action must be 'approve' or 'deny'." }, 400);
      }
      const always = body.always === true;
      if (!respondApproval(id, action === "approve", always)) {
        return json({ error: "Approval not found or already answered." }, 404);
      }
      return json({ ok: true });
    } catch (err) {
      return errorResponse(err);
    }
  }

  if (path === "/api/index" && method === "POST") {
    const auth = requireAuth(request);
    if (auth instanceof Response) return auth;
    try {
      return json(await indexWorkspace(getEffectiveWorkspace(auth.user.id)));
    } catch (err) {
      return errorResponse(err);
    }
  }

  if (path === "/api/search" && method === "GET") {
    const auth = requireAuth(request);
    if (auth instanceof Response) return auth;
    const q = url.searchParams.get("q")?.trim() ?? "";
    if (!q) return json({ error: "Missing 'q' query parameter." }, 400);
    const workspace = getEffectiveWorkspace(auth.user.id);
    return json({
      symbols: searchSymbols(workspace, q, 50),
      files: searchFiles(workspace, q, 50),
    });
  }

  if (path === "/api/agent" && method === "POST") {
    const auth = requireAuth(request);
    if (auth instanceof Response) return auth;

    try {
      const body = await readJson(request);
      const { task } = body;
      if (!task || typeof task !== "string") {
        return json({ error: "Missing 'task' field" }, 400);
      }

      // Yoke streaming via SSE
      const projectId = getActiveProjectId(auth.user.id) ?? 0;
      const model = getEffectiveModel(auth.user.id, projectId || null);
      const workspace = getEffectiveWorkspace(auth.user.id, projectId || null);
      const stream = new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "start" })}\n\n`));

          // Load this user's persistent conversation for the active project;
          // runAgent appends the new task and mutates the array as it goes.
          const conversation = getConversation(auth.user.id, projectId) as ChatMessage[];

          runAgent(conversation, task, (event: AgentEvent) => {
            const data = JSON.stringify(event);
            controller.enqueue(encoder.encode(`data: ${data}\n\n`));
          }, {
            model,
            maxIterations: getMaxIterationsForUser(auth.user.id) ?? undefined,
            workspace,
          }).then((result) => {
            saveConversation(auth.user.id, conversation, projectId);
            recordUsage(auth.user.id, result.usage, model);
            controller.close();
          }).catch((err) => {
            const errorEvent = JSON.stringify({ type: "error", error: errString(err) });
            controller.enqueue(encoder.encode(`data: ${errorEvent}\n\n`));
            controller.close();
          });
        }
      });

      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
        },
      });
    } catch (err) {
      return errorResponse(err);
    }
  }

  return json({ error: "Not found" }, 404);
}

async function serveStatic(path: string): Promise<Response> {
  try {
    const file = await Deno.readFile(path);
    const ext = path.split(".").pop();
    const contentType = ext === "html" ? "text/html" :
                       ext === "css" ? "text/css" :
                       ext === "js" ? "application/javascript" :
                       "text/plain";
    return new Response(file, { headers: { "Content-Type": contentType } });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}

async function handler(request: Request): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname === "/" || url.pathname === "/index.html") {
    return await serveStatic("./public/index.html");
  }

  if (url.pathname.startsWith("/api/")) {
    return await handleApi(request);
  }

  return new Response("Not found", { status: 404 });
}

cleanupExpiredSessions();
setInterval(cleanupExpiredSessions, 60 * 60 * 1000);

const tls = await loadOrCreateTls();
const scheme = tls ? "https" : "http";
console.log(`🪢 Yoke harness running on ${scheme}://localhost:${PORT}`);
console.log(`   Auth via username/password. Login or register at ${scheme}://localhost:${PORT}`);

if (tls) {
  await serveTls(handler, { port: PORT, cert: tls.cert, key: tls.key });
} else {
  await serve(handler, { port: PORT });
}
