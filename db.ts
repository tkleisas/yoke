// db.ts
import { DatabaseSync } from "node:sqlite";

const DB_PATH = Deno.env.get("DATABASE_PATH") || "./yoke.db";

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

  CREATE TABLE IF NOT EXISTS conversations (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    project_id INTEGER NOT NULL DEFAULT 0,
    messages TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, project_id)
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
`);

// Migrations for tables created before these columns/tables existed.
for (const migration of [
  "ALTER TABLE users ADD COLUMN model TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE usage_log ADD COLUMN model TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE users ADD COLUMN max_iterations INTEGER",
  "ALTER TABLE users ADD COLUMN project_id INTEGER",
  "ALTER TABLE indexed_files ADD COLUMN workspace TEXT NOT NULL DEFAULT ''",
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

// Rework conversations from per-user (user_id PK) to per-user-per-project
// ((user_id, project_id) PK). project_id 0 = the default workspace.
const conversationCols = db.prepare("PRAGMA table_info(conversations)").all() as { name: string }[];
if (!conversationCols.some((c) => c.name === "project_id")) {
  db.exec(`
    CREATE TABLE conversations_new (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      project_id INTEGER NOT NULL DEFAULT 0,
      messages TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, project_id)
    );
  `);
  db.exec(
    "INSERT INTO conversations_new (user_id, project_id, messages, updated_at) " +
      "SELECT user_id, 0, messages, updated_at FROM conversations;",
  );
  db.exec("DROP TABLE conversations;");
  db.exec("ALTER TABLE conversations_new RENAME TO conversations;");
}
