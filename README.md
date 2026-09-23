# VinaX CLI

VinaX (`vinax`) is an open-source agentic coding assistant for the terminal, powered by free-tier
models from **Groq** and **OpenRouter**.

> **Status: milestone M1 (core).** Headless print mode, provider routing with fallback, settings
> and key storage work today. The interactive terminal UI arrives in M2, and tools/agent loop in
> M3. See [docs/PLAN.md](docs/PLAN.md) for the roadmap.

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

## Print mode

```sh
vinax -p "explain the difference between map and flatMap"
git diff | vinax -p "write a commit message for this diff"
vinax -p "summarize" --output-format json < notes.md
vinax -p "hi" --model openrouter:qwen/qwen3.8-27b:free
```

| Flag                                      | Meaning                                                                 |
| ----------------------------------------- | ----------------------------------------------------------------------- |
| `-p, --print`                             | Answer once and exit. Piped stdin is added to the prompt as context.    |
| `--output-format text\|json\|stream-json` | `json` prints one result object; `stream-json` prints NDJSON events.    |
| `--model <provider:model>`                | Try this model first, ahead of the configured chain.                    |
| `--verbose`                               | Write a debug log of every request to `~/.vinax/logs/` (keys redacted). |
| `-v, --version`                           | Print the version.                                                      |

`stream-json` emits `system` (init), `text`, `notice` (`fallback`, `wait`, `retry`) and a final
`result` event. The `result` object has `subtype`, `is_error`, `result`, `model`, `usage`,
`fallbacks` and `duration_ms`.

**Exit codes:** `0` success · `1` runtime failure (no keys, bad settings, every model failed) ·
`2` usage error · `130` interrupted with Ctrl+C.

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

`VINAX_HOME` relocates `~/.vinax`. `VINAX_SECRETS_BACKEND=file` skips the OS keychain.
`NO_COLOR` disables colour.

## Development

```sh
pnpm install
pnpm test          # vitest: unit tests + CLI integration tests against a mock OpenAI server
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
