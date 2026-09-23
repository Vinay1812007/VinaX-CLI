# VinaX CLI

VinaX (`vinax`) is an open-source agentic coding assistant for the terminal, powered by free-tier
models from **Groq** and **OpenRouter**.

> **Status: milestones M1–M5.** VinaX reads, searches and edits your code, runs commands and asks
> before anything risky. It has slash and custom commands, `@` file mentions, project memory, saved
> sessions and automatic compaction, plus hooks, MCP servers, sub-agents and WebFetch. It runs on
> Groq and OpenRouter free tiers with automatic fallback. Packaging and release (M6) come next. See
> [docs/PLAN.md](docs/PLAN.md) for the roadmap.

## Requirements

- Node.js **22 or newer**
- A free API key from [Groq](https://console.groq.com/keys) and/or
  [OpenRouter](https://openrouter.ai/keys)

## Install from source

```sh
git clone https://github.com/Vinay1812007/VinaX-CLI.git
cd VinaX-CLI
npm i -g pnpm
pnpm install
pnpm build
node packages/cli/dist/vinax.js --help   # or: pnpm vinax --help
```

## Add your API keys

Environment variables always take precedence over stored keys:

```sh
export GROQ_API_KEY=gsk_...
export OPENROUTER_API_KEY=sk-or-...
```

Or store them. `set-key` checks the key live against the provider before saving it to the OS keychain
(falling back to `~/.vinax/credentials.json`, mode 0600):

```sh
vinax config set-key groq          # prompts without echoing
echo "$KEY" | vinax config set-key openrouter
vinax config keys                  # shows masked keys and where each one comes from
vinax config remove-key groq
```

## Interactive mode

```sh
vinax                      # start in the current folder
vinax "explain this repo"  # start with a first prompt
```

On first run VinaX asks for a colour theme (dark, light or colour-blind friendly), your provider,
your API keys (each is checked live before it's saved) and a default model. The first time you
use a folder, VinaX asks whether you trust the files in it. The answer covers that folder and
every folder inside it.

Answers stream in as formatted Markdown: headings, lists, tables and syntax-highlighted code.
While a reply is streaming, the activity line shows elapsed time, an approximate token count and
`esc to interrupt`. The footer shows the current mode, the model that answered, how much of the
context budget is used, and any fallback or rate-limit notice.

| Key                                                 | Action                                                         |
| --------------------------------------------------- | -------------------------------------------------------------- |
| `Enter`                                             | Send (typing while a reply streams queues the next prompt)     |
| `\` then `Enter`, `Shift+Enter`, `Option/Alt+Enter` | New line (`Shift+Enter` needs a terminal that reports it)      |
| `↑` / `↓`                                           | Move between lines, then walk this project's history           |
| `Ctrl+R`                                            | Search prompt history (press again for older matches)          |
| `Esc`                                               | Stop the current reply; what was written is kept               |
| `Esc Esc`                                           | Clear the prompt; on an empty prompt, open the rewind picker   |
| `Shift+Tab`                                         | Cycle default → auto-accept edits → plan mode                  |
| `Ctrl+O`                                            | Turn details: model, tokens, time, fallbacks, live rate limits |
| `?` (empty prompt)                                  | Show all shortcuts                                             |
| `Ctrl+A` `Ctrl+E` `Ctrl+W` `Ctrl+U` `Ctrl+K`        | Line start/end, delete word/to start/to end                    |
| `Ctrl+C`                                            | Clear the prompt; press again within 2s to exit                |
| `Ctrl+D`                                            | Exit (on an empty prompt)                                      |

Pastes of 8 or more lines (or 800+ characters) collapse into `[Pasted text #1 +42 lines]`, and the
full text is sent. Prompt history is stored per project in `~/.vinax/projects/<folder>/`.

## What VinaX can do

VinaX works as an agent: it reads your code, makes changes and runs commands to check them,
repeating until the task is done. Each tool call appears in the transcript as one line, with a
one-line result underneath:

```
▸ Bash node --test
  └ Exit 1 · 31 lines · 0.1s
▸ Edit src/math.js
  └ Changed +1 −1 lines
      4 -   return sum / (values.length - 1);
      4 +   return sum / values.length;
```

| Tool                 | What it does                                                                                                                                                                                                                                                         |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Read`               | Reads a file with line numbers (`offset`/`limit` for long files)                                                                                                                                                                                                     |
| `Glob`, `Grep`, `LS` | Finds files, searches contents (ripgrep, with a JavaScript fallback) and lists folders; all respect `.gitignore`                                                                                                                                                     |
| `Edit`, `MultiEdit`  | Replace exact text. The file must have been read first, and the edit is refused if it changed since                                                                                                                                                                  |
| `Write`              | Creates a file or replaces one (existing files must be read first)                                                                                                                                                                                                   |
| `Bash`               | Runs a command. The working directory persists between calls. Commands time out (2 min default, 10 max) and can run in the background (`BashOutput`, `KillBash`). Interactive programs are refused. On Windows it uses Git Bash when installed, otherwise PowerShell |
| `TodoWrite`          | Keeps a live task list, shown above the prompt                                                                                                                                                                                                                       |
| `ExitPlanMode`       | Presents a plan for your approval in plan mode                                                                                                                                                                                                                       |
| `WebFetch`           | Fetches a URL, converts HTML to Markdown and has the small model answer a question about it. Asks per domain (`WebFetch(domain:example.com)`); redirects to another host are reported rather than followed                                                           |
| `Task`               | Hands a self-contained job to a sub-agent with its own context and gets its report back                                                                                                                                                                              |
| `mcp__server__tool`  | Tools from your MCP servers                                                                                                                                                                                                                                          |

**Tool calling on free models.** VinaX uses native function calling first. A model can be switched
to VinaX's text protocol (tool calls written as `<vx:call>` blocks in its reply) in three cases:

- the catalog says it doesn't support tools
- the provider rejects its tool call (Groq `tool_use_failed`)
- it sends two malformed calls

Every argument is validated with zod, and validation errors go back to the model so it can
correct itself.

## Permissions

Reading inside the project is always allowed. Edits, commands, and reads outside the project
ask first. The prompt offers these choices:

1. **Yes**
2. **Yes, and don't ask again** for a suggested rule such as `Bash(npm test:*)`, either for this
   session or for this project (saved to `.vinax/settings.local.json`). For edits, you can instead
   **auto-accept edits** for the rest of the session.
3. **No, and tell VinaX what to do differently.** Your note goes to the model, and it carries on.
   Esc just stops.

Some actions **always** ask, even with allow rules or auto-accept on:

- `rm -rf` and other recursive deletes
- force-pushes, `git reset --hard` and `git clean`
- `curl … | sh`
- `sudo`
- writes outside the project

**Modes** (Shift+Tab, or `--permission-mode`):

| Mode          | Behaviour                                                                                                          |
| ------------- | ------------------------------------------------------------------------------------------------------------------ |
| `default`     | Asks before edits and commands                                                                                     |
| `acceptEdits` | Edits inside the project are approved automatically; commands still ask                                            |
| `plan`        | Read-only. VinaX researches, then presents a plan. You approve it (with or without auto-accept) or ask for changes |

**Rules** live in settings under `permissions.allow`, `ask` and `deny`, or are passed with
`--allowedTools` and `--disallowedTools`. Deny always wins.

| Rule                                 | Matches                                                          |
| ------------------------------------ | ---------------------------------------------------------------- |
| `Bash(npm run test:*)`               | `npm run test`, `npm run test -- -u` (prefix on a word boundary) |
| `Bash(git log *)`                    | `*` wildcard; a trailing ` *` also matches plain `git log`       |
| `Edit(src/**)`                       | Edits and writes under `src/` (relative to the project root)     |
| `Read(*.env)`                        | That file name at any depth                                      |
| `Read(~/notes/**)`, `Edit(//tmp/**)` | Home-relative and absolute paths                                 |
| `WebFetch(domain:github.com)`        | A domain and its subdomains                                      |
| `mcp__github__*`                     | Every tool from one MCP server                                   |

A compound command such as `a && b | c` is allowed only when **every** part matches an allow rule.
Commands containing `$(…)` or backticks always ask.

**Rewind.** Press Esc twice on an empty prompt and pick an earlier prompt. You can restore:

- the conversation, the files, or both
- only the files changed through VinaX's file tools, not files changed by shell commands

## Commands, prefixes and memory

Type `/` for a menu of commands (↑↓ to choose, Tab to complete, Enter to run).

| Command                           | What it does                                                                   |
| --------------------------------- | ------------------------------------------------------------------------------ |
| `/help`                           | Commands and shortcuts                                                         |
| `/clear`                          | Start a new conversation (the old one stays available in `/resume`)            |
| `/compact [focus]`                | Summarize the conversation to free up context                                  |
| `/model [provider:model]`         | Switch the model for this session (with a picker)                              |
| `/resume`, `/rewind`              | Continue an earlier conversation; go back to an earlier prompt                 |
| `/init`, `/memory`                | Write a starter `VINAX.md`; edit memory files in `$EDITOR`                     |
| `/status`, `/usage`               | Session, remaining rate limits, OpenRouter quota; requests and tokens today    |
| `/doctor`                         | Checks Node, settings, keys (live), ripgrep, shell, git, keychain and terminal |
| `/login`, `/logout`               | Add, replace or remove a provider key without leaving the session              |
| `/config`, `/permissions`         | Show the effective settings and permission rules                               |
| `/theme`, `/vim`                  | Change the colour theme; toggle vim key bindings (saved)                       |
| `/export [file]`, `/bug`, `/exit` | Save the conversation as Markdown; open a pre-filled GitHub issue; quit        |

**Prefixes:**

- `@path` attaches a file or folder. The file's contents go to the model, and the file counts
  as read, so it can be edited straight away. Type `@` for fuzzy file completion (`.gitignore`
  is respected).
- `!command` runs a shell command immediately, with no model call. Its output joins the
  conversation, so you can ask about it next.
- `#note` appends a note to project or personal memory.

**Custom commands** are Markdown files in `.vinax/commands/` (project) or `~/.vinax/commands/`
(personal). Subfolders become namespaces, so `git/review.md` becomes `/git:review`.

```markdown
---
description: Review the current diff
argument-hint: <focus>
allowed-tools: Bash(git diff:*), Read
model: groq:openai/gpt-oss-120b
---

Review this diff with a focus on $ARGUMENTS:
!`git diff --stat`

Our conventions: @docs/CONVENTIONS.md
```

The template supports:

- `$ARGUMENTS`, and `$1`…`$9` for individual arguments (quotes group words)
- `` !`cmd` `` to insert a command's output. This only runs if the command's `allowed-tools`
  permits it.
- `@file` to insert a file's contents
- `allowed-tools`, which also pre-approves those tools for that one turn

**Memory.** VinaX reads instructions from these files and sends them with every request, so keep
them short:

- `~/.vinax/VINAX.md` (personal)
- `VINAX.md` and `AGENTS.md` in each folder from the repository root down to the working folder
- `VINAX.md` and `AGENTS.md` in subfolders, when VinaX first works in them
- `@path/to/file.md` inside a memory file, which imports that file (up to four levels deep)

## Sessions and context

Every conversation is saved as JSON lines in `~/.vinax/projects/<folder>/sessions/`, with
checkpointed file contents stored once each. A short title is generated with the small model
after the first answer.

| Flag                | Meaning                                              |
| ------------------- | ---------------------------------------------------- |
| `-c, --continue`    | Continue the most recent conversation in this folder |
| `-r, --resume [id]` | Pick a conversation to resume (or pass its id)       |

Both work with `-p` too, and `--output-format json` reports the `session_id`.

**Compaction.** VinaX works within a conversation budget: `context.maxTokens`, 24K tokens by
default, capped by the model's own window. The status line shows how much is used. At 85%,
VinaX first removes old, long tool outputs, which costs nothing. If that isn't enough, it has the
small model summarize the conversation into Goal, Decisions, Files, Commands, Current state and
Next steps sections. `/compact [focus]` does this on demand; `context.autoCompact: false` turns
off the automatic version.

## Hooks, MCP and sub-agents

### Hooks

Hooks are shell commands that run at points in the agent loop. Configure them in any settings file
(lists from every layer are combined); `disableAllHooks: true` turns them all off. `/hooks` shows
what is active.

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash", "hooks": [{ "type": "command", "command": ".vinax/hooks/guard.sh" }] }
    ],
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [
          {
            "type": "command",
            "command": "npx prettier --write \"$(jq -r .tool_input.file_path)\""
          }
        ]
      }
    ],
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "git log --oneline -5" }] }]
  }
}
```

| Event              | When                                  | Can                                             |
| ------------------ | ------------------------------------- | ----------------------------------------------- |
| `PreToolUse`       | Before a tool runs (after validation) | block it, or approve it without a prompt        |
| `PostToolUse`      | After a tool runs                     | send feedback to the model                      |
| `UserPromptSubmit` | When you send a prompt                | block it, or add context                        |
| `Stop`             | When the agent is about to finish     | block and tell it to keep going (up to 3 times) |
| `SessionStart`     | Start, `-c`/`-r` resume and `/clear`  | add context (stdout)                            |

Each hook gets the event as JSON on stdin (`hook_event_name`, `session_id`, `cwd`, `tool_name`,
`tool_input`, `tool_response`, `prompt`…). Exit 0 continues; exit 2 blocks, and stderr is sent to
the model. Other exit codes are shown as warnings. A hook can also print JSON:
`{"decision": "block" | "approve", "reason": "…", "additionalContext": "…"}`. `matcher` is a tool
name, a `|`-separated list or a regular expression; leave it out to match everything. A hook's
approval never overrides a deny rule or VinaX's dangerous-command check.

### MCP servers

VinaX is an MCP client for stdio, streamable HTTP and SSE servers. Their tools appear as
`mcp__<server>__<tool>` and ask before running (allow them with rules like `mcp__github__*`).

```sh
vinax mcp add files -- npx -y @modelcontextprotocol/server-filesystem ~/notes
vinax mcp add docs https://example.com/mcp -H "Authorization: Bearer ${DOCS_TOKEN}"
vinax mcp add legacy https://example.com/sse --transport sse --scope project
vinax mcp list            # starts each server and reports its tools
vinax mcp remove files
```

Servers are saved in `~/.vinax/mcp.json` (`--scope user`, the default) or `.vinax/mcp.json`
(`--scope project`, meant to be committed) under `mcpServers`. `${VAR}` and `${VAR:-default}` are
expanded in commands, arguments, env, URLs and headers. **Project servers don't start until you
approve them** once per folder with `/mcp`, since they run programs that come with the repository.
`/mcp` also shows each server's status and retries failed ones.

### Sub-agents

The `Task` tool runs a sub-agent: a fresh conversation with the same permissions that works on one
job and reports back, which keeps long searches out of the main context. `general-purpose` is
built in. Add your own as Markdown in `.vinax/agents/` or `~/.vinax/agents/`:

```markdown
---
name: reviewer
description: Reviews code for bugs and missing tests
tools: Read, Grep, Glob
model: groq:openai/gpt-oss-20b
---

You are a careful code reviewer. Report problems with file paths and line numbers.
```

`tools` limits what it may use (`mcp__github__*` style wildcards work) and `model` picks its model;
both are optional. `/agents` lists them.

## Print mode

```sh
vinax -p "explain the difference between map and flatMap"
git diff | vinax -p "write a commit message for this diff"
vinax -p "fix the failing test" --allowedTools "Bash(npm test:*)" --permission-mode acceptEdits
vinax -p "summarize src/" --output-format stream-json --max-turns 10
```

| Flag                                      | Meaning                                                                 |
| ----------------------------------------- | ----------------------------------------------------------------------- |
| `-p, --print`                             | Run once without the UI. Piped stdin is added to the prompt as context. |
| `--output-format text\|json\|stream-json` | `json` prints one result object; `stream-json` prints NDJSON events.    |
| `--model <provider:model>`                | Try this model first, ahead of the configured chain.                    |
| `--permission-mode <mode>`                | `default`, `acceptEdits` or `plan`.                                     |
| `--allowedTools <rules>`                  | Allow without asking, e.g. `"Bash(npm test:*),Edit"`.                   |
| `--disallowedTools <rules>`               | Never allow, e.g. `"Bash(git push:*)"`.                                 |
| `--add-dir <path>`                        | Let tools work in another folder too (repeatable).                      |
| `--max-turns <n>`                         | Stop after this many model calls per prompt.                            |
| `--verbose`                               | Write a debug log of every request to `~/.vinax/logs/` (keys redacted). |
| `-v, --version`                           | Print the version.                                                      |

Print mode cannot ask for approval. An action that would need approval fails with a hint naming
the `--allowedTools` rule that would allow it, and the model carries on without it.

`stream-json` emits these events:

- `system` (init)
- `text`
- `tool_use`
- `tool_result`
- `notice` (`fallback`, `wait`, `retry`, `info`)
- a final `result`, with `subtype`, `is_error`, `result`, `model`, `usage`, `num_turns`,
  `tool_calls`, `fallbacks` and `duration_ms`

**Exit codes:** `0` success · `1` failure (no keys, bad settings, every model failed,
`--max-turns` reached) · `2` usage error · `130` interrupted with Ctrl+C.

## Models, rate limits and fallback

VinaX never hardcodes a model list. Default models live in settings, and each one is checked
against the provider's live `/models` catalog (cached for 24h in `~/.vinax/cache/`). Missing models
are skipped with a warning.

| Setting         | Default                                                                                                            |
| --------------- | ------------------------------------------------------------------------------------------------------------------ |
| `model`         | `groq:openai/gpt-oss-120b`                                                                                         |
| `smallModel`    | `groq:openai/gpt-oss-20b` (titles, summaries, compaction)                                                          |
| `fallbackChain` | `groq:qwen/qwen3.8-27b` → `openrouter:qwen/qwen3.8-27b:free` → `openrouter:nvidia/nemotron-3-super-120b-a12b:free` |

Before each request the router checks what the model has left: its local requests-per-minute
window, and the token and request budgets reported in the provider's rate-limit headers. Then it
does one of these:

- **Sends** the request if the budget allows it.
- **Waits** briefly (up to `router.maxWaitMs`, 20s by default) and shows a dim notice.
- **Falls back** to the next model in the chain and prints a one-line notice such as
  `↪ Groq 429: Rate limit reached … — switched to openrouter:qwen/qwen3.8-27b:free`.

Transient errors (5xx, timeouts, network) are retried with exponential backoff and jitter
before falling back. VinaX never switches models once output has started streaming.

**Free-tier reality:** Groq's free coding models allow about **8K tokens per minute**. OpenRouter's
`:free` models allow 20 requests per minute and **50 requests per day** (1,000 per day after a
one-time $10 credit purchase). Expect some requests to be served by the fallback chain.

## Settings

Settings are JSON and are merged from lowest to highest precedence:

1. `~/.vinax/settings.json` (user)
2. `.vinax/settings.json` (project, commit it)
3. `.vinax/settings.local.json` (personal; VinaX adds it to `.gitignore`)
4. Command-line flags

Permission rule lists (`permissions.allow`, `ask`, `deny`) accumulate across files; everything else
is overridden by later files. Unknown keys produce a warning; invalid values are rejected with the
exact key and reason.

```sh
vinax config list                                  # effective settings + file locations
vinax config get router.maxRetries
vinax config set model groq:openai/gpt-oss-20b     # --scope user|project|local (default user)
vinax config set fallbackChain '["openrouter:qwen/qwen3.8-27b:free"]' --scope project
vinax config unset model
```

Example `~/.vinax/settings.json`:

```json
{
  "model": "groq:openai/gpt-oss-120b",
  "fallbackChain": ["openrouter:qwen/qwen3.8-27b:free"],
  "providers": { "openrouter": { "rpm": 20 } },
  "router": { "maxRetries": 2, "maxWaitMs": 20000, "requestTimeoutMs": 90000 }
}
```

`theme` (`dark`, `light` or `colorblind`), `editorMode` (`normal` or `vim`) and `context`
(`maxTokens`, `autoCompact`) are settings too. `vinax doctor` runs the `/doctor` checks from your
shell. `VINAX_HOME` relocates `~/.vinax`.
`VINAX_SECRETS_BACKEND=file` skips the OS keychain. `NO_COLOR` turns off all colour, whatever the
theme.

## Development

```sh
pnpm install
pnpm test          # vitest: unit, Ink component and CLI integration tests (mock OpenAI server)
pnpm typecheck
pnpm lint
pnpm build         # bundles packages/cli/dist/vinax.js with tsup
pnpm vinax -p "hi" # run from source
```

| Package            | Purpose                                                                     |
| ------------------ | --------------------------------------------------------------------------- |
| `packages/core`    | UI-free: settings, secrets, providers, rate-limit ledger, router, debug log |
| `packages/cli`     | The `vinax` executable (bundles core)                                       |
| `packages/testkit` | Scriptable mock OpenAI-compatible server used by the tests                  |

## License

[MIT](LICENSE)
