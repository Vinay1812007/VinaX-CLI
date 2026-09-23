# Troubleshooting

Start with `vinax doctor` (or `/doctor` inside VinaX). It checks your install, settings, keys,
search, shell, git, key storage, terminal and gateway, and exits with code 1 if something is broken.
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

### "Waking VinaX gateway…"

A gateway on Render's free plan sleeps after 15 idle minutes, and the first request after that
takes up to a minute. If it never wakes, check the service's logs in the Render dashboard.
`vinax doctor` also checks whether the gateway answers.

### Keys are not found

Environment variables (`GROQ_API_KEY`, `OPENROUTER_API_KEY`, `VINAX_GATEWAY_TOKEN`) take
precedence over stored keys. `vinax config keys` shows which key is used and where it comes from.
Standalone binaries and systems without a keychain store keys in `~/.vinax/credentials.json`.

### Shift+Enter does not add a line

Many terminals send the same code for Enter and Shift+Enter. `\` followed by Enter, or
Option/Alt+Enter, always inserts a new line. Shift+Enter works in terminals that report it: kitty,
iTerm2, WezTerm, VS Code and Windows Terminal.

### Windows

VinaX runs commands in Git Bash when it is installed, otherwise in PowerShell. Install
[Git for Windows](https://git-scm.com/download/win) for the best results, because models write
POSIX shell commands.

### Updating fails with a permission error

The binary lives where the install script put it (`~/.vinax/bin` by default). If you moved it
somewhere that needs admin rights, re-run the install script, or run `vinax update` with those
rights. For npm installs, see npm's guide to
[fixing global install permissions](https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally).
