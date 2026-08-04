# Changelog

All notable changes to Yoke are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.6.1] - 2026-08-05

### Fixed

- **UI freezes during streaming** — the chat re-parsed and re-sanitized the
  whole markdown buffer on every token (O(n²), caused browser "wait" dialogs
  on long answers). Streaming renders are now throttled (~150ms) with a full
  render on finish, and auto-scroll no longer yanks the view when scrolled up.
- **Stop button reliability** — aborting mid-stream now actually cancels the
  in-flight LLM request (the caller-abort listener was dropped after
  connect); tool executions (shell, approvals, subagent waits) receive the
  abort signal; the dispatch loop stops between tool calls; fixed a race
  where `activeRuns` cleanup could delete a newer run's controller; stop
  requests arriving before a run registers are remembered (30s); the Stop
  button re-enables for repeated attempts and the client drops a stuck SSE
  stream after 5s as a last resort. Spawned subagents share the parent's
  abort signal.

## [0.6.0] - 2026-08-05

### Added

- **Docker images** — `Dockerfile` with two flavors (`yoke:slim`, `yoke:full`
  with build toolchains), `docker-compose.yml`, and
  `scripts/docker-build.sh`. The agent's shell commands run inside the
  container; the workspace is bind-mounted and the database/TLS certs persist
  in a volume.
- **Multiple LLM API formats** — `LLM_API_FORMAT` selects the wire format:
  `chat` (OpenAI chat completions, default), `responses` (OpenAI Responses
  API, `deepseek-v4-flash` only), or `anthropic` (Anthropic messages API).
  Message/tool-call conversion happens in the new `llm.ts` provider layer.
- **LLM request resilience** — all LLM calls retry transient failures
  (network errors, 408/409/425/429, 5xx; `Retry-After` honored) with
  full-jitter exponential backoff, and have request timeouts. Tunable via
  `DEEPSEEK_MAX_RETRIES`, `DEEPSEEK_RETRY_BASE_MS`, `DEEPSEEK_RETRY_MAX_MS`,
  `DEEPSEEK_TIMEOUT_MS`. Streaming calls retry only before the first delta.
- **SSH connection pooling + retries** — connections are pooled per host
  config and reused across exec/status/SFTP operations (status checks now
  share one connection). Transient transport errors retry with exponential
  backoff (`SSH_MAX_RETRIES`, `SSH_RETRY_BASE_MS`); auth failures are never
  retried. SFTP operations have timeouts (`SFTP_TIMEOUT_MS`) instead of
  hanging forever.

### Fixed

- **Shell timeout kills the process tree** — on Linux/macOS commands run via
  `setsid` and a timeout/stop signals the whole process group, so background
  grandchildren (e.g. servers started by a command) no longer survive.
- **Project deletion** — `deleteProject` no longer throws on migrated
  databases (it deleted from the dropped `conversations` table).
- **Subagents inherit model settings** — spawned subagents now use the
  parent's effective model (project pin included) and thinking effort.

## [0.5.0] - 2026-08-01

### Added

- **CLI subcommands in the binary** — the released executable can create
  users directly: `yoke create-user <username> <password>` (respects
  `DATABASE_PATH`). `yoke version` prints the version.

## [0.4.0] - 2026-08-01

### Added

- **YOLO mode** — per-user 🔥 YOLO toggle (header button or `/yolo on|off`)
  disables approval prompts: shell commands, background jobs, and remote
  operations run immediately without confirmation. Requires explicit
  confirmation when enabling; `POST /api/yolo` to control via API.

## [0.3.0] - 2026-08-01

### Added

- **Stop actions** — a ⏹ Stop button (or `POST /api/agent/stop`) cancels the
  running agent run; the run ends with a "Run stopped" notice instead of an
  error.
- **Shell command timeouts** — `!timeout=<seconds>` and `timeout_seconds` on
  `POST /api/shell` and the agent's `run_command` tool set a per-command limit
  (1-3600s, default 15s).
- **Background shell jobs** — `!!<command>` runs asynchronously: the request
  returns a job id immediately, the command waits for approval then runs in
  the background. New endpoints `GET /api/shell/jobs`,
  `GET /api/shell/<id>`, `POST /api/shell/<id>/stop`, a Shell jobs panel, and
  `/shell`, `/shell stop`, `/shells` commands.
- **History restore** — the conversation is restored into the view on login,
  page reload, and project switch (active + archived messages, tool calls and
  results included).
- **Higher default iterations** — default max agent iterations raised from 10
  to 100 (max 30,000).
- **Configurable approval timeout** — `APPROVAL_TIMEOUT_MINUTES` env var
  (default 5).

### Fixed

- **Approval prompts during agent runs** — approval cards now render while the
  agent waits for permission on `run_command`/remote tools (polling previously
  only ran for `!` shell commands, so prompts silently expired).
- **Shell timeout/stop actually kills the command** — Deno's `AbortSignal`
  does not kill subprocesses; output now goes to temp files and the process is
  terminated explicitly.

## [0.2.0] - 2026-08-01

### Added

- **Token streaming** — the agent's reply now streams into the chat as it is
  generated, including a collapsible thinking block for reasoning content.
  Tool calls appear instantly and update as they complete.
- **Thinking effort** — per-user `reasoning_effort` selection
  (`auto`/`low`/`medium`/`high`) via a header dropdown, `/thinking`, or
  `POST /api/thinking`.
- **Local shell commands** — new `run_command` agent tool that executes
  commands in the workspace (approved from the web UI).
- **Iteration indicator** — the UI shows the current agent iteration
  (`⚙️ Iteration N / M`) during a run.
- **Higher iteration limits** — max agent iterations raised to 30,000.

## [0.1.0] - 2026-07-31

First release.

### Added

- **Agent harness** — DeepSeek-powered coding agent with tools: `read_file`,
  `write_file`, `list_directory`, `search_code`, `finish`.
- **Subagents** — spawn background subagents (`spawn_subagent`), poll
  (`check_subagent`), or block for results (`wait_subagent`); live monitor in
  the UI.
- **User accounts** — username/password login with PBKDF2-hashed passwords and
  SQLite-backed session tokens. Users are created via the CLI
  (`create-user.ts`).
- **Projects** — each project has its own working directory and can pin its own
  LLM model; per-project conversation context.
- **Context management** — persistent per-user/per-project message history
  stored as append-only rows (tool calls and responses included). Compaction,
  summarization, and reset archive messages instead of deleting them;
  `/history` views them and `/restore` brings them back.
- **Code & file indexing** — incremental symbol extraction for 12 languages
  with search (`/api/search`, `search_code` tool).
- **Web access** — `web_search` (Bing RSS, no API key) and `web_fetch`
  (HTML → markdown) tools, plus `/web` and `/fetch` commands.
- **Remote hosts** — SSH inventory with key/password auth, `remote_exec`,
  `remote_status`, SFTP upload/fetch, and full directory deploys with
  post-deploy commands. **sudo** is supported via `sudo -S` with the password
  fed through stdin (never in command text).
- **UI approvals** — shell and remote commands require an in-UI permission
  prompt (Approve / Allow always / Deny) instead of a terminal prompt.
- **Multiple models** — per-user and per-project model selection
  (`DEEPSEEK_MODELS`, `/model`).
- **Web UI** — chat-style interface with dark mode, markdown rendering, hosts
  and subagents panels, project and model selectors, and slash commands
  (`/help`, `/compact`, `/summarize`, `/usage`, `/history`, `/restore`, …).
- **Self-signed HTTPS** — automatic certificate generation (`ENABLE_HTTPS`).
- **Testing** — Deno test suite (unit + integration against an in-process SSH
  server fixture): `deno task test`.

### Security

- Passwords hashed with PBKDF2-SHA256 (100k iterations).
- Workspace sandboxing for file tools (path traversal protection).
- Shell execution gated by human approval in the UI.
- SSH/sudo passwords sent over the encrypted channel via stdin only.
