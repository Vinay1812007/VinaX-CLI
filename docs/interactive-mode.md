# Interactive mode

<p class="lead">Keyboard shortcuts, input tricks and what the screen shows while VinaX works.</p>

```bash
vinax                      # start in the current folder
vinax "explain this repo"  # start with a first prompt
vinax -c                   # continue the last conversation here
```

## The screen

VinaX opens with a welcome panel:

<pre class="vx-terminal"><span style="color:#FF9933">▀▀▀     ▀▀▀ ▀▀▀                     ▀▀▀     ▀▀▀</span>
<span style="color:#FF9933">▀▀▀     ▀▀▀                          ▀▀▀   ▀▀▀ </span>
<span style="color:#FF9933"> ▀▀▀   ▀▀▀  ▀▀▀ ▀▀▀▀▀▀▀▀   ▀▀▀▀▀▀▀▀   ▀▀▀ ▀▀▀  </span>
<span style="color:#F8FAFC"> ▀▀▀   ▀▀▀  ▀▀▀ ▀▀▀   ▀▀▀ ▀▀▀   ▀▀▀    ▀▀▀▀▀   </span>
<span style="color:#F8FAFC">  ▀▀▀ ▀▀▀   ▀▀▀ ▀▀▀   ▀▀▀ ▀▀▀ </span><span style="color:#1D4ED8">✺</span><span style="color:#F8FAFC"> ▀▀▀   ▀▀▀ ▀▀▀  </span>
<span style="color:#3CB043">   ▀▀▀▀▀    ▀▀▀ ▀▀▀   ▀▀▀ ▀▀▀   ▀▀▀  ▀▀▀   ▀▀▀ </span>
<span style="color:#3CB043">    ▀▀▀     ▀▀▀ ▀▀▀   ▀▀▀  ▀▀▀▀▀▀▀▀ ▀▀▀     ▀▀▀</span>
VinaX <span class="dim">v0.3.0 · AI coding agent for the terminal</span>

<span class="dim">cwd</span>      ~/code/app <span class="dim">⎇ main</span>
<span class="dim">model</span>    openai/gpt-oss-20b <span class="dim">· NVIDIA · NVD_CHAT_OSS_20_B</span>
<span class="dim">session</span>  new session
<span class="dim">memory</span>   ✓ VINAX.md  ✓ AGENTS.md  ✓ 1 imported file

<span class="accent">/</span> <span class="dim">commands</span>  <span class="accent">@</span> <span class="dim">files</span>  <span class="accent">!</span> <span class="dim">shell</span>  <span class="accent">#</span> <span class="dim">memory</span>  <span class="accent">?</span> <span class="dim">shortcuts</span></pre>

It shows the VinaX logo (striped saffron, white and green letters with a blue chakra in the "a") and version, the folder and git branch, the model with its provider and alias, whether this is a new or resumed session, and which [memory](/memory) files are in use (names only, never their contents). In windows narrower than 51 columns the logo becomes a one-line tricolor **VinaX** and the shortcut row is left out; on `TERM=dumb` the logo is drawn in plain ASCII; with `NO_COLOR` nothing is coloured.

After you upgrade, the first session shows a **What's new** panel with the release notes since the version you had. When a newer release is out, a notice says so and how to update. The check runs at most once a day, never in CI, and `VINAX_NO_UPDATE_CHECK=1` turns it off. `/update` and `/changelog` show the same on demand.

- **Answers** stream in as formatted Markdown: headings, lists, tables and syntax-highlighted code.
- **Tool calls** appear as one line each (`▸ Edit src/app.ts`), with a one-line result underneath. `⊘` marks a call that was denied, declined or blocked by a hook (your decision), and `✖` a tool that failed. Slow tools show how long they took.
- **The activity line** shows a pulsing `✻` spinner (`· ✢ ✳ ✶ ✻ ✽`) and what VinaX is doing (Thinking, Inspecting repository, Planning, Editing, Running tests, Running commands, Delegating to a sub-agent, Reading the web), with a highlight sweeping across the words. After it come the elapsed time, an approximate token count, the [effort](#reasoning-effort) if you set one, and `esc to interrupt`: `✻ Editing… (12s · ↓ 1.2K tokens · high effort · esc to interrupt)`. Below it, a trail shows the stages of the turn so far, such as `Inspecting repository → Editing → Running tests`.
- **Thinking.** When the model streams its reasoning (gpt-oss and other reasoning models do), a dim `⎿ …` line under the spinner shows its latest thought. When it starts answering, `✻ Thought for 4s` is left in the transcript.
- **The turn summary.** A turn that used tools ends with a line like `▸ Done └ Updated 2 files · 5 tool calls · 12.3s`.
- **Error cards.** When a turn fails, a card shows each model that was tried, its provider, the kind of failure and the provider's message, and what to try next: retry, `/model`, `/login`, `/health` or `/compact`.
- **Your prompts** appear in the transcript as `> your prompt`.
- **The footer** shows the [permission mode](#modes) on the left, then `(shift+tab to cycle) · ? for shortcuts` when there is room. On the right it shows the model that answered, the effort (`◔ low`, `◑ medium`, `● high`) when set, and how much of the context budget is used. Fallback and rate-limit notices appear under it.
- **The task list** appears above the prompt whenever VinaX tracks steps with `TodoWrite`.

## The chat bar

The prompt box looks like Claude Code's: a grey rounded box with a `>` prompt and a rotating example such as `Try "review my changes"`.

- Start with `!` and the prompt turns into `!` with a pink border: the line runs as a shell command.
- Start with `#` and it turns into `#` with a blue border: the line is saved to [memory](/memory).
- While a reply streams, the box says `Type to queue a follow-up · esc to interrupt`.

### Modes

The footer always shows the permission mode, and **Shift+Tab** cycles through them:

| Footer               | Mode          | What VinaX does without asking                                                                                                                  |
| -------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `⏸ manual mode on`   | `default`     | Only reads inside the project; asks before edits, commands and web access                                                                       |
| `⏵⏵ accept edits on` | `acceptEdits` | Also applies edits inside the project                                                                                                           |
| `⏸ plan mode on`     | `plan`        | Read-only; researches and proposes a plan first                                                                                                 |
| `⏵⏵ auto mode on`    | `auto`        | Edits, commands and web access inside the project; dangerous commands, deny and ask rules, anything outside the project and MCP tools still ask |

See [Permissions](/permissions#modes) for the details.

### Reasoning effort

`/effort` (or `/effort high`) sets how hard reasoning models such as gpt-oss think before answering: `auto` (the model's default), `low`, `medium` or `high`. The choice is saved as `reasoningEffort` and shown in the footer. See [Models](/models#reasoning-effort).

## Keyboard shortcuts

| Key                                                 | Action                                                                              |
| --------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `Enter`                                             | Send. Typing while a reply streams queues the next prompt                           |
| `\` then `Enter`, `Shift+Enter`, `Option/Alt+Enter` | New line. `Shift+Enter` works in terminals that report it                           |
| `↑` / `↓`                                           | Move between lines, then walk this project's prompt history                         |
| `Ctrl+R`                                            | Search prompt history; press again for older matches                                |
| `Shift+Tab`                                         | Cycle modes: ⏸ manual → ⏵⏵ accept edits → ⏸ plan → ⏵⏵ auto                          |
| `Esc`                                               | Stop the current reply. What was written so far is kept                             |
| `Esc Esc`                                           | Clear the prompt. On an empty prompt, open the [rewind](/permissions#rewind) picker |
| `Ctrl+V`                                            | Paste an image from the clipboard (see [Images](#images))                           |
| `Option/Alt+←` / `Option/Alt+→`                     | Word left / right                                                                   |
| `Ctrl+A` / `Ctrl+E`                                 | Start / end of line                                                                 |
| `Option/Alt+Backspace`, `Ctrl+W`                    | Delete the word before the cursor                                                   |
| `Alt+D`                                             | Delete the word after the cursor                                                    |
| `Ctrl+U` / `Ctrl+K`                                 | Delete to the start / end of the line                                               |
| `Ctrl+Y`                                            | Paste back the text you last deleted                                                |
| `Ctrl+_`                                            | Undo                                                                                |
| `Ctrl+O`                                            | Turn details: model, tokens, time, fallbacks and live rate limits                   |
| `Ctrl+L`                                            | Redraw the screen                                                                   |
| `?` (on an empty prompt)                            | Show all shortcuts                                                                  |
| `Ctrl+C`                                            | Clear the prompt; press again within 2 s to exit                                    |
| `Ctrl+D`                                            | Exit (on an empty prompt)                                                           |

## Input

- **Prefixes.** `@path` attaches a file, `!command` runs a shell command, and `#note` saves to memory. See [Commands and prefixes](/commands#prefixes).
- **The `@` menu.** Typing `@` lists the folder's top level at once, folders first (`▸` folders, `·` files). `@src/` lists that folder, and anything else is fuzzy-matched against a background index of the project. The index skips `node_modules`, `.git`, build output, caches, `Library` and files your `.gitignore` excludes, and stops at about 20,000 entries or 1.5 s, so it stays fast even in your home folder. A last row, `… more — keep typing to narrow`, appears when there are more matches.
- **Commands.** `/` opens the command menu. Use ↑/↓ to choose, Tab to complete and Enter to run.
- **Pastes.** A paste of 8+ lines or 800+ characters collapses to `[Pasted text #1 +42 lines]`. The full text is still sent.
- **Vim mode.** `/vim` turns on vim key bindings for the prompt: `hjkl w b e 0 ^ $ x X D C S dd cc dw cw` and `i a I A o O u`. The choice is saved.

## Images

VinaX can send screenshots and other images to models that can see them:

- **Drag a file** into the terminal (the path is pasted with escaped spaces), or paste or type its path, quoted or absolute.
- **`@shot.png`** attaches an image in the project.
- **`Ctrl+V`** pastes an image from the clipboard. On macOS, `Ctrl+Shift+Cmd+4` copies a screenshot to the clipboard. `Cmd+V` still pastes text. This uses `osascript` on macOS, `wl-paste` or `xclip` on Linux and PowerShell on Windows.

Each image becomes an `[Image #1]` chip in the prompt, and a note such as `Attached [Image #1] shot.png (84 KB)` appears. PNG, JPEG, GIF and WebP up to about 3.75 MB work; on macOS larger images are shrunk with `sips` first.

gpt-oss models are text-only, which is why they used to answer that they can't see images. Now a prompt with images goes to a model that can see them, and a notice says which:

1. the `visionModel` [setting](/settings), if set
2. otherwise a vision model already in your fallback chain
3. otherwise a vision model VinaX knows on a provider you use (NVIDIA's `meta/llama-3.2-90b-vision-instruct` or `meta/llama-3.2-11b-vision-instruct`)
4. otherwise a vision model from a provider's catalog (OpenRouter marks them; free ones first)

Later turns go back to your normal model, which gets a short note that an image was attached instead of the image itself. If no vision model is available, a warning says so and the model only sees the file name.

macOS keeps some folders private, such as the `TemporaryItems` folder where new screenshots first land. If VinaX can't read a file there, it says so and suggests copying the screenshot to the clipboard and pressing `Ctrl+V`.

## Copying text

Select text with the mouse or trackpad as in any terminal program: VinaX doesn't capture the mouse, so your terminal's own selection and copy keep working. `/copy` copies VinaX's last answer to the clipboard, and `/copy 2` copies its second code block. It uses `pbcopy`, `clip`, `wl-copy`, `xclip` or `xsel`, and falls back to the terminal's OSC 52 clipboard escape (set `VINAX_CLIPBOARD=osc52` to always use that, for example over SSH).

Clicking to move the cursor inside the prompt would mean capturing the mouse, which breaks native selection, so VinaX keeps native selection, as Claude Code does. Use the keyboard shortcuts above to move and edit.

## Leaving

`/exit`, `Ctrl+C` twice or `Ctrl+D` on an empty prompt closes VinaX. The prompt box disappears and a summary is printed:

<pre class="vx-terminal"><span class="accent">✻</span> Session saved
  <span class="dim">Session</span>  20260929-164512-abc123 · Fix login bug
  <span class="dim">Resume</span>   <span class="accent">vinax --resume 20260929-164512-abc123</span>
  <span class="dim">Time</span>     12m 04s total · 3m 10s working · 8 prompts · 23 tool calls
  <span class="dim">Tokens</span>   45K in · 3.1K out
  <span class="dim">Changes</span>  4 files · +120 −34 lines
  <span class="dim">Models</span>   nvidia:openai/gpt-oss-20b</pre>

A session with no prompts just prints `✻ Bye!`.

## Themes

`/theme` (or [`/settings`](/settings#settings-panel)) switches between dark, light and colour-blind friendly themes. The choice is saved to your settings. `NO_COLOR` turns off colour entirely.

## Turn details

`Ctrl+O` opens a panel for the last turns. It shows which model answered, prompt and completion tokens, duration, every fallback, and the provider's remaining rate limits. It's useful for seeing why a turn was slow or switched models.
