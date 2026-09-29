# Models and rate limits

<p class="lead">Which models VinaX uses, how it stays within free-tier limits, and how fallback works.</p>

## Defaults

VinaX never hardcodes a model list. Defaults live in [settings](/settings). At startup each one is checked against the provider's live `/models` list, which is cached for 24 hours. Models that no longer exist are skipped with a warning.

| Setting         | Default                                                                                                                                          | Used for                                        |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------- |
| `model`         | `groq:openai/gpt-oss-120b`                                                                                                                       | The agent loop                                  |
| `smallModel`    | `groq:openai/gpt-oss-20b`                                                                                                                        | Titles, summaries, compaction, WebFetch answers |
| `fallbackChain` | `groq:qwen/qwen3.8-27b` → `openrouter:qwen/qwen3.8-27b:free` → `openrouter:nvidia/nemotron-3-super-120b-a12b:free` → `nvidia:openai/gpt-oss-20b` | When the main model is limited or failing       |

Models are written `provider:model-id`, where the provider is `groq`, `openrouter` or `nvidia`. Switch for one session with `/model` or `--model`, or permanently with `vinax config set model groq:openai/gpt-oss-20b`.

A model whose provider has no key is skipped. So the last fallback, `nvidia:openai/gpt-oss-20b`, only comes into play once you add an NVIDIA key.

## Providers

| Provider   | Name in refs | Key variable         | Default API                           |
| ---------- | ------------ | -------------------- | ------------------------------------- |
| Groq       | `groq`       | `GROQ_API_KEY`       | `https://api.groq.com/openai/v1`      |
| OpenRouter | `openrouter` | `OPENROUTER_API_KEY` | `https://openrouter.ai/api/v1`        |
| NVIDIA     | `nvidia`     | `NVIDIA_API_KEY`     | `https://integrate.api.nvidia.com/v1` |

The provider's domain works as well as its name: `nvidia.com:openai/gpt-oss-20b` is the same as `nvidia:openai/gpt-oss-20b`.

## NVIDIA

VinaX supports NVIDIA's hosted API ([build.nvidia.com](https://build.nvidia.com)) as a first-class provider. It takes part in routing and fallback exactly like Groq and OpenRouter.

| Provider              | Model                | Alias               |
| --------------------- | -------------------- | ------------------- |
| NVIDIA (`nvidia.com`) | `openai/gpt-oss-20b` | `NVD_CHAT_OSS_20_B` |

```bash
export NVIDIA_API_KEY=nvapi-...          # or: vinax login nvidia / vinax config set-key nvidia
vinax --model nvidia:openai/gpt-oss-20b
vinax --model NVD_CHAT_OSS_20_B          # the same model, by its alias
```

- **Keys** are stored like every other provider key: the `NVIDIA_API_KEY` environment variable, the OS keychain, or `~/.vinax/credentials.json` (mode 0600). They never go in settings files; an `apiKey` there is ignored with a warning.
- **Key check.** NVIDIA's `/models` list is public, so VinaX checks a key with a one-token completion against `openai/gpt-oss-20b` before saving it.
- **Context window.** NVIDIA's catalog lists model ids only. VinaX knows the context window of the models it has aliases for (128K, 131,072 tokens, for `openai/gpt-oss-20b`).
- **Picker.** NVIDIA's catalog also contains embedding, vision and safety models, so the model picker shows the NVIDIA models VinaX knows. Any other catalog model still works with `/model nvidia:<model-id>` or `--model`.
- **Base URL.** Point VinaX at a self-hosted NVIDIA NIM (or any OpenAI-compatible endpoint) with `providers.nvidia.baseUrl`. `providers.nvidia.rpm` (default 40) sets the local requests-per-minute limit, and `providers.nvidia.enabled: false` turns the provider off.

```json
{
  "model": "NVD_CHAT_OSS_20_B",
  "providers": { "nvidia": { "baseUrl": "http://nim.internal:8000/v1", "rpm": 40 } }
}
```

## Aliases

An alias is a short name for a model ref. Aliases are case-insensitive and work anywhere a model ref does: `--model`, the `model`, `smallModel` and `fallbackChain` settings, `/model`, and the `model` frontmatter of [custom commands](/commands#custom-commands) and [sub-agents](/sub-agents). Settings store them as written; VinaX uses the full ref.

| Alias               | Model                       |
| ------------------- | --------------------------- |
| `NVD_CHAT_OSS_20_B` | `nvidia:openai/gpt-oss-20b` |

`/models` lists the aliases too.

## How the model is chosen

1. `--model` on the command line, if given.
2. The model you picked with `/model` in this session. It is saved with the session and comes back when you resume it (unless you pass `--model`).
3. The `model` setting.

The chosen model heads the chain, followed by `fallbackChain`. The router then retries or falls back as described below.

## Browsing and switching models

- **`/model`** opens a searchable picker. Type to filter: every word must match the model id, its alias, or the provider's name or domain (`nvd`, `nvidia oss`, `groq 120b`). Models are grouped by provider (`NVIDIA · nvidia.com`), `●` marks the current one, and models you can't use yet are dimmed with the reason (`no key · /login`, `not in catalog`). ↑/↓ move, Enter picks, Backspace edits the search, Ctrl+U clears it and Esc cancels.
- **`/model <ref or alias>`** switches straight away, for example `/model NVD_CHAT_OSS_20_B`. It warns when there is no key for that provider yet.
- **`/models`** shows each provider (configured, through the gateway, or not configured, with the size of its catalog), the current model and its alias, the fallback order with each entry's status (`ready`, `no key`, `skipped: not in catalog`), and the aliases. It then opens the picker so you can switch; Esc keeps the current model.

To make a choice the default, run `vinax config set model <ref or alias>`.

## How a request is routed

Before each request, VinaX checks what the model has left. That means its local requests-per-minute window, plus the token and request budgets from the provider's rate-limit headers. Then it does one of these:

- **Sends** the request, if the budget allows it.
- **Waits** briefly, up to `router.maxWaitMs` (20 s by default), with a dim notice.
- **Falls back** to the next model in the chain, with a one-line notice:

<pre class="vx-terminal"><span class="dim">↪ Groq 429: Rate limit reached … — switched to openrouter:qwen/qwen3.8-27b:free</span></pre>

Transient errors (5xx, timeouts, network) are retried with exponential backoff and jitter before falling back. VinaX never switches models once an answer has started streaming.

When every model fails, VinaX explains why in an error card: each model it tried, with its provider, the kind of failure (authentication failed, no API key, rate limited, temporary provider error, network error, model not available, request too large, tool-call error, request rejected) and the provider's message, plus what to try next (retry, switch with `/model`, add a key with `/login`, run `/health`, `/compact`).

## Free-tier limits

| Provider                  | Limits (free tier)                                                                                      |
| ------------------------- | ------------------------------------------------------------------------------------------------------- |
| Groq                      | About 30 requests/min, plus a per-model tokens-per-minute budget (about 8K on the larger coding models) |
| OpenRouter `:free` models | 20 requests/min and **50 requests/day** per account; 1,000/day after a one-time $10 credit purchase     |
| NVIDIA                    | Set by your NVIDIA account. VinaX allows 40 requests/min locally (`providers.nvidia.rpm`)               |

Each agent step is one request, and a long conversation can use most of a minute's tokens. So expect some turns to be served by the fallback chain. `/status` shows the remaining limits and your OpenRouter quota, and `/usage` shows today's totals.

## Tool calling on free models

VinaX uses native function calling first. It switches a model to its text protocol, where tool calls are written as `<vx:call>` blocks in the reply, in three cases:

- the model list says the model doesn't support tools
- the provider rejects its tool call (for example Groq's `tool_use_failed`)
- the model sends two malformed calls

Every argument is validated, and validation errors go back to the model so it can correct itself.

## Router settings

```json
{
  "router": {
    "maxRetries": 2,
    "baseDelayMs": 1000,
    "maxDelayMs": 20000,
    "maxWaitMs": 20000,
    "requestTimeoutMs": 90000
  },
  "providers": {
    "groq": { "rpm": 30 },
    "openrouter": { "enabled": true, "rpm": 20 },
    "nvidia": { "enabled": true, "rpm": 40 }
  }
}
```
