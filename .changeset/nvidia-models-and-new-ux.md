---
'@sirimillavinay/vinax': minor
---

NVIDIA models, a better model picker, clearer errors and a refreshed VinaX look.

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
