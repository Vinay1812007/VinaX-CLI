# The VinaX gateway

The gateway (`apps/gateway`) is an optional relay for model requests. It keeps shared Groq and
OpenRouter keys on a server, so people you give a token to can use VinaX without keys of their own.

- **It only relays chat completions.** The agent loop, tools, files and shell commands all stay on
  each user's machine.
- **It is opt-in.** VinaX talks to Groq and OpenRouter directly with your own keys
  unless you run `vinax login --gateway`. Even then, a provider you have a key for keeps using it.
- **It is stateless.** There is no database. Tokens are stored as hashes in an environment variable,
  and rate-limit counters live in memory.

> **Quota warning.** Everyone behind one gateway shares its free-tier limits: about 30 requests a
> minute and a per-model token budget on Groq, and 50 `:free` requests a day on OpenRouter (1,000
> after a one-time $10 credit purchase). A gateway suits a small group, not the public.

## Deploy to Render (free)

1. **Create tokens.** Each person gets their own token; only its hash goes on the server.

   ```sh
   pnpm install
   pnpm gateway:token alice      # prints a token for alice, and the entry to add to the server
   pnpm gateway:token bob
   ```

2. **Create the service.** In the [Render dashboard](https://dashboard.render.com), choose
   **New → Blueprint**, pick your fork of this repository and confirm. Render reads
   [`render.yaml`](../render.yaml) and creates a free web service named `vinax-gateway`.

3. **Fill in the secrets** when Render asks for them (or later under **Environment**):

   | Variable             | Value                                                    |
   | -------------------- | -------------------------------------------------------- |
   | `GROQ_API_KEY`       | a Groq key (at least one provider key is required)       |
   | `OPENROUTER_API_KEY` | an OpenRouter key                                        |
   | `VINAX_TOKEN_HASHES` | the `name:hash` entries from step 1, separated by commas |

4. **Deploy on every green `main` (optional).** The blueprint turns Render's own auto-deploy off.
   Deploys come from GitHub instead, once CI has passed. Copy the service's **Deploy Hook** URL
   (Settings → Deploy Hook) into a GitHub repository secret named `RENDER_DEPLOY_HOOK_URL`.
   [`deploy-gateway.yml`](../.github/workflows/deploy-gateway.yml) calls it after CI passes on
   `main`. Without the secret, deploy manually from the dashboard.

5. **Check it.** Open `https://<your-service>.onrender.com/health`. Then share the URL and each
   person's token:

   ```sh
   vinax login --gateway https://<your-service>.onrender.com
   ```

### Sleeping and waking

Render's free services sleep after 15 minutes without traffic and take about a minute to start
again. Free services also get 750 instance-hours a month. VinaX handles the sleep:

- At startup it checks `/health` for 2.5 s. If the gateway is asleep, VinaX says
  "Waking VinaX gateway…" and starts it in the background.
- A request that finds the gateway asleep shows the same message in the activity line. It then
  waits up to `gateway.timeoutMs` (120 s by default) and never fails silently. If the gateway
  doesn't answer in time, the request moves on to the next model in the fallback chain.

## Configuration

| Variable                               | Default                                                     | Meaning                                                  |
| -------------------------------------- | ----------------------------------------------------------- | -------------------------------------------------------- |
| `GROQ_API_KEY`                         | —                                                           | Groq key used for `groq:` models                         |
| `OPENROUTER_API_KEY`                   | —                                                           | OpenRouter key used for `openrouter:` models             |
| `VINAX_TOKEN_HASHES`                   | —                                                           | `name:sha256` entries, comma or newline separated        |
| `RATE_LIMIT_RPM`                       | `20`                                                        | requests per minute per token                            |
| `RATE_LIMIT_RPD`                       | `500`                                                       | requests per UTC day per token                           |
| `MAX_BODY_BYTES`                       | `1000000`                                                   | largest accepted request body                            |
| `DEFAULT_MODELS`                       | `groq:openai/gpt-oss-120b,openrouter:qwen/qwen3.8-27b:free` | tried in order for `"model": "auto"`                     |
| `UPSTREAM_TIMEOUT_MS`                  | `60000`                                                     | wait for a provider to start answering                   |
| `PORT`                                 | `8787` (Render sets its own)                                | listen port                                              |
| `GROQ_BASE_URL`, `OPENROUTER_BASE_URL` | the providers' public APIs                                  | point a provider elsewhere (a proxy, or a mock in tests) |

To revoke a token, remove its entry from `VINAX_TOKEN_HASHES`. The service restarts with the new
list.

## API

The gateway speaks the OpenAI chat-completions API. Model names carry their provider:
`groq:openai/gpt-oss-120b` or `openrouter:qwen/qwen3.8-27b:free`.

| Endpoint                    | Auth   | Notes                                                                                |
| --------------------------- | ------ | ------------------------------------------------------------------------------------ |
| `GET /health`               | none   | `{ status, service, version, providers }`                                            |
| `GET /v1/models`            | bearer | both providers' model lists, IDs prefixed with the provider; cached 10 min           |
| `POST /v1/chat/completions` | bearer | streams (SSE) or returns JSON unchanged, including `x-ratelimit-*` and `retry-after` |

**Fallback on the gateway.** With `"model": "auto"`, or an extra `"models": [...]` list, the gateway
tries each model in turn until one starts answering. It moves on for rate limits, provider
outages and its own key being rejected. It never switches once a response has started. The
`x-vinax-model` response header says which model answered. VinaX itself sends a single model and
does its own fallback, because its router tracks each model's rate limits.

**Errors** use the OpenAI shape `{ "error": { "message", "type" } }`:

- `401` means the token is missing or unknown.
- `413` means the body is too large.
- `429` comes from the per-token limit (with `retry-after`) or from a rate-limited provider.
- `502` means no model could answer. A provider rejecting the _gateway's_ key also shows as 502, so
  clients never mistake it for their own token failing.

## Security

- **Tokens:** only SHA-256 hashes of tokens are stored. A token is shown once, when it is created.
- **Logging:** the gateway logs one line per request: time, method, path, status, duration, the
  token's _name_ and the model that answered. Request and response bodies are never logged.
- **Browsers:** there are no CORS headers, so browsers can't call the gateway from web pages.
- **Keys:** provider keys come only from environment variables. Never commit them.
- **HTTPS:** VinaX only accepts `https://` gateway URLs, except for `localhost`.

## Run it locally

```sh
GROQ_API_KEY=gsk_... VINAX_TOKEN_HASHES="me:$(printf %s "$TOKEN" | shasum -a 256 | cut -d' ' -f1)" \
  pnpm gateway:dev
vinax login --gateway http://localhost:8787
```
