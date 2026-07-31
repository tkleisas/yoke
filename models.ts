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
