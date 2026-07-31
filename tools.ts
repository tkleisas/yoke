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
