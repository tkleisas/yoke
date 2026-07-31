// context.ts
// Append-only message history stored per (user, project). Messages are never
// deleted: compaction, summarization, and reset only archive them (status =
// 'archived'), so a full history remains available and can be restored.
import { db } from "./db.ts";
import { SYSTEM_PROMPT, type AgentUsage, type ChatMessage, type ToolCall } from "./agent.ts";

export { type ChatMessage };

export type HistoryMessage = {
  id: number;
  user_id: number;
  project_id: number;
  role: ChatMessage["role"];
  content: string | null;
  tool_calls: ToolCall[] | null;
  tool_call_id: string | null;
  status: "active" | "archived";
  created_at: number;
};

export const DEFAULT_KEEP = 8;

// projectId 0 = the default workspace (no project).

function rowToMessage(row: {
  id: number;
  user_id: number;
  project_id: number;
  role: string;
  content: string | null;
  tool_calls: string | null;
  tool_call_id: string | null;
  status: string;
  created_at: number;
}): HistoryMessage {
  let toolCalls: ToolCall[] | null = null;
  if (row.tool_calls) {
    try {
      toolCalls = JSON.parse(row.tool_calls) as ToolCall[];
    } catch {
      toolCalls = null;
    }
  }
  return {
    id: row.id,
    user_id: row.user_id,
    project_id: row.project_id,
    role: row.role as ChatMessage["role"],
    content: row.content,
    tool_calls: toolCalls,
    tool_call_id: row.tool_call_id,
    status: row.status === "archived" ? "archived" : "active",
    created_at: row.created_at,
  };
}

function toChatMessage(m: HistoryMessage): ChatMessage {
  const base: ChatMessage = { role: m.role, content: m.content };
  if (m.tool_calls) base.tool_calls = m.tool_calls;
  if (m.tool_call_id) base.tool_call_id = m.tool_call_id;
  return base;
}

/** Active conversation for a user/project (system prompt synthesized on load). */
export function getConversation(userId: number, projectId = 0): ChatMessage[] {
  const rows = db.prepare(
    `SELECT id, user_id, project_id, role, content, tool_calls, tool_call_id, status, created_at
     FROM messages WHERE user_id = ? AND project_id = ? AND status = 'active'
     ORDER BY id`,
  ).all(userId, projectId) as Array<{
    id: number;
    user_id: number;
    project_id: number;
    role: string;
    content: string | null;
    tool_calls: string | null;
    tool_call_id: string | null;
    status: string;
    created_at: number;
  }>;
  return [{ role: "system", content: SYSTEM_PROMPT }, ...rows.map(rowToMessage).map(toChatMessage)];
}

/** Appends messages to the history (append-only — never rewrites earlier rows). */
export function appendConversation(userId: number, projectId: number, messages: ChatMessage[]): void {
  const insert = db.prepare(
    `INSERT INTO messages (user_id, project_id, role, content, tool_calls, tool_call_id, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'active', ?)`,
  );
  const now = Date.now();
  for (const m of messages) {
    if (m.role === "system") continue; // synthesized on load
    insert.run(
      userId,
      projectId,
      m.role,
      m.content,
      m.tool_calls ? JSON.stringify(m.tool_calls) : null,
      m.tool_call_id ?? null,
      now,
    );
  }
}

/** Marks every active message archived (used by summarize/reset). */
export function archiveAllActive(userId: number, projectId: number): void {
  db.prepare(
    "UPDATE messages SET status = 'archived' WHERE user_id = ? AND project_id = ? AND status = 'active'",
  ).run(userId, projectId);
}

export function resetConversation(userId: number, projectId = 0): void {
  archiveAllActive(userId, projectId);
}

/** Archives all but the last `keep` non-system messages; returns the active context. */
export function compactConversation(userId: number, projectId: number, keep = DEFAULT_KEEP): ChatMessage[] {
  const activeRows = db.prepare(
    `SELECT id FROM messages WHERE user_id = ? AND project_id = ? AND status = 'active'
     ORDER BY id DESC LIMIT ?`,
  ).all(userId, projectId, keep) as Array<{ id: number }>;
  const keepIds = activeRows.map((r) => r.id);
  if (keepIds.length > 0) {
    const placeholders = keepIds.map(() => "?").join(", ");
    db.prepare(
      `UPDATE messages SET status = 'archived'
       WHERE user_id = ? AND project_id = ? AND status = 'active' AND id NOT IN (${placeholders})`,
    ).run(userId, projectId, ...keepIds);
  } else {
    archiveAllActive(userId, projectId);
  }
  return getConversation(userId, projectId);
}

/** Brings all archived messages back into the active context. Returns the count restored. */
export function restoreConversation(userId: number, projectId: number): number {
  const result = db.prepare(
    "UPDATE messages SET status = 'active' WHERE user_id = ? AND project_id = ? AND status = 'archived'",
  ).run(userId, projectId);
  return Number(result.changes);
}

/** Full history (active + archived), newest first. */
export function getHistory(userId: number, projectId: number, limit = 50): HistoryMessage[] {
  const rows = db.prepare(
    `SELECT id, user_id, project_id, role, content, tool_calls, tool_call_id, status, created_at
     FROM messages WHERE user_id = ? AND project_id = ?
     ORDER BY id DESC LIMIT ?`,
  ).all(userId, projectId, limit) as Array<{
    id: number;
    user_id: number;
    project_id: number;
    role: string;
    content: string | null;
    tool_calls: string | null;
    tool_call_id: string | null;
    status: string;
    created_at: number;
  }>;
  return rows.map(rowToMessage);
}

export function conversationStats(userId: number, projectId: number): { active: number; history: number } {
  const active = db.prepare(
    "SELECT COUNT(*) AS c FROM messages WHERE user_id = ? AND project_id = ? AND status = 'active'",
  ).get(userId, projectId) as { c: number };
  const history = db.prepare(
    "SELECT COUNT(*) AS c FROM messages WHERE user_id = ? AND project_id = ?",
  ).get(userId, projectId) as { c: number };
  return { active: active.c, history: history.c };
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
