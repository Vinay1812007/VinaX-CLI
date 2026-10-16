# Models and rate limits

## Auto selection

Use `/model auto`, or choose **Auto** in `/model`, to select an available model from configured providers. Defaults and fallbacks are tried first, then free models from the live provider catalogs, then paid ones. The free-first preference is global, so a free model at one provider outranks a paid model at another. Provider billing still applies to anything the catalog does not report as free. Permission mode is independent and does not change when you select a model.

The picker includes free and paid chat models. Gemini and Mistral billing depends on the account tier; paid API use requires provider credits. Unknown context sizes do not hide models. Non-chat endpoints such as embeddings, audio and image generation are excluded. OpenAI models requiring the Responses API (including Codex and deep research) are excluded from this Chat Completions client.

Claude uses the native [Messages streaming API](https://platform.claude.com/docs/en/build-with-claude/streaming) and [live model discovery](https://platform.claude.com/docs/en/api/models/list). Other direct providers use their OpenAI-compatible chat endpoints. Gateway login remains available through `vinax login --gateway` for existing deployments; it is no longer in the interactive provider menu.

<p class="lead">Which models VinaX uses, how it stays within free-tier limits, and how fallback works.</p>

## Defaults

VinaX never hardcodes a model list. Defaults live in [settings](/settings). At startup each one is checked against the provider's live `/models` list, which is cached for 24 hours. Models that no longer exist are skipped with a warning.

| Setting         | Default                                                                                                                                          | Used for                                           |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------- |
| `model`         | `groq:openai/gpt-oss-120b`                                                                                                                       | The agent loop                                     |
| `smallModel`    | `groq:openai/gpt-oss-20b`                                                                                                                        | Titles, summaries, compaction, WebFetch answers    |
| `planModel`     | unset (the main model)                                                                                                                           | Plan mode, where reasoning matters more than speed |
| `fallbackChain` | `groq:qwen/qwen3.8-27b` → `openrouter:qwen/qwen3.8-27b:free` → `openrouter:nvidia/nemotron-3-super-120b-a12b:free` → `nvidia:openai/gpt-oss-20b` | When the main model is limited or failing          |

Models are written `provider:model-id`, with a provider from the table below. Switch for one session with `/model` or `--model`, or permanently with `vinax config set model groq:openai/gpt-oss-20b`.

A model whose provider has no key is skipped. So the last fallback, `nvidia:openai/gpt-oss-20b`, only comes into play once you add an NVIDIA key.

## Providers

| Provider          | Name in refs  | Key variable          | Default API                                               |
| ----------------- | ------------- | --------------------- | --------------------------------------------------------- |
| Groq              | `groq`        | `GROQ_API_KEY`        | `https://api.groq.com/openai/v1`                          |
| OpenRouter        | `openrouter`  | `OPENROUTER_API_KEY`  | `https://openrouter.ai/api/v1`                            |
| NVIDIA            | `nvidia`      | `NVIDIA_API_KEY`      | `https://integrate.api.nvidia.com/v1`                     |
| Gemini            | `gemini`      | `GEMINI_API_KEY`      | `https://generativelanguage.googleapis.com/v1beta/openai` |
| OpenAI            | `openai`      | `OPENAI_API_KEY`      | `https://api.openai.com/v1`                               |
| Claude            | `claude`      | `ANTHROPIC_API_KEY`   | `https://api.anthropic.com/v1`                            |
| DeepSeek          | `deepseek`    | `DEEPSEEK_API_KEY`    | `https://api.deepseek.com`                                |
| Mistral           | `mistral`     | `MISTRAL_API_KEY`     | `https://api.mistral.ai/v1`                               |
| Cerebras          | `cerebras`    | `CEREBRAS_API_KEY`    | `https://api.cerebras.ai/v1`                              |
| Z.AI (GLM)        | `zai`         | `ZAI_API_KEY`         | `https://api.z.ai/api/paas/v4`                            |
| ModelScope        | `modelscope`  | `MODELSCOPE_API_KEY`  | `https://api-inference.modelscope.cn/v1`                  |
| SiliconFlow       | `siliconflow` | `SILICONFLOW_API_KEY` | `https://api.siliconflow.com/v1`                          |
| Ollama Cloud      | `ollama`      | `OLLAMA_API_KEY`      | `https://ollama.com/v1`                                   |
| Kilo AI Gateway   | `kilo`        | `KILO_API_KEY`        | `https://api.kilo.ai/api/gateway`                         |
| Hetzner Inference | `hetzner`     | `HETZNER_API_KEY`     | `https://inference.hetzner.com/api/v1`                    |

The provider's domain works as well as its name: `nvidia.com:openai/gpt-oss-20b` is the same as `nvidia:openai/gpt-oss-20b`.

`/login` opens the provider's API-key page in your browser before asking for the key.

Some providers expose more than one base URL. Z.AI's coding plan (`/api/coding/paas/v4`) and Anthropic-format endpoint (`/api/anthropic`) take the same key but reject each other's traffic; SiliconFlow's China endpoint is `api.siliconflow.cn`; ModelScope requires a bound Alibaba Cloud account. Point `providers.<name>.baseUrl` at the one you need — `providers.ollama.baseUrl: "http://localhost:11434/v1"` uses a local Ollama server instead of the cloud.

## Free and paid models

By default VinaX lists only models you can use without paying: anything a catalog reports as free, plus providers with a free tier whose catalogs publish no price. Models with a published non-zero price, and the pay-per-request APIs (OpenAI, Claude, DeepSeek), are hidden.

The model in use is always listed even when it is paid, and `/model <provider:model>` still accepts any model by name. To list everything:

```json
{ "freeModelsOnly": false }
```

If filtering would leave no usable model at all — say your only key is for a paid API — VinaX shows the full list instead of an empty picker.

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
- **Key check.** NVIDIA's `/models` list is public, so VinaX checks a key with one-token completions sent to a few models at once (`openai/gpt-oss-20b`, `meta/llama-3.2-11b-vision-instruct` and some catalog models); any answer proves the key, so one hung model no longer fails the check. The check gives up after 15 seconds instead of waiting the full request timeout.
- **Context window.** NVIDIA's catalog lists model ids only. VinaX knows the context window of the models it has aliases for (128K, 131,072 tokens, for `openai/gpt-oss-20b`).
- **Picker.** NVIDIA's catalog also contains embedding, retired and unresponsive models, so the picker lists only the ones that answered a [model test](#model-tests). Any other catalog model still works with `/model nvidia:<model-id>` or `--model`.
- **Base URL.** Point VinaX at a self-hosted NVIDIA NIM (or any OpenAI-compatible endpoint) with `providers.nvidia.baseUrl`. VinaX never caps NVIDIA usage locally; see [NVIDIA rate limits](#nvidia-rate-limits). Use `providers.nvidia.enabled: false` to turn the provider off.

```json
{
  "model": "NVD_CHAT_OSS_20_B",
  "providers": { "nvidia": { "baseUrl": "http://nim.internal:8000/v1" } }
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

## Reasoning effort

Reasoning models such as gpt-oss can think more or less before answering. `/effort` sets that for your session and saves it as `reasoningEffort` (also in [`/settings`](/settings#settings-panel)):

| Effort   | Meter | Meaning                                  |
| -------- | ----- | ---------------------------------------- |
| `auto`   | `▱▱▱` | The model's own default; nothing is sent |
| `low`    | `▰▱▱` | Fastest answers, least thinking          |
| `medium` | `▰▰▱` | Balanced                                 |
| `high`   | `▰▰▰` | Most thorough reasoning, slower          |

VinaX sends the effort only when you set one: as `reasoning_effort` to Groq and NVIDIA, and as `reasoning.effort` to OpenRouter. Models without reasoning ignore it. If a provider rejects the parameter, VinaX sends the same request again without it and stops sending it to that model. The footer shows the effort (`◔ low`, `◑ medium`, `● high`), and the model's streamed reasoning appears under the spinner while it thinks.

## Vision models

gpt-oss and most other defaults are text-only. When a prompt carries [images](/interactive-mode#images) and the current model can't see them, that turn goes to a vision model instead, and a notice says which one. VinaX builds a list of vision models, best first:

1. the `visionModel` setting, if set (a model ref or alias)
2. vision models already in your `model`/`fallbackChain`
3. vision models VinaX knows on a provider you use: NVIDIA's `meta/llama-3.2-11b-vision-instruct`, then `meta/llama-3.2-90b-vision-instruct`
4. models a provider's catalog marks as taking images (OpenRouter's `input_modalities`), free ones first

Providers you reach with your own key come before ones behind a [gateway](/gateway), because image requests are large. If the first model fails, the turn falls back through the other vision models, not your text-only chain. A model that does not answer in time is skipped at once when another model is next, instead of being retried.

NVIDIA's Llama 3.2 Vision models reject requests that carry both images and tool definitions, so VinaX talks to them with its text tool protocol; any other model that fails the same way is switched automatically.

Text-only models later in the conversation get a short note that an image was attached, not the image itself.

```json
{ "visionModel": "nvidia:meta/llama-3.2-11b-vision-instruct" }
```

If you use a VinaX gateway for images, give it room for them: `MAX_BODY_BYTES` defaults to 8 MB.

## Model tests

Catalogs list far more than actually answers — NVIDIA's has about 80 entries, many of them embeddings, retired or hanging. So before `/model` and `/models` show a provider's list, VinaX sends each of its free chat models (plus the models it knows by alias) a tiny request ("Reply with OK", 16 tokens), six at a time with 20 seconds each, and lists only the ones that answered. The current model stays listed even when it did not answer, marked `did not answer the last test`.

- **When.** Right after `/login` for that provider, and when `/model` or `/models` finds models without a recent result (a line shows `Testing 31 free NVIDIA models… 7/31`; Esc stops it and keeps what finished). Afterwards a notice sums it up: `12 of 31 free NVIDIA models answered.`
- **Kept for.** Answers count for 24 hours, failures for 6 hours and rate-limited tests for 10 minutes, in `~/.vinax/cache/probe-<provider>.json`. A new key for a provider throws its results away. `/models test` tests every model again right now.
- **Routing.** A configured model that failed its test is skipped in fallback and auto routing, with a warning at startup — unless you chose it yourself with `--model` or `/model`. If every model failed, nothing is skipped, since that usually means the network was down.
- **After /login.** If the model you use belongs to that provider and did not answer, the session switches to one that did and says so. `vinax login <provider>` prints the same summary and suggests `vinax config set model …`.
- **Paid models.** With `freeModelsOnly: false`, paid models are tested and listed too (each test is a few tokens).

A run where nothing answered because of timeouts or connection errors, or where the provider rejected the key for every model, is not remembered; the full list is shown instead.

## Browsing and switching models

- **`/model`** opens a searchable picker. Type to filter: every word must match the model id, its alias, or the provider's name or domain (`nvd`, `nvidia oss`, `groq 120b`). Models are grouped by provider (`NVIDIA · nvidia.com`), `●` marks the current one, `vision` marks models that take images, and models you can't use yet are dimmed with the reason (`no key · /login`, `not in catalog`, or `add your own key with /login` when your gateway doesn't serve that provider). Models VinaX knows but the provider no longer lists are hidden unless they have an alias. ↑/↓ move, Enter picks, Backspace edits the search, Ctrl+U clears it and Esc cancels.
- **`/model <ref or alias>`** switches straight away, for example `/model NVD_CHAT_OSS_20_B`. It warns when there is no key for that provider yet.
- **`/models`** shows each provider (configured, through the gateway, or not configured, with the size of its catalog), the current model and its alias, how many of its models answered the last test, the fallback order with each entry's status (`ready`, `no key`, `skipped: not in catalog`, `skipped: did not answer the last test`), and the aliases. It then opens the picker so you can switch; Esc keeps the current model.
- **`/models test`** (or `/models refresh`) tests every model of every configured provider again, ignoring earlier results, then shows the same panel.

To make a choice the default, run `vinax config set model <ref or alias>`.

## How a request is routed

Before each request, VinaX checks what the provider's rate-limit headers say the model has left. VinaX sets no limits of its own. Then it does one of these:

- **Sends** the request, if the provider's limits allow it.
- **Waits** briefly, up to `router.maxWaitMs` (20 s by default), with a dim notice.
- **Falls back** to the next model in the chain, with a one-line notice:

<pre class="vx-terminal"><span class="dim">↪ Groq 429: Rate limit reached … — switched to openrouter:qwen/qwen3.8-27b:free</span></pre>

Transient errors (5xx, timeouts, network) are retried with exponential backoff and jitter before falling back. VinaX never switches models once an answer has started streaming.

A model that sends nothing at all — no text, reasoning or tool call — for `router.firstTokenTimeoutMs` (45 s by default) counts as timed out, so a hung endpoint falls back long before the full `requestTimeoutMs`. Time spent waking a [gateway](/gateway) does not count.

When a model times out, is unavailable, or is missing, the session stays on the model it fell back to: the failed one is moved to the end of the chain for 10 minutes, the notice says so, and the status line shows the model actually answering:

<pre class="vx-terminal"><span class="dim">↪ NVIDIA did not respond in time — switched to groq:openai/gpt-oss-120b (nvidia:openai/gpt-oss-20b is skipped for the next 10 min)</span></pre>

Choosing the model again with `/model` tries it straight away.

When every model fails, VinaX explains why in an error card: each model it tried, with its provider, the kind of failure (authentication failed, no API key, rate limited, temporary provider error, network error, model not available, request too large, tool-call error, request rejected) and the provider's message, plus what to try next (retry, switch with `/model`, add a key with `/login`, run `/health`, `/compact`).

### NVIDIA rate limits

VinaX never caps, skips or budgets NVIDIA locally. NVIDIA's free endpoints limit requests per minute on their side (about 40). When NVIDIA answers 429, VinaX waits on the same model, as long as `Retry-After` says or otherwise with exponential backoff up to 30 s, and retries until it answers. It does not fall back to another model or set NVIDIA aside, and the waits do not use up `router.maxRetries`. The status line shows the wait:

<pre class="vx-terminal"><span class="dim">↻ waiting for the NVIDIA rate limit — retrying in 4.0s</span></pre>

Press `Esc` to stop waiting.

## Free-tier limits

| Provider                  | Limits (free tier)                                                                                      |
| ------------------------- | ------------------------------------------------------------------------------------------------------- |
| Groq                      | About 30 requests/min, plus a per-model tokens-per-minute budget (about 8K on the larger coding models) |
| OpenRouter `:free` models | 20 requests/min and **50 requests/day** per account; 1,000/day after a one-time $10 credit purchase     |
| NVIDIA                    | Set by NVIDIA (about 40 requests/min); VinaX waits out 429s on the same model                           |

Each agent step is one request, and a long conversation can use most of a minute's tokens. So expect some turns to be served by the fallback chain. `/status` shows the remaining limits the providers report.

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
    "requestTimeoutMs": 90000,
    "firstTokenTimeoutMs": 45000
  },
  "providers": {
    "groq": { "enabled": true },
    "openrouter": { "enabled": true },
    "nvidia": { "enabled": true }
  }
}
```
