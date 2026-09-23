# Sessions and context

<p class="lead">How conversations are saved and resumed, and how VinaX keeps each request small.</p>

## Sessions

Every conversation is saved in `~/.vinax/projects/<folder>/sessions/` as JSON lines, with checkpointed file contents stored once each. After the first answer, the small model gives the session a short title.

| Flag or command             | Meaning                                               |
| --------------------------- | ----------------------------------------------------- |
| `vinax -c`, `--continue`    | Continue the most recent conversation in this folder  |
| `vinax -r`, `--resume [id]` | Pick a conversation to resume, or pass its id         |
| `/resume`                   | Pick one without leaving the session                  |
| `/clear`                    | Start fresh; the current conversation stays resumable |
| `/export [file]`            | Save the conversation as Markdown                     |

Both flags work with `-p` as well. `--output-format json` reports the `session_id`.

## Compaction

Free-tier models have small per-minute token budgets, so VinaX works within a conversation budget: `context.maxTokens`, 24K tokens by default, capped by the model's own window. The footer shows how much is used.

At **85%** VinaX compacts in two stages:

1. **Trim old tool output.** Long results from earlier steps are shortened. This is free.
2. **Summarize.** If that isn't enough, the small model writes a structured summary with Goal, Decisions, Files, Commands, Current state and Next steps sections. The summary replaces the older turns.

`/compact [focus]` compacts on demand. The optional focus tells the summary what to keep. Set `context.autoCompact: false` to turn automatic compaction off.

```json
{ "context": { "maxTokens": 32000, "autoCompact": true } }
```
