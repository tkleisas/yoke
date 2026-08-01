# Changelog

All notable changes to Yoke are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
