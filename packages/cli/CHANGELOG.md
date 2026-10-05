# @sirimillavinay/vinax

## 0.5.0

### Minor Changes

- 9ab8061: Safer recovery and a review workflow. Rewind and per-file undo now notice files edited outside VinaX (including between turns), preview the differences, and ask before overwriting; every restore is backed up first and rolled back if a write fails. Files VinaX cannot read are no longer treated as missing. Session files are validated line by line: an interrupted last write is set aside instead of swallowing the next entry, damaged lines are reported with their numbers, and the session list is cached so it stays fast. Compaction keeps attached images, tool exchanges, your own requests and open tasks. Cancelling now stops hooks and everything they started at once.
  
  New in the interactive UI: a command palette (Ctrl+P), a changes view with diffs and per-file undo (Ctrl+G, `/changes`), a searchable transcript with full tool output (Ctrl+O), and a status line that shows whether VinaX is working, waiting for you, or stopped and why. Text is cut by its width on screen, and `TERM=dumb` is handled.
  
  New controls: per-task token and time budgets (`budget` settings, `--token-budget`, `--time-budget`), detection of tasks going in circles, reported and estimated tokens kept apart, costs shown only from explicit prices (`pricing` settings or the provider catalog), notes when a fallback model lacks tool calling or context, and opt-in isolated git worktrees (`--worktree`, `vinax worktree list|diff|apply|remove`). Print mode's JSON result adds `estimated_usage` and `cost`.

## 0.4.2

### Patch Changes

- 98298c9: Add interactive clarification questions with choices and custom answers. Fix cancelled plan prompts hanging, serialize interactive requests, and allow mode changes to resolve eligible pending permissions while preserving deny rules. Keep long streamed answers and tool activity from overwhelming the live terminal area.

## 0.4.1

### Patch Changes

- d3d638f: Fix standalone updates reporting success after downloading an older binary. Verify the downloaded executable's version before replacing the installed CLI, and build GitHub releases using the triggering commit's version with a binary version check before upload.

## 0.4.0

### Minor Changes

- ec46658: A Claude Code-style experience: modes, settings, effort, images, skills, copy, a real Snake II and a proper goodbye.
  
  - **Chat bar and modes:** a Claude-style prompt box and footer — `⏸ manual mode on`, `⏵⏵ accept edits on`, `⏸ plan mode on` and the new `⏵⏵ auto mode on` (Shift+Tab cycles). Auto mode runs edits, commands and web access inside the project without asking; deny rules, ask rules, dangerous commands, anything outside the project and MCP tools still ask.
  - **`/settings`** (also `/config`): an interactive panel for model, reasoning effort, default mode, theme, editor mode, auto-compact, update notifications and tips. **`/permissions`** is interactive too: add, remove and review rules, or change the mode.
  - **`/effort`** (auto, low, medium, high) for reasoning models such as gpt-oss, with a Claude-like thinking animation that shows the model's reasoning live and leaves "✻ Thought for Ns".
  - **Images:** drag a file in, paste a path, `@image.png` or press Ctrl+V to attach images. Turns with images go to a vision-capable model automatically (configurable with `visionModel`).
  - **Copy:** `/copy` copies the last answer (or `/copy N` its Nth code block); mouse selection keeps working.
  - **Editing:** Alt+D, Ctrl+Y, Ctrl+_ undo, Ctrl+L and more.
  - **`@` files** now lists files instantly, even in very large folders like your home directory.
  - **Skills:** `SKILL.md` folders in `.vinax/skills`, `.claude/skills` or `~/.vinax/skills`, loaded on demand; `/skills` lists them.
  - **Exit summary:** leaving prints the session id, the `vinax --resume` command, time, tokens, changed lines and models.
  - **Snake II:** the Nokia 3310 game with its menu, levels 1–9, mazes, wrap-around, bonus critters and per-level top scores.

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
