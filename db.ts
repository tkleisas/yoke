// db.ts
import { DatabaseSync } from "node:sqlite";
import { dirname } from "https://deno.land/std@0.224.0/path/mod.ts";

const DB_PATH = Deno.env.get("DATABASE_PATH") || "./yoke.db";

// Ensure the database directory exists (SQLite can't create parent dirs).
try {
  Deno.mkdirSync(dirname(DB_PATH), { recursive: true });
} catch {
  // read-only filesystem or similar — let DatabaseSync report the error
}

export const db = new DatabaseSync(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    path TEXT NOT NULL,
    model TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS hosts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    host TEXT NOT NULL,
    port INTEGER NOT NULL DEFAULT 22,
    user TEXT NOT NULL,
    auth_type TEXT NOT NULL DEFAULT 'key',
    key_path TEXT NOT NULL DEFAULT '',
    password TEXT NOT NULL DEFAULT '',
    sudo_password TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS indexed_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT NOT NULL UNIQUE,
    workspace TEXT NOT NULL DEFAULT '',
    language TEXT,
    size INTEGER NOT NULL,
    mtime INTEGER NOT NULL,
    content_hash TEXT NOT NULL,
    last_indexed_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS code_symbols (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_id INTEGER NOT NULL REFERENCES indexed_files(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    line INTEGER NOT NULL,
    signature TEXT
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    project_id INTEGER NOT NULL DEFAULT 0,
    role TEXT NOT NULL,
    content TEXT,
    tool_calls TEXT,
    tool_call_id TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS usage_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    prompt_tokens INTEGER NOT NULL,
    completion_tokens INTEGER NOT NULL,
    total_tokens INTEGER NOT NULL,
    model TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);
  CREATE INDEX IF NOT EXISTS idx_files_path ON indexed_files(path);
  CREATE INDEX IF NOT EXISTS idx_symbols_name ON code_symbols(name);
  CREATE INDEX IF NOT EXISTS idx_symbols_kind ON code_symbols(kind);
  CREATE INDEX IF NOT EXISTS idx_usage_user ON usage_log(user_id, id);
  CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(user_id, project_id, status, id);
`);

// Migrations for tables created before these columns/tables existed.
for (const migration of [
  "ALTER TABLE users ADD COLUMN model TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE usage_log ADD COLUMN model TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE users ADD COLUMN max_iterations INTEGER",
  "ALTER TABLE users ADD COLUMN project_id INTEGER",
  "ALTER TABLE indexed_files ADD COLUMN workspace TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE hosts ADD COLUMN sudo_password TEXT NOT NULL DEFAULT ''",
]) {
  try {
    db.exec(migration);
  } catch {
    // column already exists
  }
}

try {
  db.exec("CREATE INDEX IF NOT EXISTS idx_files_workspace ON indexed_files(workspace)");
} catch {
  // column not present on a very old schema — skip
}

// Migrate the legacy conversations table (JSON blob per conversation) into
// append-only message rows. Older messages are never deleted — compaction and
// summarization only archive them.
const hasConversations = db.prepare(
  "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'conversations'",
).get();
if (hasConversations) {
  const conversationCols = db.prepare("PRAGMA table_info(conversations)").all() as { name: string }[];
  const hasProjectId = conversationCols.some((c) => c.name === "project_id");
  const rows = db.prepare(
    `SELECT user_id, ${hasProjectId ? "project_id" : "0 AS project_id"}, messages FROM conversations`,
  ).all() as Array<{ user_id: number; project_id: number; messages: string }>;

  const insert = db.prepare(
    `INSERT INTO messages (user_id, project_id, role, content, tool_calls, tool_call_id, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'active', ?)`,
  );
  const now = Date.now();
  for (const row of rows) {
    try {
      const messages = JSON.parse(row.messages) as Array<{
        role: string;
        content: string | null;
        tool_calls?: unknown;
        tool_call_id?: string;
      }>;
      for (const m of messages) {
        if (m.role === "system") continue; // synthesized on load
        insert.run(
          row.user_id,
          row.project_id,
          m.role,
          m.content,
          m.tool_calls ? JSON.stringify(m.tool_calls) : null,
          m.tool_call_id ?? null,
          now,
        );
      }
    } catch {
      // corrupted row — skip
    }
  }
  db.exec("DROP TABLE conversations;");
}
