---
'@sirimillavinay/vinax': minor
---

Safer recovery and a review workflow. Rewind and per-file undo now notice files edited outside VinaX (including between turns), preview the differences, and ask before overwriting; every restore is backed up first and rolled back if a write fails. Files VinaX cannot read are no longer treated as missing. Session files are validated line by line: an interrupted last write is set aside instead of swallowing the next entry, damaged lines are reported with their numbers, and the session list is cached so it stays fast. Compaction keeps attached images, tool exchanges, your own requests and open tasks. Cancelling now stops hooks and everything they started at once.

New in the interactive UI: a command palette (Ctrl+P), a changes view with diffs and per-file undo (Ctrl+G, `/changes`), a searchable transcript with full tool output (Ctrl+O), and a status line that shows whether VinaX is working, waiting for you, or stopped and why. Text is cut by its width on screen, and `TERM=dumb` is handled.

New controls: per-task token and time budgets (`budget` settings, `--token-budget`, `--time-budget`), detection of tasks going in circles, reported and estimated tokens kept apart, costs shown only from explicit prices (`pricing` settings or the provider catalog), notes when a fallback model lacks tool calling or context, and opt-in isolated git worktrees (`--worktree`, `vinax worktree list|diff|apply|remove`). Print mode's JSON result adds `estimated_usage` and `cost`.
