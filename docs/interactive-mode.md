# Interactive mode

<p class="lead">Keyboard shortcuts, input tricks and what the screen shows while VinaX works.</p>

```bash
vinax                      # start in the current folder
vinax "explain this repo"  # start with a first prompt
vinax -c                   # continue the last conversation here
```

## The screen

VinaX opens with a welcome panel:

<pre class="vx-terminal"><span class="accent">╲  ╱ ╲╱</span>  VinaX <span class="dim">v0.1.0</span>
<span class="accent"> ╲╱  ╱╲</span>  <span class="dim">AI coding agent for the terminal</span>

<span class="dim">cwd</span>      ~/code/app <span class="dim">⎇ main</span>
<span class="dim">model</span>    openai/gpt-oss-20b <span class="dim">· NVIDIA · NVD_CHAT_OSS_20_B</span>
<span class="dim">session</span>  new session
<span class="dim">memory</span>   ✓ VINAX.md  ✓ AGENTS.md  ✓ 1 imported file

<span class="accent">/</span> <span class="dim">commands</span>  <span class="accent">@</span> <span class="dim">files</span>  <span class="accent">!</span> <span class="dim">shell</span>  <span class="accent">#</span> <span class="dim">memory</span>  <span class="accent">?</span> <span class="dim">shortcuts</span></pre>

It shows the VinaX mark and version, the folder and git branch, the model with its provider and alias, whether this is a new or resumed session, and which [memory](/memory) files are in use (names only, never their contents). In windows narrower than 40 columns the mark and the shortcut row are left out; on `TERM=dumb` the mark is drawn in plain ASCII; with `NO_COLOR` nothing is coloured.

- **Answers** stream in as formatted Markdown: headings, lists, tables and syntax-highlighted code.
- **Tool calls** appear as one line each (`▸ Edit src/app.ts`), with a one-line result underneath. `⊘` marks a call that was denied, declined or blocked by a hook (your decision), and `✖` a tool that failed. Slow tools show how long they took.
- **The activity line** shows what VinaX is doing (Inspecting repository, Planning, Editing, Running tests, Running commands, Delegating to a sub-agent, Reading the web), elapsed time, an approximate token count and `esc to interrupt`. Below it, a trail shows the stages of the turn so far, such as `Inspecting repository → Editing → Running tests`.
- **The turn summary.** A turn that used tools ends with a line like `▸ Done └ Updated 2 files · 5 tool calls · 12.3s`.
- **Error cards.** When a turn fails, a card shows each model that was tried, its provider, the kind of failure and the provider's message, and what to try next: retry, `/model`, `/login`, `/health` or `/compact`.
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
