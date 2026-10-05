# Troubleshooting

Start with `vinax health` (or `/health` inside VinaX) for a one-line-per-check summary, or
`vinax doctor` (`/doctor`) for full details. They check your install, settings, keys, models,
search, shell, git, key storage, terminal, gateway and MCP servers, and exit with code 1 if
something is broken. `○` marks something optional you haven't set up, such as a provider you don't use.

When a request fails, VinaX shows what failed and why (authentication, missing key, rate limit,
temporary provider error, network, model not available) with suggested next steps.
`vinax --verbose` writes a debug log of every request to `~/.vinax/logs/`, with keys redacted.

### "Rate limited" and fallback notices

Groq's free tier allows about 30 requests a minute, and each model has its own tokens-per-minute
budget. One agent step is one request, and a long conversation can use most of a minute's tokens.
When a wait would take longer than `router.maxWaitMs` (20 s), VinaX moves to the next model in
`fallbackChain` and shows a dim notice. `/status` shows the remaining limits, and `/usage` shows
today's totals.

OpenRouter's `:free` models allow 50 requests a day per account, or 1,000 after a one-time $10
credit purchase. When OpenRouter reports the quota as used up, VinaX skips those models until it
resets instead of waiting.

### NVIDIA requests fail

Check the key with `vinax health`: an `NVIDIA key` line marked `✖` means NVIDIA rejected it (get a
new one at [build.nvidia.com](https://build.nvidia.com), then `vinax login nvidia`). If you point
`providers.nvidia.baseUrl` at a self-hosted NIM, make sure it serves the model you ask for; a model
missing from its catalog is skipped with a warning at startup.

### "Waking VinaX gateway…"

A gateway on Render's free plan sleeps after 15 idle minutes, and the first request after that
takes up to a minute. If it never wakes, check the service's logs in the Render dashboard.
`vinax doctor` also checks whether the gateway answers.

### Keys are not found

Environment variables (`GROQ_API_KEY`, `OPENROUTER_API_KEY`, `NVIDIA_API_KEY`, `VINAX_GATEWAY_TOKEN`) take
precedence over stored keys. `vinax config keys` shows which key is used and where it comes from.
Standalone binaries and systems without a keychain store keys in `~/.vinax/credentials.json`.

### The model says it can't see images

gpt-oss and other text-only models can't see images. Attach the image as an image (drag the file in, use `@shot.png`, or copy it and press `Ctrl+V`) rather than describing its path; VinaX then sends that turn to a [vision model](/models#vision-models). If the notice says no vision model is available, add a key for a provider with one (NVIDIA or OpenRouter) or set `visionModel`.

If VinaX says it can't read a screenshot, macOS is blocking the folder it's in (new screenshots first land in a private `TemporaryItems` folder). Press `Ctrl+Shift+Cmd+4` to copy a screenshot to the clipboard and `Ctrl+V` in VinaX, or save it to your Desktop first.

### The `@` menu is empty or slow

`@` lists the current folder's top level straight away and indexes the rest in the background, skipping dependencies, build output, caches, `Library` and `.gitignore`d files. In a very large folder, keep typing to narrow the list, or type a folder path such as `@src/` to list it directly.

### `/copy` doesn't reach the clipboard

`/copy` uses `pbcopy` (macOS), `clip` (Windows) or `wl-copy`, `xclip` or `xsel` (Linux), and otherwise the OSC 52 escape, which your terminal must allow (in tmux, `set -g set-clipboard on`). Selecting text with the mouse always works.

### Reasoning effort has no effect

Only reasoning models (such as gpt-oss) use it; others ignore it. If a provider rejects the parameter, VinaX quietly stops sending it to that model.

### Shift+Enter does not add a line

Many terminals send the same code for Enter and Shift+Enter. `\` followed by Enter, or
Option/Alt+Enter, always inserts a new line. Shift+Enter works in terminals that report it: kitty,
iTerm2, WezTerm, VS Code and Windows Terminal.

### Rewind or undo says files "changed outside VinaX"

VinaX found that a file differs from what it last wrote: you edited it, a shell command changed it, or (for sessions from older versions) it cannot tell. Nothing has been changed. Choose **Show what restoring would change** to see the difference, then keep your versions or overwrite them. Overwritten versions are copied to `~/.vinax/projects/<folder>/rewind-backups/` first. See [Rewind](/permissions#rewind).

### A resumed session reports damaged lines

The session file has lines VinaX could not use. They were skipped and the rest was loaded; the notice lists the line numbers and the file's path, and the file is not modified. An interrupted last write is moved to `<session>.jsonl.torn` instead. See [Damaged session files](/sessions#damaged-session-files).

### A task stopped "at the budget" or "going in circles"

Budgets come from `budget.tokens` / `budget.seconds` in settings or `--token-budget` / `--time-budget`. A task that keeps repeating a failing call is stopped so it does not burn tokens. In both cases what was done is kept: send a message to continue. See [Usage, budgets and cost](/usage).

### Windows

VinaX runs commands in Git Bash when it is installed, otherwise in PowerShell. Install
[Git for Windows](https://git-scm.com/download/win) for the best results, because models write
POSIX shell commands.

### Updating fails with a permission error

The binary lives where the install script put it (`~/.vinax/bin` by default). If you moved it
somewhere that needs admin rights, re-run the install script, or run `vinax update` with those
rights. For npm installs, see npm's guide to
[fixing global install permissions](https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally).
