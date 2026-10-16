# How VinaX compares

<p class="lead">VinaX feature by feature against Claude Code, OpenAI Codex CLI and Google Gemini CLI: what it has, what was added in the latest parity round, and what is still missing.</p>

**Status:** **Have** — VinaX already did this. **Built in this round** — added in parity round 1. **Partial** — covered, but narrower than the others. **Gap** — not in VinaX yet. **Removed on purpose** — VinaX had it and dropped it.

The other tools' columns describe their public CLI features as of late 2026; they change fast, so treat them as a guide rather than a spec.

## Tools the model can call

| Feature                         | Claude Code                  | Codex CLI               | Gemini CLI                                      | VinaX                                                           | Status                    |
| ------------------------------- | ---------------------------- | ----------------------- | ----------------------------------------------- | --------------------------------------------------------------- | ------------------------- |
| Read / write / edit files       | Read, Write, Edit, MultiEdit | `apply_patch`           | `read_file`, `write_file`, `replace`            | `Read`, `Write`, `Edit`, `MultiEdit`                            | Have                      |
| Read many files at once         | via Glob + Read              | —                       | `read_many_files`                               | Glob + Read, `@` mentions                                       | Partial                   |
| Find files / search text / list | Glob, Grep, LS               | shell                   | `glob`, `search_file_content`, `list_directory` | `Glob`, `Grep` (ripgrep), `LS`                                  | Have                      |
| Shell commands, background jobs | Bash, BashOutput, KillShell  | `shell`                 | `run_shell_command`                             | `Bash`, `BashOutput`, `KillBash`                                | Have                      |
| Web fetch                       | WebFetch                     | —                       | `web_fetch`                                     | `WebFetch` (Markdown + small-model answer)                      | Have                      |
| Web search                      | WebSearch                    | `--search` (web_search) | `google_web_search`                             | `WebSearch` — DuckDuckGo with no key, Brave/Tavily with one     | **Built in this round**   |
| Task list                       | TodoWrite                    | `update_plan`           | `write_todos`                                   | `TodoWrite`                                                     | Have                      |
| Ask the user a question         | AskUserQuestion              | —                       | —                                               | `AskUserQuestion`                                               | Have                      |
| Save to memory from the model   | `#` (user)                   | —                       | `save_memory`                                   | `#` prefix and `/memory add` (user only)                        | Partial                   |
| Jupyter notebooks               | NotebookEdit                 | —                       | —                                               | —                                                               | Gap                       |
| Sub-agents                      | Task + `.claude/agents`      | —                       | (experimental)                                  | `Task` + `.vinax/agents`                                        | Have                      |
| Skills                          | Skill tool, SKILL.md         | —                       | —                                               | `Skill`, SKILL.md                                               | Have                      |
| Plan approval                   | ExitPlanMode                 | —                       | —                                               | `ExitPlanMode`                                                  | Have                      |
| Image input                     | paste, drag, path            | `-i`, paste             | paste, `@file`                                  | `Ctrl+V`, paths, `@file.png`, vision model for text-only models | Have                      |
| PDF / audio / video input       | PDF                          | —                       | PDF, audio, video                               | screen recordings (`@bug.mov`, Read), via a vision model        | Partial (no PDF or audio) |

## Modes, approvals and sandboxing

| Feature                       | Claude Code                      | Codex CLI                       | Gemini CLI                                | VinaX                                            | Status                                  |
| ----------------------------- | -------------------------------- | ------------------------------- | ----------------------------------------- | ------------------------------------------------ | --------------------------------------- |
| Ask before edits / commands   | default                          | on-request                      | default                                   | `default` (manual)                               | Have                                    |
| Auto-accept edits             | acceptEdits                      | —                               | `auto_edit`                               | `acceptEdits`                                    | Have                                    |
| Plan mode                     | plan                             | —                               | —                                         | `plan`                                           | Have                                    |
| Autonomous inside the project | auto (classifier)                | `--full-auto` (workspace-write) | —                                         | `auto`                                           | Have                                    |
| Read-only mode                | —                                | `read-only` preset              | —                                         | `readOnly` / `--read-only`                       | **Built in this round**                 |
| Skip all approvals            | `--dangerously-skip-permissions` | `--yolo`                        | `--yolo`                                  | `bypass` / `--yolo`, refused as root             | **Built in this round**                 |
| `--approval-mode` names       | —                                | `-a`                            | `--approval-mode`                         | `--approval-mode default\|auto_edit\|plan\|yolo` | **Built in this round**                 |
| Allow / ask / deny rules      | settings + `/permissions`        | —                               | `tools.allowed`/`excluded`                | settings, `--allowedTools`, `/permissions`       | Have                                    |
| OS sandbox for commands       | Seatbelt / bubblewrap            | Seatbelt / Landlock             | Seatbelt profiles, Docker/Podman          | `sandbox`: Seatbelt (macOS) or bwrap (Linux)     | **Built in this round**                 |
| Container sandbox             | devcontainer                     | —                               | Docker / Podman                           | —                                                | Gap                                     |
| Extra workspace folders       | `--add-dir`, `/add-dir`          | `--add-dir`                     | `--include-directories`, `/directory add` | `--add-dir`, `/directory add`, `/add-dir`        | **Built in this round** (slash command) |
| Trusted-folder prompt         | yes                              | yes                             | trusted folders                           | project MCP servers ask once                     | Partial                                 |

## Memory and context

| Feature                        | Claude Code           | Codex CLI            | Gemini CLI                 | VinaX                                                                            | Status                                |
| ------------------------------ | --------------------- | -------------------- | -------------------------- | -------------------------------------------------------------------------------- | ------------------------------------- |
| Project instruction file       | CLAUDE.md             | AGENTS.md            | GEMINI.md                  | VINAX.md, AGENTS.md, **CLAUDE.md, GEMINI.md**, `.github/copilot-instructions.md` | **Built in this round** (extra names) |
| User-wide instructions         | `~/.claude/CLAUDE.md` | `~/.codex/AGENTS.md` | `~/.gemini/GEMINI.md`      | `~/.vinax/VINAX.md`                                                              | Have                                  |
| Nested / per-folder files      | yes                   | yes                  | yes                        | yes, loaded on first use                                                         | Have                                  |
| `@imports`                     | yes                   | —                    | yes                        | yes (4 levels)                                                                   | Have                                  |
| `/memory` show / add / refresh | edit                  | —                    | show, add, refresh, list   | edit, **show, list, add, refresh**                                               | **Built in this round**               |
| `/init`                        | yes                   | yes                  | yes                        | yes                                                                              | Have                                  |
| Compaction                     | `/compact`, auto      | `/compact`, auto     | `/compress`                | `/compact` (`/compress`), auto                                                   | Have                                  |
| Checkpoints / rewind           | `/rewind`, Esc Esc    | —                    | `/restore` (shadow git)    | `/rewind` (`/restore`, `/checkpoint`), Esc Esc                                   | Have                                  |
| Named saved chats              | `--resume`            | `codex resume`       | `/chat save\|resume\|list` | `-c`, `-r`, `/resume` (titled sessions)                                          | Partial                               |
| Export conversation            | `/export`             | —                    | `/chat share`              | `/export`                                                                        | Have                                  |

## Commands and keys

| Feature                                 | Claude Code             | Codex CLI              | Gemini CLI                | VinaX                                               | Status                  |
| --------------------------------------- | ----------------------- | ---------------------- | ------------------------- | --------------------------------------------------- | ----------------------- |
| Custom slash commands                   | `.claude/commands/*.md` | `~/.codex/prompts`     | `.gemini/commands/*.toml` | `.vinax/commands/*.md` (args, allowed-tools, model) | Have                    |
| `/review` code review                   | yes                     | yes                    | —                         | `/review [pr\|branch]`                              | **Built in this round** |
| `/security-review`                      | yes                     | —                      | —                         | yes                                                 | **Built in this round** |
| `/pr-comments`                          | yes                     | —                      | —                         | yes (via `gh`)                                      | **Built in this round** |
| `/tools`                                | —                       | —                      | yes                       | yes                                                 | **Built in this round** |
| `/todos`, `/bashes`                     | yes                     | —                      | —                         | yes                                                 | **Built in this round** |
| `/approvals`, `/extensions` names       | —                       | `/approvals`           | `/extensions`             | aliases of `/permissions`, `/plugin`                | **Built in this round** |
| `/model`, `/status`, `/doctor`, `/help` | yes                     | yes                    | yes                       | yes                                                 | Have                    |
| `!` shell, `@` files, `#` memory        | yes                     | — (`!` in some builds) | `!`, `@`                  | yes                                                 | Have                    |
| Command palette / transcript search     | — / Ctrl+R              | —                      | —                         | Ctrl+P / Ctrl+O                                     | Have                    |
| Vim mode                                | `/vim`                  | —                      | `/vim`                    | `/vim`                                              | Have                    |
| Custom key bindings                     | `keybindings.json`      | —                      | —                         | —                                                   | Gap                     |
| Custom status line                      | `/statusline`           | —                      | —                         | —                                                   | Gap                     |
| Themes                                  | several                 | —                      | many                      | dark, light, colour-blind                           | Partial                 |

## Extending VinaX

| Feature                             | Claude Code        | Codex CLI          | Gemini CLI    | VinaX                                                                   | Status  |
| ----------------------------------- | ------------------ | ------------------ | ------------- | ----------------------------------------------------------------------- | ------- |
| MCP client (stdio, HTTP)            | yes                | yes                | yes           | yes                                                                     | Have    |
| MCP OAuth login                     | yes                | yes                | yes           | —                                                                       | Gap     |
| Run as an MCP server                | `claude mcp serve` | `codex mcp-server` | —             | —                                                                       | Gap     |
| Hooks                               | ~9 events          | `notify`           | hooks (newer) | 5 events: PreToolUse, PostToolUse, UserPromptSubmit, Stop, SessionStart | Partial |
| Plugins / extensions + marketplaces | plugins            | —                  | extensions    | plugins + marketplaces                                                  | Have    |
| Output styles                       | yes                | —                  | —             | yes                                                                     | Have    |
| SDK for building agents             | Agent SDK          | Codex SDK          | —             | `@vinax/core` (not a documented SDK)                                    | Partial |

## Headless, CI and integrations

| Feature                              | Claude Code                  | Codex CLI          | Gemini CLI              | VinaX                                                     | Status                  |
| ------------------------------------ | ---------------------------- | ------------------ | ----------------------- | --------------------------------------------------------- | ----------------------- |
| Non-interactive run                  | `-p`                         | `codex exec`       | `-p`                    | `-p`                                                      | Have                    |
| JSON / streaming JSON output         | yes                          | `--json`           | yes                     | `--output-format json\|stream-json`                       | Have                    |
| Streaming JSON _input_               | `--input-format stream-json` | —                  | —                       | —                                                         | Gap                     |
| Turn / budget limits                 | `--max-turns`                | —                  | —                       | `--max-turns` (token and time budgets removed on purpose) | Have                    |
| Git worktrees                        | via `--worktree` docs        | —                  | —                       | `--worktree`, `vinax worktree`                            | Have                    |
| GitHub Action / app                  | yes                          | Codex cloud review | `run-gemini-cli` action | —                                                         | Gap                     |
| PR review from the CLI               | `/review`                    | `/review`          | —                       | `/review 42` via `gh`                                     | **Built in this round** |
| IDE integration (VS Code, JetBrains) | yes                          | VS Code extension  | VS Code companion       | —                                                         | Gap                     |
| Cloud / remote tasks                 | web + `--remote`             | `codex cloud`      | —                       | —                                                         | Gap                     |

## Accounts, models and privacy

| Feature                          | Claude Code                              | Codex CLI                 | Gemini CLI                      | VinaX                                                             | Status             |
| -------------------------------- | ---------------------------------------- | ------------------------- | ------------------------------- | ----------------------------------------------------------------- | ------------------ |
| Sign-in                          | Claude account, API key, Bedrock, Vertex | ChatGPT account, API key  | Google account, API key, Vertex | API keys per provider (`/login`), optional shared gateway         | Have               |
| Many providers / free models     | Anthropic only                           | OpenAI (+ OSS via config) | Gemini only                     | Groq, NVIDIA, OpenRouter, Gemini, OpenAI, Claude, … with fallback | Have               |
| Telemetry / OpenTelemetry export | yes                                      | yes                       | yes                             | none (no telemetry is sent)                                       | Gap (by choice)    |
| Usage and cost                   | `/cost`, `/usage`                        | `/status`                 | `/stats`                        | — (usage, cost and context reporting removed)                     | Removed on purpose |

## What is left

The most useful gaps, roughly in the order they are worth doing:

1. **IDE integration** — a VS Code extension or an `/ide` bridge that shares the open file and selection and shows diffs in the editor.
2. **GitHub Action** — run VinaX on PRs and issues (`@vinax` mentions, review comments) in CI.
3. **MCP OAuth** — log in to remote MCP servers that need it.
4. **More hook events** — Notification, PreCompact, SubagentStop, SessionEnd.
5. **Container sandbox** — Docker/Podman for systems without Seatbelt or bubblewrap (Windows, minimal Linux).
6. **PDF input** — read PDFs as text or images, as Claude Code and Gemini CLI do.
7. **NotebookEdit** — edit Jupyter notebooks cell by cell.
8. **Named chat checkpoints** — `/chat save <tag>` / `/chat resume <tag>` on top of sessions.
9. **Custom status line and key bindings** — a `statusLine` command and `keybindings.json`.
10. **Run as an MCP server** — expose VinaX's tools to other clients.
11. **Streaming JSON input** for driving VinaX from another program.
12. **Cloud / remote tasks** — out of scope for a local, bring-your-own-key CLI for now.
