---
'@sirimillavinay/vinax': minor
---

VinaX catches up with Claude Code, Codex CLI and Gemini CLI on the features people reach for most. A new docs page, "Compared with other agents", lists every feature side by side and what is still missing.

The agent can search the web. The new WebSearch tool needs no API key (it uses DuckDuckGo), switches to Brave Search or Tavily when `BRAVE_API_KEY` or `TAVILY_API_KEY` is set, can keep or drop results by domain, and hands the model a numbered list of titles, links and snippets to read further with WebFetch.

Two new permission modes. Read-only mode (`--read-only`) lets VinaX read, search and run commands that only read, such as `git status` or `grep`, and refuses every edit and every other command without asking. Bypass mode (`--yolo`, `--dangerously-skip-permissions` or `--permission-mode bypass`) runs everything without asking; only deny rules still block it. It shows a warning when it starts and is refused when VinaX runs as root (set `VINAX_ALLOW_ROOT_BYPASS=1` in a throwaway container). Shift+Tab now also reaches read-only mode, and reaches bypass only when the session started in it. `--approval-mode default|auto_edit|plan|yolo` accepts Gemini CLI's names.

Bash commands can run in a sandbox. With `--sandbox workspace-write` or `"sandbox": "workspace-write"` in settings, commands can only write inside the project, temp folders and `~/.vinax` (using `sandbox-exec` on macOS and `bwrap` on Linux); `read-only` also blocks those writes and the network. Where no sandbox is available, Bash refuses to run commands rather than running them unconfined. The default stays `off`.

Projects set up for other agents work as they are: VinaX now also reads `CLAUDE.md`, `GEMINI.md` and `.github/copilot-instructions.md`, and sends copies of the same instructions only once.

New commands: `/memory show`, `list`, `add <note>` and `refresh`; `/tools`; `/directory add <path>` (also `/add-dir`); `/review [pr | branch]`; `/security-review`; `/pr-comments`; `/todos`; and `/bashes`. New names for existing commands: `/compress`, `/restore`, `/checkpoint`, `/approvals` and `/extensions`. If you already have a custom command with one of the new names, yours keeps working and replaces the built-in.
