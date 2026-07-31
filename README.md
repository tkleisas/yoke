# Yoke · Agent Harness

Yoke is a small agent harness. It connects DeepSeek to file-system tools and a
SQLite-backed code index, served through a web UI with user accounts.

## Features

- **Agent loop** with tools: `read_file`, `write_file`, `list_directory`, `search_code`, `finish`.
- **User accounts** (username + password) stored in SQLite. Passwords are hashed with PBKDF2-SHA256.
- **Session tokens**: login issues a session token (stored in SQLite, expires after 7 days) used as `Authorization: Bearer <token>`.
- **CLI-only user creation**: accounts are created with `create-user.ts` — the web UI only supports logging in.
- **Persistent per-user context**: tasks build on previous ones; `/compact`, `/summarize`, `/reset`, `/usage` manage it. Context is scoped per user **and** per project.
- **Projects**: each project has its own work directory and can pin its own model. Switch with the header dropdown or `/project`; agent tools, shell commands, indexing, search, and context all follow the active project.
- **Multiple models**: per-user model selection (header dropdown or `/model`), configurable via `DEEPSEEK_MODELS`. A project's model overrides the user's.
- **Code & file indexing**: recursively scans the workspace, extracts symbols (functions, classes, etc.) per language, and keeps the index incremental (mtime + content-hash aware).
- **Search** over indexed symbols and file paths.
- **Web access**: the agent can search the web (`web_search`, via Bing RSS, no API key) and fetch pages as markdown (`web_fetch`). Also available from the UI as `/web <query>` and `/fetch <url>`.
- **Shell commands** from the UI via `!command` (runs server-side in the active workspace) — each command is approved from the web UI before it runs, instead of Deno prompting on the server terminal.
- **Slash commands** in the chat input: `/help`, `/clear`, `/reset`, `/compact`, `/summarize`, `/usage`, `/model`, `/maxtries`, `/project`, `/reindex`, `/search`, `/status`, `/theme`, `/logout`.

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `DEEPSEEK_API_KEY` | *(none, mock mode)* | DeepSeek API key. If unset the agent uses mock reasoning. |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com/v1` | API base URL. |
| `DEEPSEEK_MODEL` | `deepseek-v4-flash` | Default model. |
| `DEEPSEEK_MODELS` | *(defaults)* | Comma-separated list of selectable models (defaults: `DEEPSEEK_MODEL`, `deepseek-chat`, `deepseek-reasoner`). |
| `WORKSPACE_DIR` | `.` | Default workspace directory (used when no project is active). Shell commands run here. |
| `DATABASE_PATH` | `./yoke.db` | SQLite database file (users, sessions, projects, index, context, usage). |
| `PORT` | `8080` | HTTP port. |
| `MAX_ITERATIONS` | `10` | Default max LLM iterations per agent run (1-100). |
| `MAX_SUBAGENT_ITERATIONS` | `MAX_ITERATIONS` | Default max LLM iterations for subagents. |
| `ENABLE_HTTPS` | *(off)* | Set to `1` to serve HTTPS and auto-generate a self-signed certificate on first run. |
| `TLS_CERT_PATH` | `./certs/cert.pem` | Path to the TLS certificate (PEM). |
| `TLS_KEY_PATH` | `./certs/key.pem` | Path to the TLS private key (PEM). |

## HTTPS (self-signed)

Set `ENABLE_HTTPS=1` to run over TLS. If no certificate exists yet at
`TLS_CERT_PATH` / `TLS_KEY_PATH` (default `./certs/`), Yoke generates a
self-signed ECDSA certificate for `localhost`, `127.0.0.1`, and `0.0.0.0`
and stores it there. Browsers will warn about the self-signed cert — accept
the warning, or add the generated `cert.pem` to your trust store.

If certificate files already exist, Yoke uses them regardless of
`ENABLE_HTTPS`. Without `ENABLE_HTTPS` and without cert files, Yoke serves
plain HTTP.

## Running

```
# HTTPS (auto-generates a self-signed certificate)
$env:ENABLE_HTTPS="1"
deno run --allow-net --allow-env --allow-read --allow-write --allow-run main.ts

# Plain HTTP
deno run --allow-net --allow-env --allow-read --allow-write --allow-run main.ts
```

`--allow-run` is **required** for the `!command` shell operator. If Yoke is
started without it, shell commands are rejected with a clear error instead of
Deno prompting on the server terminal. With the flag, commands are not executed
immediately: a permission prompt appears in the web UI with the command, and
you can **Approve** (run once), **Allow always** (skip future prompts for that
exact command), or **Deny**. Unanswered prompts expire after 5 minutes. Note:
any authenticated user can approve pending commands — only expose Yoke to
people you trust.

Open the printed URL (e.g. https://localhost:8080) and log in.

## Creating users

Users are created only via the CLI — there is no registration in the UI or API:

```
deno run --allow-env --allow-read --allow-write create-user.ts <username> <password>
```

Usernames must be at least 3 characters and passwords at least 8. The command
fails if the username already exists. Point `DATABASE_PATH` at the same
database file the server uses.

## Projects

Each project has its own work directory and can pin its own LLM model. When a
project is active, agent tools, `!` shell commands, indexing, search, and the
conversation context all operate in that project's directory; the project's
model (if set) overrides the user's selected model.

- Create/switch/delete from the UI (header dropdown + `＋` button) or the API:
  - `POST /api/projects` `{ "name": "...", "path": "...", "model": "..." }`
  - `DELETE /api/projects/<id>`
  - `POST /api/project` `{ "project_id": <id> }` — activate (omit/null = default workspace)
- Or in the chat: `/project`, `/project <name>`, `/project create <name> <path> [model=<model>]`, `/project delete <name>`.
- Each project gets its own conversation context (run `/reindex` after switching to index its files).

## API

All `/api/*` endpoints (except login) require `Authorization: Bearer <token>`.

- `POST /api/login` `{ "username": "...", "password": "..." }` → `{ token, user }`
- `POST /api/logout` — invalidates the session
- `GET /api/me` → `{ user }`
- `GET /api/status` → `{ user, model, user_model, models, max_iterations, project, projects, workspace, index, context, usage }`
- `POST /api/model` `{ "model": "..." }` — set the user's model
- `POST /api/maxtries` `{ "max_iterations": n }` — set the user's max iterations (1-100)
- `GET /api/projects` / `POST /api/projects` / `DELETE /api/projects/<id>`
- `POST /api/project` `{ "project_id": <id> | null }` — activate a project
- `POST /api/compact` `{ "keep": n }` — trim agent context to the last n messages
- `POST /api/summarize` — replace agent context with an LLM summary
- `POST /api/reset` — reset agent context
- `POST /api/shell` `{ "command": "..." }` — run a shell command in the active workspace (waits for UI approval)
- `GET /api/approvals` / `POST /api/approvals/<id>` `{ "action": "approve"|"deny", "always": bool }`
- `POST /api/index` — (re)index the active workspace, returns counts
- `GET /api/search?q=...` → `{ symbols, files }`
- `GET /api/subagents` / `POST /api/subagents` `{ "task": "..." }`
- `POST /api/web` `{ "action": "search", "query": "..." }` or `{ "action": "fetch", "url": "..." }`
- `POST /api/agent` `{ "task": "..." }` — runs the agent in the active project, streams SSE events

## Notes

- The workspace is shared by all users.
- Indexing skips `.git`, `node_modules`, `dist`, build output, and binary/large files.
- Sessions are cleaned up hourly.
