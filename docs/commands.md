# Commands and prefixes

<p class="lead">Slash commands, the <code>@</code>, <code>!</code> and <code>#</code> prefixes, and writing your own commands.</p>

## Slash commands

Type `/` for the menu. Use ↑/↓ to choose, Tab to complete and Enter to run.

| Command                             | What it does                                                              |
| ----------------------------------- | ------------------------------------------------------------------------- |
| `/help`                             | Commands and keyboard shortcuts                                           |
| `/clear` (`/new`)                   | Start a new conversation. The old one stays available in `/resume`        |
| `/compact [focus]`                  | Summarize the conversation to free up context                             |
| `/model [provider:model \| alias]`  | Switch the model for this session (with a searchable picker)              |
| `/models`                           | Providers, the current model, the fallback order and aliases; then switch |
| `/resume`                           | Continue an earlier conversation in this folder                           |
| `/rewind`                           | Go back to an earlier prompt, restoring files and/or the conversation     |
| `/init`                             | Analyze the project and write a starter `VINAX.md`                        |
| `/memory`                           | Edit a memory file in your `$EDITOR`                                      |
| `/status`                           | Session, providers, remaining rate limits and OpenRouter quota            |
| `/usage`                            | Requests and tokens used today, per provider and model                    |
| `/doctor`                           | Check the installation, keys, search, shell, git, keychain and terminal   |
| `/health`                           | A concise, grouped health summary (full details: `/doctor`)               |
| `/about`                            | Version, runtime, install type, model, gateway, MCP and platform          |
| `/update`                           | Installed vs latest version, and how to update this install               |
| `/changelog`, `/whats-new`          | Release notes for recent versions                                         |
| `/snake`, `/game`                   | Play Snake II, Nokia 3310-style, in colour                                |
| `/effort [auto\|low\|medium\|high]` | How hard reasoning models think before answering                          |
| `/copy [n]`                         | Copy the last answer, or its nth code block, to the clipboard             |
| `/skills`                           | [Skills](/skills) VinaX can load for specific tasks                       |
| `/login`, `/logout`                 | Add or remove a provider key, or connect or disconnect a gateway          |
| `/settings` (`/config`)             | Change settings in a panel: model, effort, mode, theme and more           |
| `/permissions`                      | Permission mode and rules: view, add, remove, change mode                 |
| `/hooks`                            | Show configured [hooks](/hooks)                                           |
| `/mcp`                              | [MCP servers](/mcp), their tools, and approving project servers           |
| `/agents`                           | [Sub-agents](/sub-agents) the Task tool can use                           |
| `/theme`, `/vim`                    | Change the colour theme; toggle vim key bindings                          |
| `/export [file]`                    | Save the conversation as Markdown                                         |
| `/bug`                              | Open a pre-filled GitHub issue                                            |
| `/exit` (`/quit`)                   | Quit                                                                      |

### Models, health and about

- **`/model`** opens a picker you can search by typing: models are grouped by provider, `●` marks the current one, and models you can't use yet are dimmed with the reason. `/model NVD_CHAT_OSS_20_B` or `/model nvidia:openai/gpt-oss-20b` switches directly. The choice is saved with the session. See [Models](/models#browsing-and-switching-models).
- **`/models`** shows every provider and whether it is set up, the current model and alias, the fallback order with each entry's status, and the aliases, then offers the picker.
- **`/health`** runs the `/doctor` checks and shows one line each, grouped under Runtime, Providers & models, Tools and Integrations: `✔` ok, `⚠` warning, `✖` failure, `○` optional and not set up.
- **`/snake`** opens Snake II as the Nokia 3310 played it, in colour. The menu has **New game**, **Level** (1–9, shown as the phone's `▮▮▮▯▯▯▯▯▯` bar; ↑/→ raise it, ↓/← lower it), **Mazes** (No maze, Box, Tunnel, Mill, Rails, Apartment), **Top score**, **Instructions** and **Quit**. `C` switches between the colour palette and a classic green LCD. Steer with the arrow keys, WASD or hjkl. With no maze the snake wraps around the screen edges; maze walls and your own tail end the game. The level sets the speed (about 250 ms a move at level 1 down to 60 ms at level 9), each meal is worth the level number, and every fifth meal a bonus critter appears with a countdown: the sooner you catch it, the more it's worth. `P` or Space pauses (Continue, New game, Menu). Top scores are saved for each level and maze.
- **`/effort`** sets the reasoning effort (`auto`, `low`, `medium` or `high`) with a picker, or directly with `/effort high`. See [Models](/models#reasoning-effort).
- **`/copy`** copies VinaX's last answer to the clipboard; `/copy 2` copies its second code block. See [Copying text](/interactive-mode#copying-text).
- **`/settings`** opens the [settings panel](/settings#settings-panel), and **`/permissions`** lets you [add and remove rules](/permissions#managing-rules-with-permissions).
- **`/update`** checks GitHub Releases and shows your installed version, the latest one, and the exact update command for how VinaX was installed (`vinax update`, npm, or `git pull` for a source checkout).
- **`/about`** shows the VinaX version, runtime, installation type, current provider and model, gateway, MCP servers, platform, architecture and the repository URL.

## Prefixes

| Prefix | Example                       | What happens                                                                                                                                                                                             |
| ------ | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@`    | `explain @src/router.ts`      | Attaches a file or folder. The file counts as read, so VinaX can edit it straight away. Type `@` for the [file menu](/interactive-mode#input); `@shot.png` attaches an [image](/interactive-mode#images) |
| `!`    | `!npm test`                   | Runs the command yourself, with no model call. The output joins the conversation so you can ask about it                                                                                                 |
| `#`    | `#always use pnpm, never npm` | Saves a note to project or personal [memory](/memory)                                                                                                                                                    |

## Custom commands

Put a Markdown file in `.vinax/commands/` for the project, or `~/.vinax/commands/` just for you. The file name becomes the command, and subfolders become namespaces: `git/review.md` is `/git:review`.

```markdown
---
description: Review the current diff
argument-hint: <focus>
allowed-tools: Bash(git diff:*), Read
model: groq:openai/gpt-oss-120b
---

Review this diff with a focus on $ARGUMENTS:
!`git diff --stat`

Our conventions: @docs/CONVENTIONS.md
```

| In the template | Becomes                                                          |
| --------------- | ---------------------------------------------------------------- |
| `$ARGUMENTS`    | Everything typed after the command                               |
| `$1` … `$9`     | Single arguments (quotes group words)                            |
| `` !`cmd` ``    | The command's output. It only runs if `allowed-tools` permits it |
| `@file`         | The file's contents                                              |

| Frontmatter     | Meaning                                                       |
| --------------- | ------------------------------------------------------------- |
| `description`   | Shown in the `/` menu                                         |
| `argument-hint` | Shown after the name while you type                           |
| `allowed-tools` | Rules pre-approved for this one turn, e.g. `Bash(git diff:*)` |
| `model`         | Model to use for this command (a ref or an alias)             |
