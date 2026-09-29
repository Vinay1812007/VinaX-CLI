# Commands and prefixes

<p class="lead">Slash commands, the <code>@</code>, <code>!</code> and <code>#</code> prefixes, and writing your own commands.</p>

## Slash commands

Type `/` for the menu. Use ↑/↓ to choose, Tab to complete and Enter to run.

| Command                            | What it does                                                              |
| ---------------------------------- | ------------------------------------------------------------------------- |
| `/help`                            | Commands and keyboard shortcuts                                           |
| `/clear` (`/new`)                  | Start a new conversation. The old one stays available in `/resume`        |
| `/compact [focus]`                 | Summarize the conversation to free up context                             |
| `/model [provider:model \| alias]` | Switch the model for this session (with a searchable picker)              |
| `/models`                          | Providers, the current model, the fallback order and aliases; then switch |
| `/resume`                          | Continue an earlier conversation in this folder                           |
| `/rewind`                          | Go back to an earlier prompt, restoring files and/or the conversation     |
| `/init`                            | Analyze the project and write a starter `VINAX.md`                        |
| `/memory`                          | Edit a memory file in your `$EDITOR`                                      |
| `/status`                          | Session, providers, remaining rate limits and OpenRouter quota            |
| `/usage`                           | Requests and tokens used today, per provider and model                    |
| `/doctor`                          | Check the installation, keys, search, shell, git, keychain and terminal   |
| `/health`                          | A concise, grouped health summary (full details: `/doctor`)               |
| `/about`                           | Version, runtime, install type, model, gateway, MCP and platform          |
| `/update`                          | Installed vs latest version, and how to update this install               |
| `/changelog`, `/whats-new`         | Release notes for recent versions                                         |
| `/snake`, `/game`                  | Play Snake, Nokia-style, in colour                                        |
| `/login`, `/logout`                | Add or remove a provider key, or connect or disconnect a gateway          |
| `/config`                          | Show the effective settings and where each comes from                     |
| `/permissions`                     | Show the permission mode and rules                                        |
| `/hooks`                           | Show configured [hooks](/hooks)                                           |
| `/mcp`                             | [MCP servers](/mcp), their tools, and approving project servers           |
| `/agents`                          | [Sub-agents](/sub-agents) the Task tool can use                           |
| `/theme`, `/vim`                   | Change the colour theme; toggle vim key bindings                          |
| `/export [file]`                   | Save the conversation as Markdown                                         |
| `/bug`                             | Open a pre-filled GitHub issue                                            |
| `/exit` (`/quit`)                  | Quit                                                                      |

### Models, health and about

- **`/model`** opens a picker you can search by typing: models are grouped by provider, `●` marks the current one, and models you can't use yet are dimmed with the reason. `/model NVD_CHAT_OSS_20_B` or `/model nvidia:openai/gpt-oss-20b` switches directly. The choice is saved with the session. See [Models](/models#browsing-and-switching-models).
- **`/models`** shows every provider and whether it is set up, the current model and alias, the fallback order with each entry's status, and the aliases, then offers the picker.
- **`/health`** runs the `/doctor` checks and shows one line each, grouped under Runtime, Providers & models, Tools and Integrations: `✔` ok, `⚠` warning, `✖` failure, `○` optional and not set up.
- **`/snake`** opens a colour, Nokia-style Snake. Steer with the arrow keys, WASD or hjkl; `P` pauses, `R` restarts after a game over, `Esc` or `Q` returns to the prompt. Walls and your own tail end the game, every five meals raises the speed level (1–9), and a blinking bonus critter appears now and then for extra points. Your best score is saved.
- **`/update`** checks GitHub Releases and shows your installed version, the latest one, and the exact update command for how VinaX was installed (`vinax update`, npm, or `git pull` for a source checkout).
- **`/about`** shows the VinaX version, runtime, installation type, current provider and model, gateway, MCP servers, platform, architecture and the repository URL.

## Prefixes

| Prefix | Example                       | What happens                                                                                                                                     |
| ------ | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `@`    | `explain @src/router.ts`      | Attaches a file or folder. The file counts as read, so VinaX can edit it straight away. Type `@` for fuzzy completion; `.gitignore` is respected |
| `!`    | `!npm test`                   | Runs the command yourself, with no model call. The output joins the conversation so you can ask about it                                         |
| `#`    | `#always use pnpm, never npm` | Saves a note to project or personal [memory](/memory)                                                                                            |

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
