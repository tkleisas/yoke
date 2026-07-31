// projects.ts
import { resolve } from "https://deno.land/std@0.224.0/path/mod.ts";
import { db } from "./db.ts";
import { getModelForUser } from "./models.ts";
import { workspacePath } from "./tools.ts";

export type Project = {
  id: number;
  name: string;
  path: string;
  model: string;
  created_at: number;
};

function rowToProject(row: {
  id: number;
  name: string;
  path: string;
  model: string;
  created_at: number;
}): Project {
  return { id: row.id, name: row.name, path: row.path, model: row.model, created_at: row.created_at };
}

export function listProjects(): Project[] {
  const rows = db.prepare("SELECT id, name, path, model, created_at FROM projects ORDER BY name").all() as Array<{
    id: number;
    name: string;
    path: string;
    model: string;
    created_at: number;
  }>;
  return rows.map(rowToProject);
}

export function getProject(id: number): Project | null {
  const row = db.prepare("SELECT id, name, path, model, created_at FROM projects WHERE id = ?").get(id) as
    | { id: number; name: string; path: string; model: string; created_at: number }
    | undefined;
  return row ? rowToProject(row) : null;
}

export function createProject(name: string, path: string, model = ""): Project {
  const trimmedName = name.trim();
  if (!trimmedName) throw new Error("Project name is required.");
  if (!path.trim()) throw new Error("Project path is required.");
  if (db.prepare("SELECT id FROM projects WHERE name = ?").get(trimmedName)) {
    throw new Error(`A project named '${trimmedName}' already exists.`);
  }
  const resolvedPath = resolve(path);
  const info = db.prepare(
    "INSERT INTO projects (name, path, model, created_at) VALUES (?, ?, ?, ?)",
  ).run(trimmedName, resolvedPath, model.trim(), Date.now());
  return getProject(Number(info.lastInsertRowid))!;
}

export function deleteProject(id: number): boolean {
  const exists = db.prepare("SELECT id FROM projects WHERE id = ?").get(id);
  if (!exists) return false;
  db.prepare("UPDATE users SET project_id = NULL WHERE project_id = ?").run(id);
  db.prepare("DELETE FROM conversations WHERE project_id = ?").run(id);
  db.prepare("DELETE FROM projects WHERE id = ?").run(id);
  return true;
}

export function getActiveProjectId(userId: number): number | null {
  const row = db.prepare("SELECT project_id FROM users WHERE id = ?").get(userId) as
    | { project_id: number | null }
    | undefined;
  const id = row?.project_id;
  return id != null && getProject(id) ? id : null;
}

export function setActiveProjectId(userId: number, projectId: number | null): boolean {
  if (projectId !== null) {
    if (!getProject(projectId)) return false;
  }
  db.prepare("UPDATE users SET project_id = ? WHERE id = ?").run(projectId, userId);
  return true;
}

/** Resolved work directory for a user: their active project's path, else the default workspace. */
export function getEffectiveWorkspace(userId: number, projectId: number | null = getActiveProjectId(userId)): string {
  const project = projectId != null ? getProject(projectId) : null;
  return project ? project.path : workspacePath;
}

/** Effective model for a user: project model (if set), else the user's selected model. */
export function getEffectiveModel(userId: number, projectId: number | null = getActiveProjectId(userId)): string {
  const project = projectId != null ? getProject(projectId) : null;
  if (project?.model) return project.model;
  return getModelForUser(userId);
}
