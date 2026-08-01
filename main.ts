// main.ts
import { serve, serveTls } from "https://deno.land/std@0.224.0/http/server.ts";
import { resolve } from "https://deno.land/std@0.224.0/path/mod.ts";
import { db } from "./db.ts";
import { runAgent, summarizeConversation, SYSTEM_PROMPT, type AgentEvent, type ChatMessage, DEFAULT_MAX_ITERATIONS, MAX_MAX_ITERATIONS } from "./agent.ts";
import { ensureWorkspace, hasRunPermission, runShellCommand, SHELL_TIMEOUT_MS, workspacePath } from "./tools.ts";
import { loadOrCreateTls } from "./certs.ts";
import { AuthError, cleanupExpiredSessions, createUser, extractToken, getUserByToken, loginUser, logoutSession, type AuthUser } from "./auth.ts";
import { indexWorkspace, indexStats, searchSymbols, searchFiles } from "./index.ts";
import { appendConversation, archiveAllActive, compactConversation, conversationStats, estimateTokens, getConversation, getHistory, getMaxIterationsForUser, recordUsage, resetConversation, restoreConversation, setMaxIterationsForUser, usageSummary } from "./context.ts";
import { ALLOWED_MODELS, getModelForUser, setModelForUser, THINKING_EFFORTS, getThinkingEffortForUser, setThinkingEffortForUser } from "./models.ts";
import { spawnSubagent, listSubagents, statusOf } from "./subagents.ts";
import { createProject, deleteProject, getActiveProjectId, getEffectiveModel, getEffectiveWorkspace, getProject, listProjects, setActiveProjectId, updateProject } from "./projects.ts";
import { fetchWebPage, searchWeb } from "./web.ts";
import { createApproval, isAlwaysApproved, listPendingApprovals, respondApproval } from "./approvals.ts";
import { getShellJob, listShellJobs, startShellJob, stopShellJob, type ShellJob } from "./shells.ts";
import { isYoloEnabled, setYoloEnabled } from "./yolo.ts";
import {
  createHost, deleteHost, formatExecResult, getHost, listHosts, publicHost, sftpReadFile, sftpUploadFile,
  sshDeploy, sshExec, sshHomeDir, sshStatus, truncate, updateHost, type Host,
} from "./hosts.ts";
import appConfig from "./deno.json" with { type: "json" };

const APP_VERSION: string = (appConfig as { version?: string }).version ?? "0.0.0";

// ===== CLI subcommands (also available in the released binary) =====
//   yoke create-user <username> <password>
//   yoke version
const [subcommand, ...subArgs] = Deno.args;
if (subcommand === "create-user") {
  const [username, password] = subArgs;
  if (!username || !password) {
    console.error("Usage: yoke create-user <username> <password>");
    Deno.exit(1);
  }
  try {
    const user = await createUser(username, password);
    console.log(`Created user '${user.username}' (id ${user.id}).`);
    Deno.exit(0);
  } catch (err) {
    console.error(`Failed to create user: ${err instanceof Error ? err.message : String(err)}`);
    Deno.exit(1);
  }
}
if (subcommand === "version") {
  console.log(APP_VERSION);
  Deno.exit(0);
}

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

function publicJob(job: ShellJob): Record<string, unknown> {
  return {
    id: job.id,
    command: job.command,
    requester: job.requester,
    status: job.status,
    output: job.output,
    timeout_seconds: job.timeoutSeconds,
    created_at: job.createdAt,
    ...(job.finishedAt !== undefined ? { finished_at: job.finishedAt } : {}),
  };
}

// Active agent runs per user, so a run can be stopped from the UI.
const activeRuns = new Map<number, AbortController>();

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

async function handleApi(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  if (path === "/api/version" && method === "GET") {
    return json({ version: APP_VERSION });
  }

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
    const stats = conversationStats(auth.user.id, projectId ?? 0);
    return json({
      user: auth.user,
      model: getEffectiveModel(auth.user.id, projectId),
      user_model: getModelForUser(auth.user.id),
      models: ALLOWED_MODELS,
      thinking_effort: getThinkingEffortForUser(auth.user.id),
      thinking_efforts: THINKING_EFFORTS,
      yolo: isYoloEnabled(auth.user.id),
      max_iterations: getMaxIterationsForUser(auth.user.id) ?? DEFAULT_MAX_ITERATIONS,
      project,
      projects: listProjects(),
      workspace,
      index: indexStats(workspace),
      context: {
        messages: stats.active,
        history: stats.history,
        estimated_tokens: estimateTokens(messages),
      },
      usage: usageSummary(auth.user.id),
    });
  }

  if (path === "/api/history" && method === "GET") {
    const auth = requireAuth(request);
    if (auth instanceof Response) return auth;
    const projectId = getActiveProjectId(auth.user.id) ?? 0;
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 50, 1), 200);
    return json({ messages: getHistory(auth.user.id, projectId, limit) });
  }

  if (path === "/api/restore" && method === "POST") {
    const auth = requireAuth(request);
    if (auth instanceof Response) return auth;
    const projectId = getActiveProjectId(auth.user.id) ?? 0;
    const restored = restoreConversation(auth.user.id, projectId);
    return json({ restored });
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

  if (path.startsWith("/api/projects/") && method === "POST") {
    const auth = requireAuth(request);
    if (auth instanceof Response) return auth;
    const id = Number(path.slice("/api/projects/".length));
    if (!Number.isInteger(id) || id <= 0) return json({ error: "Invalid project id." }, 400);
    try {
      const body = await readJson(request);
      const project = updateProject(id, {
        name: body.name !== undefined ? String(body.name) : undefined,
        path: body.path !== undefined ? String(body.path) : undefined,
        model: body.model !== undefined ? String(body.model) : undefined,
      });
      if (!project) return json({ error: "Project not found." }, 404);
      await Deno.mkdir(project.path, { recursive: true });
      return json({ project });
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
      if (!Number.isFinite(n) || n < 1 || n > MAX_MAX_ITERATIONS) {
        return json({ error: `max_iterations must be a number between 1 and ${MAX_MAX_ITERATIONS}.` }, 400);
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

  if (path === "/api/thinking" && method === "POST") {
    const auth = requireAuth(request);
    if (auth instanceof Response) return auth;
    try {
      const body = await readJson(request);
      const effort = String(body.thinking_effort ?? "").trim();
      if (!setThinkingEffortForUser(auth.user.id, effort)) {
        return json({
          error: `Unknown thinking effort '${effort}'. Available: ${THINKING_EFFORTS.map((e) => e || "auto").join(", ")}`,
        }, 400);
      }
      return json({ thinking_effort: getThinkingEffortForUser(auth.user.id) });
    } catch (err) {
      return errorResponse(err);
    }
  }

  if (path === "/api/yolo" && method === "POST") {
    const auth = requireAuth(request);
    if (auth instanceof Response) return auth;
    try {
      const body = await readJson(request);
      const enabled = body.yolo === true;
      setYoloEnabled(auth.user.id, enabled);
      return json({ yolo: isYoloEnabled(auth.user.id) });
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
      archiveAllActive(auth.user.id, projectId);
      appendConversation(auth.user.id, projectId, [
        { role: "user", content: `Summary of the conversation so far:\n\n${summary}` },
      ]);
      recordUsage(auth.user.id, usage, model);
      const newContext = getConversation(auth.user.id, projectId);
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
      const timeoutSeconds = Math.min(Math.max(Number(body.timeout_seconds) || 15, 1), 3600);

      // Async mode: return immediately with a job id; the job waits for
      // approval (if needed) and runs in the background. Poll GET
      // /api/shell/<id> for status/output.
      if (body.async === true) {
        const job = startShellJob(command, auth.user.username, cwd, timeoutSeconds, auth.user.id);
        return json({ job_id: job.id, status: job.status, timeout_seconds: timeoutSeconds });
      }

      // Human-in-the-loop approval: unless this exact command was already
      // approved ("allow always"), wait for the user to approve it in the UI.
      // YOLO-mode users skip the prompt entirely.
      if (!isAlwaysApproved(command)) {
        const approved = await createApproval(command, auth.user.username, auth.user.id);
        if (!approved) {
          return json({ error: "Command was not approved (denied, or the approval prompt expired)." }, 403);
        }
      }

      return json({ output: await runShellCommand(command, cwd, timeoutSeconds * 1000) });
    } catch (err) {
      return errorResponse(err);
    }
  }

  if (path === "/api/shell/jobs" && method === "GET") {
    const auth = requireAuth(request);
    if (auth instanceof Response) return auth;
    return json({ jobs: listShellJobs().map(publicJob) });
  }

  const shellJobMatch = path.match(/^\/api\/shell\/([^/]+)(?:\/(stop))?$/);
  if (shellJobMatch && method === "GET" && !shellJobMatch[2]) {
    const auth = requireAuth(request);
    if (auth instanceof Response) return auth;
    const job = getShellJob(shellJobMatch[1]);
    if (!job) return json({ error: "Shell job not found." }, 404);
    return json({ job: publicJob(job) });
  }

  if (shellJobMatch && method === "POST" && shellJobMatch[2] === "stop") {
    const auth = requireAuth(request);
    if (auth instanceof Response) return auth;
    if (!getShellJob(shellJobMatch[1])) return json({ error: "Shell job not found." }, 404);
    if (!stopShellJob(shellJobMatch[1])) return json({ error: "Job is not running." }, 409);
    return json({ ok: true });
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
          ? Math.min(Math.max(Math.floor(Number(body.max_iterations)), 1), MAX_MAX_ITERATIONS)
          : undefined,
        getEffectiveWorkspace(auth.user.id),
        auth.user.id,
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

  if (path === "/api/hosts" && method === "GET") {
    const auth = requireAuth(request);
    if (auth instanceof Response) return auth;
    return json({ hosts: listHosts().map(publicHost) });
  }

  if (path === "/api/hosts" && method === "POST") {
    const auth = requireAuth(request);
    if (auth instanceof Response) return auth;
    try {
      const body = await readJson(request);
      const host = createHost(
        String(body.name ?? ""),
        String(body.host ?? ""),
        Number(body.port) || 22,
        String(body.user ?? ""),
        body.auth_type === "password" ? "password" : "key",
        String(body.key_path ?? ""),
        String(body.password ?? ""),
        String(body.sudo_password ?? ""),
      );
      return json({ host: publicHost(host) }, 201);
    } catch (err) {
      return errorResponse(err);
    }
  }

  const hostActionMatch = path.match(/^\/api\/hosts\/(\d+)\/(status|exec|upload|fetch|deploy)$/);
  if (hostActionMatch && method === "POST") {
    const auth = requireAuth(request);
    if (auth instanceof Response) return auth;
    const hostId = Number(hostActionMatch[1]);
    const action = hostActionMatch[2];
    const host = getHost(hostId);
    if (!host) return json({ error: "Host not found." }, 404);
    try {
      const body = await readJson(request);
      const requester = auth.user.username;

      if (action === "status") {
        return json({ output: await sshStatus(host) });
      }

      // Everything else requires human approval from the web UI (unless the
      // requesting user has YOLO mode enabled).
      const approve = async (label: string): Promise<boolean> => {
        if (isAlwaysApproved(label)) return true;
        return await createApproval(label, requester, auth.user.id);
      };

      if (action === "exec") {
        const command = String(body.command ?? "").trim();
        if (!command) return json({ error: "Missing 'command' field." }, 400);
        const label = `[ssh ${host.name}] ${command}`;
        if (!await approve(label)) return json({ error: "Command was not approved." }, 403);
        return json({ output: truncate(formatExecResult(await sshExec(host, command))) });
      }

      if (action === "upload") {
        const localPath = String(body.local_path ?? "").trim();
        const remotePath = String(body.remote_path ?? "").trim();
        if (!localPath || !remotePath) return json({ error: "local_path and remote_path are required." }, 400);
        const fullLocal = resolve(getEffectiveWorkspace(auth.user.id), localPath);
        const label = `[upload to ${host.name}] ${localPath} -> ${remotePath}`;
        if (!await approve(label)) return json({ error: "Upload was not approved." }, 403);
        const bytes = await sftpUploadFile(host, fullLocal, remotePath);
        return json({ output: `Uploaded ${bytes} bytes to ${host.name}:${remotePath}.` });
      }

      if (action === "fetch") {
        const remotePath = String(body.remote_path ?? "").trim();
        if (!remotePath) return json({ error: "Missing 'remote_path' field." }, 400);
        const label = `[fetch from ${host.name}] ${remotePath}`;
        if (!await approve(label)) return json({ error: "Fetch was not approved." }, 403);
        return json({ output: truncate(await sftpReadFile(host, remotePath)) });
      }

      if (action === "deploy") {
        let project = body.project_id != null
          ? getProject(Number(body.project_id))
          : body.project_name
          ? listProjects().find((p) => p.name.toLowerCase() === String(body.project_name).toLowerCase())
          : getProject(getActiveProjectId(auth.user.id) ?? -1);
        if (!project) return json({ error: "Project not found. Pass project_id or project_name." }, 400);
        const remoteDir = String(body.remote_path ?? "").trim() ||
          `${(await sshHomeDir(host)).replace(/[\\/]+$/, "")}/yoke-deploy/${project.name}`;
        const postDeploy = body.post_deploy ? String(body.post_deploy).trim() : undefined;
        const label = `[deploy to ${host.name}] ${project.name} -> ${remoteDir}`;
        if (!await approve(label)) return json({ error: "Deploy was not approved." }, 403);
        return json({ output: await sshDeploy(host, project.path, remoteDir, postDeploy) });
      }
    } catch (err) {
      return errorResponse(err);
    }
  }

  if (path.startsWith("/api/hosts/") && method === "POST") {
    const auth = requireAuth(request);
    if (auth instanceof Response) return auth;
    const id = Number(path.slice("/api/hosts/".length));
    if (!Number.isInteger(id) || id <= 0) return json({ error: "Invalid host id." }, 400);
    try {
      const body = await readJson(request);
      const host = updateHost(id, {
        name: body.name !== undefined ? String(body.name) : undefined,
        host: body.host !== undefined ? String(body.host) : undefined,
        port: body.port !== undefined ? Number(body.port) : undefined,
        user: body.user !== undefined ? String(body.user) : undefined,
        auth_type: body.auth_type !== undefined ? String(body.auth_type) : undefined,
        key_path: body.key_path !== undefined ? String(body.key_path) : undefined,
        password: body.password !== undefined ? String(body.password) : undefined,
        sudo_password: body.sudo_password !== undefined ? String(body.sudo_password) : undefined,
      });
      if (!host) return json({ error: "Host not found." }, 404);
      return json({ host: publicHost(host) });
    } catch (err) {
      return errorResponse(err);
    }
  }

  if (path.startsWith("/api/hosts/") && method === "DELETE") {
    const auth = requireAuth(request);
    if (auth instanceof Response) return auth;
    const id = Number(path.slice("/api/hosts/".length));
    if (!Number.isInteger(id) || id <= 0) return json({ error: "Invalid host id." }, 400);
    if (!deleteHost(id)) return json({ error: "Host not found." }, 404);
    return json({ ok: true });
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

  if (path === "/api/agent/stop" && method === "POST") {
    const auth = requireAuth(request);
    if (auth instanceof Response) return auth;
    const controller = activeRuns.get(auth.user.id);
    if (!controller) return json({ error: "No active run to stop." }, 404);
    controller.abort();
    return json({ ok: true });
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
      const maxIterations = getMaxIterationsForUser(auth.user.id) ?? DEFAULT_MAX_ITERATIONS;
      const thinkingEffort = getThinkingEffortForUser(auth.user.id);
      const abortController = new AbortController();
      activeRuns.set(auth.user.id, abortController);
      const stream = new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "start", max_iterations: maxIterations })}\n\n`));

          // Load this user's persistent conversation for the active project;
          // runAgent appends the new task and mutates the array as it goes.
          const conversation = getConversation(auth.user.id, projectId) as ChatMessage[];
          const before = conversation.length;

          runAgent(conversation, task, (event: AgentEvent) => {
            const data = JSON.stringify(event);
            controller.enqueue(encoder.encode(`data: ${data}\n\n`));
          }, {
            model,
            maxIterations,
            workspace,
            thinkingEffort,
            signal: abortController.signal,
            userId: auth.user.id,
          }).then((result) => {
            // Append only the messages produced by this run; earlier history
            // rows are never rewritten or deleted.
            appendConversation(auth.user.id, projectId, conversation.slice(before));
            recordUsage(auth.user.id, result.usage, model);
            controller.close();
          }).catch((err) => {
            const errorEvent = JSON.stringify({ type: "error", error: errString(err) });
            controller.enqueue(encoder.encode(`data: ${errorEvent}\n\n`));
            controller.close();
          }).finally(() => {
            activeRuns.delete(auth.user.id);
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
