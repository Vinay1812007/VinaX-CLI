---
'@sirimillavinay/vinax': minor
---

A Claude Code-style experience: modes, settings, effort, images, skills, copy, a real Snake II and a proper goodbye.

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
