// models.ts
import { db } from "./db.ts";

function envList(name: string): string[] {
  return (Deno.env.get(name) || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// Allowed models: DEEPSEEK_MODELS (comma-separated) overrides the defaults.
const envModels = envList("DEEPSEEK_MODELS");
export const ALLOWED_MODELS: string[] = envModels.length > 0
  ? envModels
  : [Deno.env.get("DEEPSEEK_MODEL") || "deepseek-v4-flash", "deepseek-chat", "deepseek-reasoner"];

export const DEFAULT_MODEL: string = ALLOWED_MODELS[0];

export function getModelForUser(userId: number): string {
  const row = db.prepare("SELECT model FROM users WHERE id = ?").get(userId) as
    | { model: string }
    | undefined;
  const model = row?.model;
  return model && ALLOWED_MODELS.includes(model) ? model : DEFAULT_MODEL;
}

export function setModelForUser(userId: number, model: string): boolean {
  if (!ALLOWED_MODELS.includes(model)) return false;
  db.prepare("UPDATE users SET model = ? WHERE id = ?").run(model, userId);
  return true;
}

// ===== Thinking effort =====
// "" (auto) sends nothing so the provider uses its default; otherwise the
// OpenAI-compatible reasoning_effort value (low/medium/high) is sent.
export const THINKING_EFFORTS: string[] = ["", "low", "medium", "high"];

export function getThinkingEffortForUser(userId: number): string {
  const row = db.prepare("SELECT thinking_effort FROM users WHERE id = ?").get(userId) as
    | { thinking_effort: string | null }
    | undefined;
  const effort = row?.thinking_effort ?? "";
  return THINKING_EFFORTS.includes(effort) ? effort : "";
}

export function setThinkingEffortForUser(userId: number, effort: string): boolean {
  if (!THINKING_EFFORTS.includes(effort)) return false;
  db.prepare("UPDATE users SET thinking_effort = ? WHERE id = ?").run(effort, userId);
  return true;
}
