// context.ts
import { db } from "./db.ts";
import { SYSTEM_PROMPT, type AgentUsage, type ChatMessage } from "./agent.ts";

export { type ChatMessage };

export const DEFAULT_KEEP = 8;

// projectId 0 = the default workspace (no project).

export function getConversation(userId: number, projectId = 0): ChatMessage[] {
  const row = db.prepare(
    "SELECT messages FROM conversations WHERE user_id = ? AND project_id = ?",
  ).get(userId, projectId) as { messages: string } | undefined;
  if (row) {
    try {
      return JSON.parse(row.messages) as ChatMessage[];
    } catch {
      // corrupted row — fall through to a fresh conversation
    }
  }
  return [{ role: "system", content: SYSTEM_PROMPT }];
}

export function saveConversation(userId: number, messages: ChatMessage[], projectId = 0): void {
  db.prepare(
    `INSERT INTO conversations (user_id, project_id, messages, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, project_id) DO UPDATE SET messages = excluded.messages, updated_at = excluded.updated_at`,
  ).run(userId, projectId, JSON.stringify(messages), Date.now());
}

export function resetConversation(userId: number, projectId = 0): void {
  saveConversation(userId, [{ role: "system", content: SYSTEM_PROMPT }], projectId);
}

export function compactConversation(userId: number, projectId: number, keep = DEFAULT_KEEP): ChatMessage[] {
  const messages = getConversation(userId, projectId);
  const system = messages.filter((m) => m.role === "system");
  const rest = messages.filter((m) => m.role !== "system");
  const compacted = [...system, ...rest.slice(-keep)];
  saveConversation(userId, compacted, projectId);
  return compacted;
}

export function estimateTokens(messages: ChatMessage[]): number {
  let total = 0;
  for (const m of messages) {
    if (m.content) total += Math.ceil(m.content.length / 4);
    if (m.tool_calls) {
      for (const tc of m.tool_calls) {
        total += Math.ceil((tc.function.name.length + tc.function.arguments.length) / 4) + 3;
      }
    }
  }
  return total;
}

export function getMaxIterationsForUser(userId: number): number | null {
  const row = db.prepare("SELECT max_iterations FROM users WHERE id = ?").get(userId) as
    | { max_iterations: number | null }
    | undefined;
  const value = row?.max_iterations;
  return typeof value === "number" && value >= 1 ? Math.floor(value) : null;
}

export function setMaxIterationsForUser(userId: number, n: number): void {
  db.prepare("UPDATE users SET max_iterations = ? WHERE id = ?").run(n, userId);
}

export function recordUsage(userId: number, usage: AgentUsage, model = ""): void {
  if (usage.totalTokens <= 0) return;
  db.prepare(
    `INSERT INTO usage_log (user_id, prompt_tokens, completion_tokens, total_tokens, model, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(userId, usage.promptTokens, usage.completionTokens, usage.totalTokens, model, Date.now());
}

export function usageSummary(userId: number): {
  runs: number;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  last_run: { prompt_tokens: number; completion_tokens: number; total_tokens: number; model: string } | null;
} {
  const totals = db.prepare(
    `SELECT COUNT(*) AS runs,
            COALESCE(SUM(prompt_tokens), 0) AS prompt,
            COALESCE(SUM(completion_tokens), 0) AS completion,
            COALESCE(SUM(total_tokens), 0) AS total
     FROM usage_log WHERE user_id = ?`,
  ).get(userId) as { runs: number; prompt: number; completion: number; total: number };

  const last = db.prepare(
    "SELECT prompt_tokens, completion_tokens, total_tokens, model FROM usage_log WHERE user_id = ? ORDER BY id DESC LIMIT 1",
  ).get(userId) as { prompt_tokens: number; completion_tokens: number; total_tokens: number; model: string } | undefined;

  return {
    runs: totals.runs,
    prompt_tokens: totals.prompt,
    completion_tokens: totals.completion,
    total_tokens: totals.total,
    last_run: last ?? null,
  };
}
