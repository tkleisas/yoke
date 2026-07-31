# Changelog

All notable changes to Yoke are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
