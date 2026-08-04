// tools.ts
import { dirname, resolve } from "https://deno.land/std@0.224.0/path/mod.ts";

export const workspacePath = resolve(Deno.env.get("WORKSPACE_DIR") || ".");
const IS_WINDOWS = Deno.build.os === "windows";
const SEP = IS_WINDOWS ? "\\" : "/";

function errString(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export async function ensureWorkspace(): Promise<void> {
  await Deno.mkdir(workspacePath, { recursive: true });
}

function safePath(relativePath: string, workspace: string): string {
  // resolve() discards the workspace prefix when the argument is absolute,
  // so passing an absolute Windows path no longer double-joins the workspace.
  const full = resolve(workspace, relativePath);
  const ws = resolve(workspace);
  const a = IS_WINDOWS ? full.toLowerCase() : full;
  const b = IS_WINDOWS ? ws.toLowerCase() : ws;
  if (a !== b && !a.startsWith(b + SEP)) {
    throw new Error(`Access denied: path outside workspace: '${relativePath}'`);
  }
  return full;
}

export async function readFileTool(path: string, workspace = workspacePath): Promise<string> {
  const full = safePath(path, workspace);
  try {
    return await Deno.readTextFile(full);
  } catch (err) {
    throw new Error(`Failed to read file '${path}': ${errString(err)}`);
  }
}

export async function writeFileTool(path: string, content: string, workspace = workspacePath): Promise<string> {
  const full = safePath(path, workspace);
  try {
    await Deno.mkdir(dirname(full), { recursive: true });
    await Deno.writeTextFile(full, content);
    return `Wrote ${content.length} characters to '${path}'.`;
  } catch (err) {
    throw new Error(`Failed to write file '${path}': ${errString(err)}`);
  }
}

export async function listDirTool(path: string, workspace = workspacePath): Promise<string[]> {
  const full = safePath(path, workspace);
  try {
    const entries: string[] = [];
    for await (const entry of Deno.readDir(full)) {
      entries.push(entry.name + (entry.isDirectory ? "/" : ""));
    }
    return entries;
  } catch (err) {
    throw new Error(`Failed to list directory '${path}': ${errString(err)}`);
  }
}

// ===== Shell execution =====

export const SHELL_TIMEOUT_MS = 15_000;
export const MAX_SHELL_OUTPUT_CHARS = 50_000;

// Check Deno's run permission so approvals can be routed through the web UI
// instead of letting Deno prompt on the server terminal.
export function hasRunPermission(): boolean {
  try {
    return Deno.permissions.querySync({ name: "run" }).state === "granted";
  } catch {
    return false;
  }
}

// On Linux/macOS the shell is started via setsid so it leads its own process
// group/session; a timeout or stop can then signal the whole group, killing
// grandchildren (e.g. a server started by the command) instead of just the
// direct shell PID. Cached so the probe runs once per process.
let setsidAvailable: boolean | null = null;
function hasSetsid(): boolean {
  if (setsidAvailable === null) {
    try {
      new Deno.Command("setsid", { args: ["true"], stdout: "null", stderr: "null" }).outputSync();
      setsidAvailable = true;
    } catch {
      setsidAvailable = false; // missing (e.g. macOS) or no run permission
    }
  }
  return setsidAvailable;
}

export async function runShellCommand(
  command: string,
  cwd = workspacePath,
  timeoutMs = SHELL_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<string> {
  const shell = IS_WINDOWS ? "cmd" : "sh";
  // The default workspace may not exist yet (fresh clone, CI); a missing
  // cwd makes the spawn fail with an opaque NotFound. Custom cwds are left
  // to fail loudly — auto-creating a typo'd directory would hide errors.
  if (cwd === workspacePath) await ensureWorkspace();
  // Output goes to temp files: Deno's .output() waits for stdout EOF, which
  // never arrives if a child keeps the pipe open after the shell is killed.
  // Reading the files after the shell exits makes timeout/stop reliable.
  const outPath = await Deno.makeTempFile({ prefix: "yoke-out-" });
  const errPath = await Deno.makeTempFile({ prefix: "yoke-err-" });
  const wrapped = IS_WINDOWS
    ? `${command} > "${outPath}" 2> "${errPath}"`
    : `${command} > '${outPath}' 2> '${errPath}'`;
  const useSetsid = !IS_WINDOWS && hasSetsid();
  // setsid execs the shell in a new session; the shell keeps the spawned PID,
  // which then equals its process-group ID. Exit codes propagate unchanged.
  const child = new Deno.Command(useSetsid ? "setsid" : shell, {
    args: useSetsid ? [shell, "-c", wrapped] : [IS_WINDOWS ? "/c" : "-c", wrapped],
    cwd,
    stdout: "null",
    stderr: "null",
  }).spawn();

  let timedOut = false;
  const kill = () => {
    if (IS_WINDOWS) {
      try {
        Deno.kill(child.pid, "SIGTERM");
      } catch {
        // process already gone
      }
      return;
    }
    if (useSetsid) {
      // Deno.kill can't signal a process group (no negative PIDs), so shell
      // out to kill(1). util-linux kill(1) rejects `kill -KILL -<pid>`
      // ("failed to parse argument") — it needs `-s KILL -- -<pgid>`.
      try {
        new Deno.Command("kill", {
          args: ["-s", "KILL", "--", `-${child.pid}`],
          stdout: "null",
          stderr: "null",
        }).outputSync();
      } catch {
        // group already gone
      }
    }
    // Belt and braces: also kill the direct PID (the only option without
    // setsid; with setsid the group signal above normally suffices).
    try {
      Deno.kill(child.pid, "SIGKILL");
    } catch {
      // process already gone
    }
  };
  const timer = setTimeout(() => {
    timedOut = true;
    kill();
  }, timeoutMs);
  const onAbort = () => kill();
  if (signal) {
    if (signal.aborted) kill();
    else signal.addEventListener("abort", onAbort, { once: true });
  }

  let code: number | null = null;
  try {
    const status = await child.status;
    code = status.code;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }

  const decoder = new TextDecoder();
  let output = `${decoder.decode(await Deno.readFile(outPath))}${decoder.decode(await Deno.readFile(errPath))}`.trim();
  await Deno.remove(outPath).catch(() => {});
  await Deno.remove(errPath).catch(() => {});
  if (output.length > MAX_SHELL_OUTPUT_CHARS) {
    output = output.slice(0, MAX_SHELL_OUTPUT_CHARS) + "\n...[truncated]";
  }

  if (signal?.aborted) {
    return output ? `(stopped)\n${output}` : "(stopped)";
  }
  if (timedOut) {
    return output
      ? `(timed out after ${timeoutMs / 1000} seconds, exit code ${code})\n${output}`
      : `(timed out after ${timeoutMs / 1000} seconds, exit code ${code}, no output)`;
  }
  if (!output) return `(exit code ${code}, no output)`;
  if (code !== 0) return `(exit code ${code})\n${output}`;
  return output;
}
