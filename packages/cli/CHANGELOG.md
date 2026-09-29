# @sirimillavinay/vinax

## 0.3.0

### Minor Changes

- 43e2de6: New tricolor VinaX logo, update notices and a Snake game.
  
  - **New VinaX logo** on the welcome screen: striped saffron, white and green letters with a blue chakra in the "a". The brand assets, README logo, docs logo and favicon use it too.
  - **Update notices:** VinaX tells you when a newer release is out (checked at most once a day, off in CI or with `VINAX_NO_UPDATE_CHECK=1`), and shows what's new after you upgrade. New `/update` and `/changelog` commands.
  - **`/snake`:** Nokia-style Snake in colour, with speed levels, bonus critters and a saved best score.
  - **Fix:** an empty model list (e.g. from a gateway that did not serve NVIDIA yet) is no longer cached for a day, and `/login` reloads the provider's models at once, so NVIDIA models no longer stay "not in catalog" after you add a key.

## 0.2.1

### Patch Changes

- 9ce31b5: The model picker, `/models` and `/model` now say when your VinaX gateway does not serve a provider (for example NVIDIA on a gateway without `NVIDIA_API_KEY`) and how to add your own key, instead of "not in catalog".

## 0.2.0

### Minor Changes

- 956a802: NVIDIA models, a better model picker, clearer errors and a refreshed VinaX look.
  
  - **NVIDIA provider (nvidia.com):** use `openai/gpt-oss-20b` with `--model nvidia:openai/gpt-oss-20b` or the alias `NVD_CHAT_OSS_20_B`. Set `NVIDIA_API_KEY` (or `vinax config set-key nvidia`); the base URL is configurable with `providers.nvidia.baseUrl` for self-hosted NIM. NVIDIA joins routing and fallback like Groq and OpenRouter, and the VinaX gateway can serve it with `NVIDIA_API_KEY`.
  - **Model aliases** work everywhere a model is accepted: `--model`, settings, `/model`, custom commands and sub-agents. `nvidia.com:` is accepted as a provider name.
  - **Model picker:** `/model` is searchable (fuzzy, by model, alias or provider), grouped by provider, marks the current model and explains unavailable ones. The choice is remembered when you resume the session.
  - **New commands:** `/models` (providers, fallback order, aliases, switch), `/about`, `/health` and `vinax health`.
  - **Clearer failures:** failed turns show which provider and model failed, whether it was authentication, a missing key, a rate limit, a temporary outage, the network or an unavailable model, and what to try next. Print mode prints the same report.
  - **Agent progress:** the activity line shows the current phase (inspecting, planning, editing, running tests) with a trail, slow tools show their duration, denied actions look different from tool errors, and turns that used tools end with a short "Done" summary.
  - **Git-aware context:** branch, upstream, staged/unstaged/untracked counts and recent commits are given to the model, with guidance for reviewing, committing and explaining changes.
  - **Sessions and memory:** a searchable resume picker grouped by day with age, prompts and model; the welcome screen lists the memory files in use.
  - **Branding:** a new VX mark in the terminal (works in narrow terminals, light themes and `NO_COLOR`), SVG brand assets in `brand/`, and a new docs logo and favicon.
  - Faster startup with several providers: model catalogs are fetched in parallel, as are `/health` and `vinax doctor` key checks.

## 0.1.0

### Minor Changes

- 15cd44d: M1 core: settings and secrets, Groq/OpenRouter providers, rate-limit-aware router with fallback, and headless `vinax -p`.
- d8a4241: M2 terminal UI: interactive Ink app with onboarding, folder trust, multi-line input with history and search, streaming Markdown, activity indicator, status line and themes.
- 5df4161: M3 agent: file, search and shell tools; native and text-protocol tool calling; permission rules, modes and approval prompts with diffs; plan mode; checkpoints and rewind; live task list.
- e8304bc: M4 workflow: slash and custom commands, @ file mentions, ! shell and # memory prefixes, VINAX.md memory, saved sessions with -c/-r, auto and manual compaction, /status /usage /doctor, vim mode.
- 77b65d5: M5 extensibility: hooks, MCP client with `vinax mcp` and /mcp, sub-agents via the Task tool and /agents, WebFetch.
- edac484: M6 ship: optional VinaX gateway (vinax login --gateway, waking notice), vinax login/logout, vinax update, standalone binaries and install scripts.
