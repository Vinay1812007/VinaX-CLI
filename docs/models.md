# Models and rate limits

<p class="lead">Which models VinaX uses, how it stays within free-tier limits, and how fallback works.</p>

## Defaults

VinaX never hardcodes a model list. Defaults live in [settings](/settings). At startup each one is checked against the provider's live `/models` list, which is cached for 24 hours. Models that no longer exist are skipped with a warning.

| Setting         | Default                                                                                                            | Used for                                        |
| --------------- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------- |
| `model`         | `groq:openai/gpt-oss-120b`                                                                                         | The agent loop                                  |
| `smallModel`    | `groq:openai/gpt-oss-20b`                                                                                          | Titles, summaries, compaction, WebFetch answers |
| `fallbackChain` | `groq:qwen/qwen3.8-27b` → `openrouter:qwen/qwen3.8-27b:free` → `openrouter:nvidia/nemotron-3-super-120b-a12b:free` | When the main model is limited or failing       |

Models are written `provider:model-id`. Switch for one session with `/model` or `--model`, or permanently with `vinax config set model groq:openai/gpt-oss-20b`.

## How a request is routed

Before each request, VinaX checks what the model has left. That means its local requests-per-minute window, plus the token and request budgets from the provider's rate-limit headers. Then it does one of these:

- **Sends** the request, if the budget allows it.
- **Waits** briefly, up to `router.maxWaitMs` (20 s by default), with a dim notice.
- **Falls back** to the next model in the chain, with a one-line notice:

<pre class="vx-terminal"><span class="dim">↪ Groq 429: Rate limit reached … — switched to openrouter:qwen/qwen3.8-27b:free</span></pre>

Transient errors (5xx, timeouts, network) are retried with exponential backoff and jitter before falling back. VinaX never switches models once an answer has started streaming.

## Free-tier limits

| Provider                  | Limits (free tier)                                                                                      |
| ------------------------- | ------------------------------------------------------------------------------------------------------- |
| Groq                      | About 30 requests/min, plus a per-model tokens-per-minute budget (about 8K on the larger coding models) |
| OpenRouter `:free` models | 20 requests/min and **50 requests/day** per account; 1,000/day after a one-time $10 credit purchase     |

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
    "openrouter": { "enabled": true, "rpm": 20 }
  }
}
```
