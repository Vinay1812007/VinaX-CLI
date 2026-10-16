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
- **The footer** shows the [permission mode](#modes) on the left, then `(shift+tab to cycle) · ? for shortcuts` when there is room. On the right it shows what VinaX is doing (see [Task state](#task-state)), the model that answered, the effort (`◔ low`, `◑ medium`, `● high`) when set, and how much of the context budget is used. Fallback and rate-limit notices appear under it.
- **The task list** appears above the prompt whenever VinaX tracks steps with `TodoWrite`.

### Task state

The footer says at a glance whether VinaX is working, needs you, or stopped, and why:

| Footer                         | Meaning                                                                                 |
| ------------------------------ | --------------------------------------------------------------------------------------- |
| `● working 0:12`               | A turn, command or `!` shell command is running (with tokens against a budget)          |
| `◆ needs your approval · 0:05` | Waiting for you: an approval, a plan (`plan needs your review`) or a question           |
| `2 queued`                     | Messages you typed while VinaX was busy, sent in order when it finishes                 |
| `✓ done · 0:08`                | The last turn finished                                                                  |
| `⏹ interrupted`                | You stopped it; what was done so far is kept                                            |
| `✖ failed`                     | The models could not answer; an error card above says what to try                       |
| `⏹ stopped at the budget`      | A [token or time budget](/usage#budgets) ran out                                        |
| `⟲ stopped: going in circles`  | The task kept repeating a failing call; see [Usage](/usage#when-a-task-goes-in-circles) |
| `⊘ stopped: you declined`      | You declined an action                                                                  |

On a narrow terminal the state shortens to its symbol and clock (`◆ 0:05`).

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
| `Ctrl+P`                                            | [Command palette](#command-palette): search every command and view                  |
| `Ctrl+G`                                            | [Review changes](#reviewing-changes): changed files, diffs, undo one file           |
| `Ctrl+X`                                            | [Expand](#shortened-output) the last shortened tool output or diff, where it was    |
| `Ctrl+O`                                            | [Transcript](#transcript-and-turn-details): search, full tool output, turn details  |
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

## Images and screen recordings {#images}

VinaX can work from screenshots, other images and screen recordings:

- **Drag a file** into the terminal (the path is pasted with escaped spaces), or paste or type its path, quoted or absolute.
- **`@shot.png`** or **`@bug.mov`** attaches an image or recording in the project.
- **`Ctrl+V`** pastes an image from the clipboard. On macOS, `Ctrl+Shift+Cmd+4` copies a screenshot to the clipboard. `Cmd+V` still pastes text. This uses `osascript` on macOS, `wl-paste` or `xclip` on Linux and PowerShell on Windows.

Each image becomes an `[Image #1]` chip in the prompt and each recording a `[Video #1]` chip, and a note such as `Attached [Image #1] shot.png (84 KB)` appears. PNG, JPEG, GIF and WebP images up to about 3.75 MB work; on macOS larger images are shrunk with `sips` first. Recordings can be MP4, MOV, M4V, WebM, MKV or AVI.

**Your model stays in charge.** If the model you are working with can see images, it gets them directly. If it can't (gpt-oss and most other defaults are text-only), a [vision model](/models#vision-models) reads them for it: VinaX sends the image together with your request and a short recap of the conversation, the vision model transcribes all visible text (code, errors, terminal output, UI labels) and describes the layout and what matters for the task, and your model gets that description and carries on with its own tools. A notice says who is looking, for example `Reading [Image #1] with nvidia:meta/llama-3.2-90b-vision-instruct (nvidia:openai/gpt-oss-20b can't see images).`

The description is saved with the message, so later turns, `/resume` and compaction keep it, and the same image is never described twice in a session. A vision model you switch to later still gets the image itself.

**Screen recordings** are always read this way. A model marked as taking video (NVIDIA's Nemotron omni and Cosmos reasoning models) gets recordings up to 50 MB whole. Otherwise VinaX samples up to 12 frames (about one every 2 seconds, at most 1280 px) with [ffmpeg](https://ffmpeg.org) and a vision model describes them in order, with timestamps. Without ffmpeg, a warning says how to install it (`brew install ffmpeg` on macOS).

The model can also look at images and recordings itself: the Read tool on `shot.png` or `rec.mov` returns a description written for the task at hand. Files mentioned with `@` that can't be attached, such as binaries or text over 2 MB, are named in a warning instead of being dropped silently.

If no vision model is available, a warning says so and the model only sees the file name.

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
  <span class="dim">Tokens</span>   45K in · 3.1K out (reported) · ~2.4K estimated
  <span class="dim">Cost</span>     unknown (no price for nvidia:openai/gpt-oss-20b)
  <span class="dim">Changes</span>  4 files · +120 −34 lines
  <span class="dim">Models</span>   nvidia:openai/gpt-oss-20b</pre>

A session with no prompts just prints `✻ Bye!`. Reported and estimated tokens and the cost are explained in [Usage, budgets and cost](/usage).

## Themes

`/theme` (or [`/settings`](/settings#settings-panel)) switches between dark, light and colour-blind friendly themes. The choice is saved to your settings. `NO_COLOR` turns off colour entirely.

## Command palette

`Ctrl+P` opens a searchable list of every view (Review changes, Search transcript, Rewind, the next permission mode, keyboard shortcuts) and every slash command, built-in and custom, with its shortcut where there is one. Type to filter and press Enter. A command that needs an argument (such as `/review <file>`) is put into the prompt for you to finish instead of running.

## Reviewing changes

`Ctrl+G` (or `/changes`) lists every file VinaX changed this session with lines added and removed (`M` changed, `A` created, `D` deleted) and the diff of the selected file from before VinaX first touched it.

| Key                      | Action                            |
| ------------------------ | --------------------------------- |
| `↑` / `↓`                | Choose a file                     |
| `PgUp` / `PgDn`, `Space` | Scroll its diff                   |
| `u`                      | Undo VinaX's changes to that file |
| `r`                      | Read the files again              |
| `Esc`                    | Close                             |

A file that changed outside VinaX after it last wrote it (in your editor, or by a shell command) is marked `✎ changed outside VinaX`. Undoing it asks first, and your current version is saved to a backup folder before it is replaced. VinaX is told about the undo so it reads the file again. Only changes made with VinaX's file tools appear here; changes made by shell commands are not tracked. Undo is not available while VinaX is still working.

## Shortened output

A finished tool call is one line — `▸ Bash npm test` and its result — and a diff is cut to 24 lines. Whatever is left out is offered where it was cut: `… 18 more lines (ctrl+x to expand)` under a diff, `(ctrl+x to expand)` after a summary.

`Ctrl+X` prints it in full. Because the transcript is written into your terminal's scrollback and never redrawn, the expansion is appended below rather than growing the entry in place, so nothing you have already read moves. Pressing `Ctrl+X` again expands the call before it, and so on backwards; when nothing is left it says so.

Expanded output is part of the transcript, so `Ctrl+O` finds it too. A diff is expanded from the transcript itself, so it still works in a resumed session; plain tool output is only kept for calls made since VinaX started, and an expansion says so when it is gone.

## Transcript and turn details

`Ctrl+O` opens the whole transcript as a list, newest selected. Under each prompt it shows which model answered, the time, reported and estimated tokens, and every fallback with its reason; the providers' remaining rate limits are at the bottom.

- `↑` / `↓` move, `Enter` opens an entry to read all of it, including the **full output** of a tool call (scroll with `↑` / `↓` and `PgUp` / `PgDn`, `Enter` or `Esc` to go back).
- `/` searches prompts, answers and tool output; the matching line is shown under each result. `Esc` clears the search.

Your terminal's own scrollback is never changed; this is a separate view on top of it. Full tool output is kept for the calls made since VinaX started (a resumed session shows the summaries of older calls).

## Terminals

VinaX adapts to the window: lines are cut by their width on screen (wide CJK characters and emoji count double), the footer drops hints before it wraps, and views redraw when the window is resized. `NO_COLOR` turns off colour. `TERM=dumb` turns off colour too, and since the interactive screen needs cursor movement, VinaX asks you to use [`vinax -p`](/print-mode) there instead. Without a terminal (piped input or output) interactive mode is refused the same way.
