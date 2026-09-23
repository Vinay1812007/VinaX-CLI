# VinaX CLI

VinaX (`vinax`) is an open-source agentic coding assistant for the terminal, powered by free-tier
models from **Groq** and **OpenRouter**.

> **Status: milestone M3 (agent).** VinaX reads, searches and edits your code, runs commands, and
> asks before anything risky. It works in the interactive UI and in headless `-p` mode, on Groq
> and OpenRouter free tiers with automatic fallback. Slash commands, `@` files, project memory
> and saved sessions arrive in M4. See [docs/PLAN.md](docs/PLAN.md) for the roadmap.

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

`theme` (`dark`, `light` or `colorblind`) is a setting too. `VINAX_HOME` relocates `~/.vinax`.
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
