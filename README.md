# Yoke · Agent Harness

Yoke is a small agent harness. It connects DeepSeek to file-system tools and a
SQLite-backed code index, served through a web UI with user accounts.

## Installation

**From source (requires [Deno](https://deno.com) 2.x):**

```
git clone https://github.com/tkleisas/yoke.git && cd yoke
deno run --allow-net --allow-env --allow-read --allow-write --allow-run main.ts
```

**Prebuilt binaries** (Windows / Linux / macOS): download the archive for your
platform from the [latest release](https://github.com/tkleisas/yoke/releases)
and run the `yoke` binary — no Deno installation needed.

Or install the latest release automatically:

```
# Linux / macOS
curl -fsSL https://raw.githubusercontent.com/tkleisas/yoke/main/scripts/install.sh | bash

# Windows (PowerShell)
irm https://raw.githubusercontent.com/tkleisas/yoke/main/scripts/install.ps1 | iex
```

The version is shown in the web UI header and exposed at `/api/version`.

## Versioning

Yoke follows [Semantic Versioning](https://semver.org/). The current version
lives in `deno.json`; changes are documented in
[CHANGELOG.md](CHANGELOG.md). Release binaries are built by GitHub Actions
when a tag like `v0.1.0` is pushed:

```
git tag v0.1.0 && git push origin v0.1.0
```

## Features

- **Agent loop** with tools: `read_file`, `write_file`, `list_directory`, `search_code`, `run_command`, `finish`.
- **Token streaming**: the agent's reply streams into the chat as it's generated, including a collapsible **thinking** block for reasoning content. Tool calls show up instantly and update as they complete. Runs can be **stopped** with the ⏹ button (or `POST /api/agent/stop`).
- **Thinking effort**: per-user `reasoning_effort` selection (`auto`/`low`/`medium`/`high`) via the header dropdown, `/thinking`, or `POST /api/thinking`; `auto` sends nothing so the provider uses its default.
- **Local shell commands**: the agent can run workspace shell commands (`run_command` tool) and you can run them directly with `!command` — each one is approved from the web UI before it runs.
- **User accounts** (username + password) stored in SQLite. Passwords are hashed with PBKDF2-SHA256.
- **Session tokens**: login issues a session token (stored in SQLite, expires after 7 days) used as `Authorization: Bearer <token>`.
- **CLI-only user creation**: accounts are created with `create-user.ts` — the web UI only supports logging in.
- **Persistent per-user context**: tasks build on previous ones; `/compact`, `/summarize`, `/reset`, `/usage` manage it. Context is scoped per user **and** per project.
- **Append-only message history**: every message (user, assistant, tool calls, tool responses) is stored as a row in SQLite. Compaction/summarization/reset only *archive* older messages — nothing is deleted; `/history` views them and `/restore` brings them back into context.
- **Projects**: each project has its own work directory and can pin its own model. Switch with the header dropdown or `/project`; agent tools, shell commands, indexing, search, and context all follow the active project.
- **Multiple models**: per-user model selection (header dropdown or `/model`), configurable via `DEEPSEEK_MODELS`. A project's model overrides the user's.
- **Code & file indexing**: recursively scans the workspace, extracts symbols (functions, classes, etc.) per language, and keeps the index incremental (mtime + content-hash aware).
- **Search** over indexed symbols and file paths.
- **Web access**: the agent can search the web (`web_search`, via Bing RSS, no API key) and fetch pages as markdown (`web_fetch`). Also available from the UI as `/web <query>` and `/fetch <url>`.
- **Shell commands** from the UI: `!command` runs synchronously (default 15s timeout), `!!command` runs in the **background** as a job, and `!timeout=<seconds>` / `!!timeout=<seconds>` sets a limit (1-3600s). Each command is approved from the web UI before it runs, instead of Deno prompting on the server terminal. Background jobs are listed in the Shell jobs panel and with `/shells` / `/shell <id>`; running jobs can be stopped.
- **Slash commands** in the chat input: `/help`, `/clear`, `/reset`, `/compact`, `/summarize`, `/usage`, `/model`, `/thinking`, `/maxtries`, `/project`, `/reindex`, `/search`, `/shell`, `/shells`, `/status`, `/theme`, `/logout`.

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
| `MAX_ITERATIONS` | `100` | Default max LLM iterations per agent run (1-30000). |
| `MAX_SUBAGENT_ITERATIONS` | `MAX_ITERATIONS` | Default max LLM iterations for subagents. |
| `APPROVAL_TIMEOUT_MINUTES` | `5` | How long a shell-command approval prompt stays valid. |
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

`!command` runs synchronously (15s timeout); `!timeout=120 command` raises the
limit to 2 minutes. `!!command` starts a background job that returns
immediately — check it with `/shell <id>`, `/shells`, or the Shell jobs panel,
and stop it with `/shell stop <id>`.

## Development

Tests run with the built-in Deno test runner (TDD workflow):

```
deno task test     # unit + integration tests (spins up an in-process SSH server)
deno task check    # type-check all modules
```

Test data lives in `.test-data/` (gitignored). The test suite covers approvals,
conversation context, web fetching/markdown conversion, and remote-host
operations (CRUD, exec, status, SFTP transfer, deploy) against a real
in-process SSH server fixture (`tests/helpers.ts`).

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

Each project has its own **working directory** and can pin its own LLM model.
When a project is active, agent tools, `!` shell commands, indexing, search,
and the conversation context all operate in that project's directory; the
project's model (if set) overrides the user's selected model.

- Create a project from the UI (header **＋** button): set the project name,
  the **working directory** (an absolute path, or a relative path resolved
  against the default workspace), and an optional model.
- Change an existing project's working directory or model with the header
  **✎** button (or `POST /api/projects/<id>`).
- API:
  - `POST /api/projects` `{ "name": "...", "path": "...", "model": "..." }`
  - `POST /api/projects/<id>` `{ "path": "...", "model": "..." }` — update
  - `DELETE /api/projects/<id>`
  - `POST /api/project` `{ "project_id": <id> }` — activate (omit/null = default workspace)
- Or in the chat: `/project`, `/project <name>`, `/project create <name> <path> [model=<model>]`, `/project update <name> path=<dir> [model=<model>]`, `/project delete <name>`.
- Each project gets its own conversation context (run `/reindex` after switching to index its files).

## API

All `/api/*` endpoints (except login) require `Authorization: Bearer <token>`.

- `POST /api/login` `{ "username": "...", "password": "..." }` → `{ token, user }`
- `POST /api/logout` — invalidates the session
- `GET /api/me` → `{ user }`
- `GET /api/status` → `{ user, model, user_model, models, max_iterations, project, projects, workspace, index, context, usage }`
- `POST /api/model` `{ "model": "..." }` — set the user's model
- `POST /api/thinking` `{ "thinking_effort": "low"|"medium"|"high"|"" }` — set the user's reasoning effort (empty = auto)
- `POST /api/maxtries` `{ "max_iterations": n }` — set the user's max iterations (1-30000)
- `GET /api/projects` / `POST /api/projects` / `DELETE /api/projects/<id>`
- `POST /api/project` `{ "project_id": <id> | null }` — activate a project
- `POST /api/compact` `{ "keep": n }` — trim agent context to the last n messages (archives the rest)
- `POST /api/summarize` — replace agent context with an LLM summary (archives the original messages)
- `POST /api/reset` — reset agent context (archives all messages)
- `POST /api/restore` — bring archived messages back into context
- `GET /api/history?limit=n` — full message history for the active project (active + archived)
- `POST /api/shell` `{ "command": "...", "timeout_seconds": n, "async": bool }` — run a shell command in the active workspace (waits for UI approval; `async: true` returns a `job_id` immediately and runs in the background)
- `GET /api/shell/jobs` — list background shell jobs
- `GET /api/shell/<id>` — status + output of a shell job
- `POST /api/shell/<id>/stop` — stop a running shell job
- `POST /api/agent/stop` — stop the current agent run
- `GET /api/approvals` / `POST /api/approvals/<id>` `{ "action": "approve"|"deny", "always": bool }`
- `POST /api/index` — (re)index the active workspace, returns counts
- `GET /api/search?q=...` → `{ symbols, files }`
- `GET /api/subagents` / `POST /api/subagents` `{ "task": "..." }`
- `POST /api/web` `{ "action": "search", "query": "..." }` or `{ "action": "fetch", "url": "..." }`
- `POST /api/agent` `{ "task": "..." }` — runs the agent in the active project, streams SSE events

## Remote hosts & sudo

Hosts are configured in the UI (hosts panel) or via the API: name, address,
port, SSH user, and auth (private key path or password). Commands run over SSH
via `remote_exec` / `/ssh <host> <command>` / `!`-style approvals.

**sudo**: a command starting with `sudo` is executed as `sudo -S <cmd>` with
the password fed through stdin — the password never appears in the command
string, process list, or approval cards. The password used is the host's
optional `sudo_password`, or the SSH password when the host uses password
authentication. If neither is available, sudo commands are rejected with a
clear error (or rely on passwordless sudo).

## Notes

- The workspace is shared by all users.
- Indexing skips `.git`, `node_modules`, `dist`, build output, and binary/large files.
- Sessions are cleaned up hourly.
