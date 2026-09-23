# Interactive mode

<p class="lead">Keyboard shortcuts, input tricks and what the screen shows while VinaX works.</p>

```bash
vinax                      # start in the current folder
vinax "explain this repo"  # start with a first prompt
vinax -c                   # continue the last conversation here
```

## The screen

- **Answers** stream in as formatted Markdown: headings, lists, tables and syntax-highlighted code.
- **Tool calls** appear as one line each (`▸ Edit src/app.ts`), with a one-line result underneath.
- **The activity line** shows elapsed time, an approximate token count and `esc to interrupt` while a reply streams.
- **The footer** shows the permission mode, the model that answered, how much of the context budget is used, and any fallback or rate-limit notice.
- **The task list** appears above the prompt whenever VinaX tracks steps with `TodoWrite`.

## Keyboard shortcuts

| Key                                                 | Action                                                                              |
| --------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `Enter`                                             | Send. Typing while a reply streams queues the next prompt                           |
| `\` then `Enter`, `Shift+Enter`, `Option/Alt+Enter` | New line. `Shift+Enter` works in terminals that report it                           |
| `↑` / `↓`                                           | Move between lines, then walk this project's prompt history                         |
| `Ctrl+R`                                            | Search prompt history; press again for older matches                                |
| `Esc`                                               | Stop the current reply. What was written so far is kept                             |
| `Esc Esc`                                           | Clear the prompt. On an empty prompt, open the [rewind](/permissions#rewind) picker |
| `Shift+Tab`                                         | Cycle modes: default → auto-accept edits → plan                                     |
| `Ctrl+O`                                            | Turn details: model, tokens, time, fallbacks and live rate limits                   |
| `?` (on an empty prompt)                            | Show all shortcuts                                                                  |
| `Ctrl+A` / `Ctrl+E`                                 | Start / end of line                                                                 |
| `Ctrl+W` / `Ctrl+U` / `Ctrl+K`                      | Delete word / to start / to end                                                     |
| `Ctrl+C`                                            | Clear the prompt; press again within 2 s to exit                                    |
| `Ctrl+D`                                            | Exit (on an empty prompt)                                                           |

## Input

- **Prefixes.** `@path` attaches a file, `!command` runs a shell command, and `#note` saves to memory. See [Commands and prefixes](/commands#prefixes).
- **Commands.** `/` opens the command menu. Use ↑/↓ to choose, Tab to complete and Enter to run.
- **Pastes.** A paste of 8+ lines or 800+ characters collapses to `[Pasted text #1 +42 lines]`. The full text is still sent.
- **Vim mode.** `/vim` turns on vim key bindings for the prompt: `hjkl w b e 0 ^ $ x X D C S dd cc dw cw` and `i a I A o O u`. The choice is saved.

## Themes

`/theme` switches between dark, light and colour-blind friendly themes. The choice is saved to your settings. `NO_COLOR` turns off colour entirely.

## Turn details

`Ctrl+O` opens a panel for the last turns. It shows which model answered, prompt and completion tokens, duration, every fallback, and the provider's remaining rate limits. It's useful for seeing why a turn was slow or switched models.
