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

The resume picker (`vinax -r` and `/resume`) lists the most recent conversations first, grouped under **Today**, **Yesterday**, **This week** and **Older**. Each shows its title, how long ago it was used, how many prompts it has and, if you switched with `/model`, that model. Type to search titles and first prompts.

A model you pick with `/model` is saved with the session and used again when you resume it, unless you pass `--model`. Older VinaX versions ignore this entry, so session files stay compatible.

### Damaged session files

Every line of a session file is checked when it is read. VinaX tells two kinds of damage apart:

- **An interrupted last write** (VinaX was killed mid-step). Everything before it is restored. When you resume, the incomplete line is moved to `<session>.jsonl.torn`, so new entries are not glued onto it, and a notice says so.
- **Damage in the middle** (a line that is not valid, for example after editing the file by hand). Those lines are skipped, the notice gives their line numbers and the file's path, and the file itself is left unchanged so you can inspect or back it up. The resume picker marks such sessions with `⚠ damaged lines`.

Lines written by a newer VinaX that this version does not know are skipped quietly.

The resume picker reads a small index (`sessions/.index.json`) and only reopens session files whose size or modification time changed, so listing stays fast with many long sessions. The index is only a cache: deleting it is safe.

## Git context

In a git repository, VinaX tells the model where things stand when the session starts: the branch, how far it is ahead of or behind its upstream, how many files are staged, unstaged and untracked, a short status (at most 20 lines) and the last five commits. Every list is capped, so a large working tree can't flood the context. The model runs git itself for the current state, and VinaX's safeguards for risky git commands (force-push, `reset --hard`, `clean`) still apply. This helps with requests like "review my changes", "commit these changes" or "explain this diff".

## Compaction

Free-tier models have small per-minute token budgets, so VinaX works within a conversation budget: `context.maxTokens`, 24K tokens by default, capped by the model's own window. The footer shows how much is used.

At **85%** VinaX compacts in two stages:

1. **Trim old tool output.** Long results from earlier steps are shortened. This is free.
2. **Summarize.** If that isn't enough, the small model writes a structured summary with Goal, Decisions, Files, Commands, Current state and Next steps sections. The summary replaces the older turns.

Some things are carried over word for word instead of relying on the summary: your own requests from the summarized part (the last eight, so constraints like "don't touch the public API" survive), the open items of the task list, and the prompt in progress with its attached images and any tool calls with their results. Compacting again later keeps the requests pinned by the earlier compaction.

`/compact [focus]` compacts on demand. The optional focus tells the summary what to keep. Set `context.autoCompact: false` to turn automatic compaction off.

```json
{ "context": { "maxTokens": 32000, "autoCompact": true } }
```
