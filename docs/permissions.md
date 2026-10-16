# Permissions

<p class="lead">What VinaX may do without asking, how to change that, and how to undo changes.</p>

Reading inside the project is always allowed. Edits, commands, network access, MCP tools, and reads outside the project ask first.

## Approval prompts

When VinaX needs approval, it shows what it wants to do: the command, the diff, or the URL. You can answer:

1. **Yes.**
2. **Yes, and don't ask again.** This allows a suggested rule, such as `Bash(npm test:*)`, either for this session or for this project (saved to `.vinax/settings.local.json`). For edits, you can instead auto-accept edits for the rest of the session.
3. **No, and tell VinaX what to do differently.** Your note goes to the model and it carries on. Esc just stops.

:::warning Always asked
These always ask, whatever your rules or mode say (except in bypass mode, below):

- recursive deletes such as `rm -rf`
- force-pushes, `git reset --hard` and `git clean`
- `curl … | sh`
- `sudo`
- writes outside the project

:::

## Modes

The footer shows the current mode. Shift+Tab cycles them in this order; `--permission-mode` sets one at start and `permissions.defaultMode` in [settings](/settings) sets the default.

| Footer                    | Mode          | Behaviour                                                                                                                                              |
| ------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `⏸ manual mode on`        | `default`     | Asks before edits, commands and web access                                                                                                             |
| `⏵⏵ accept edits on`      | `acceptEdits` | Edits inside the project are approved automatically; commands still ask                                                                                |
| `⏸ plan mode on`          | `plan`        | Read-only. VinaX researches, then presents a plan for you to approve (with or without auto-accept) or send back with changes                           |
| `⏵⏵ auto mode on`         | `auto`        | Edits, commands and web access inside the project run without asking                                                                                   |
| `⊘ read-only mode on`     | `readOnly`    | Reads, searches and read-only commands (`ls`, `cat`, `grep`, `git status`/`diff`/`log`…) run; every edit and other command is refused without asking   |
| `⚠ bypass permissions on` | `bypass`      | Everything runs without asking, dangerous commands included. Only deny rules still refuse. Not in the Shift+Tab cycle unless the session started in it |

Auto mode is for letting VinaX work through a task on its own. It still stops and asks for:

- everything in the "always asked" list above (dangerous commands such as `rm -rf`, force-pushes and `sudo`)
- anything matching an ask rule; deny rules still refuse
- paths outside the project, and commands whose shell is currently in a folder outside the project
- MCP tools, which are third-party code

```bash
vinax --permission-mode auto
```

### Read-only mode

Like Codex CLI's read-only preset: VinaX can look but not touch. Edits, writes, MCP tools and any command that is not plainly read-only are refused at once with a message the model can act on, so nothing waits for you. A command counts as read-only when every part of it is a known reading program (`ls`, `cat`, `head`, `grep`, `rg`, `find` without `-delete`/`-exec`, `git status`/`diff`/`log`/`show`/`blame`, `jq`, …), nothing is redirected to a file, and there is no `$(…)`, backticks or `VAR=value` prefix. Read-only commands that mention a path outside the project still ask, as do reads outside it.

```bash
vinax --read-only            # same as --permission-mode readOnly
vinax -p --read-only "explain the auth flow"
```

### Bypass mode

The equivalent of Claude Code's `--dangerously-skip-permissions` and Codex's `--yolo`: every edit, command and web request runs without asking, including the "always asked" list. Deny rules still refuse. VinaX shows a warning when the session starts and the footer turns red.

```bash
vinax --yolo                 # also --dangerously-skip-permissions or --permission-mode bypass
```

Bypass mode is refused when VinaX runs as root (a bad command could damage the whole machine). In a disposable container, set `VINAX_ALLOW_ROOT_BYPASS=1`. Combine it with the [sandbox](#sandbox) so commands cannot write outside the project.

## Sandbox

The `sandbox` setting (or `--sandbox <mode>`) confines what Bash commands can do at the operating-system level, like Codex CLI's sandbox. It is off by default.

| Mode              | Commands may write                                            | Network |
| ----------------- | ------------------------------------------------------------- | ------- |
| `off`             | anywhere your user can                                        | yes     |
| `workspace-write` | the project, `--add-dir` folders, temp folders and `~/.vinax` | yes     |
| `read-only`       | temp folders only                                             | no      |

On macOS VinaX runs each command through `sandbox-exec` with a Seatbelt profile; on Linux it uses [bubblewrap](https://github.com/containers/bubblewrap) (`bwrap`) when it is installed. Where no sandbox is available (Linux without `bwrap`, Windows) and the setting is not `off`, VinaX warns at start and the Bash tool **refuses** to run commands rather than running them unconfined. `/permissions` shows the sandbox in use.

```json
{ "sandbox": "workspace-write" }
```

```bash
vinax --yolo --sandbox workspace-write   # run everything, but only write inside the project
```

The sandbox applies to the Bash tool (and `!` commands); file tools are governed by permissions and the workspace. Package managers that write caches in your home folder (`~/.npm`, `~/.cache`) may fail under `workspace-write`; add the folder with `--add-dir` if you need it. In a [worktree](/worktrees) the main checkout's `.git` folder is writable too, so commits work.

## Rules

Rules live in [settings](/settings) under `permissions.allow`, `ask` and `deny`, or come from `--allowedTools` and `--disallowedTools`. **Deny always wins**, then ask, then allow.

```json
{
  "permissions": {
    "allow": ["Bash(npm test:*)", "Bash(git status)", "Edit(src/**)"],
    "deny": ["Bash(git push:*)", "Read(*.env)"]
  }
}
```

| Rule                                 | Matches                                                           |
| ------------------------------------ | ----------------------------------------------------------------- |
| `Bash(npm run test:*)`               | `npm run test`, `npm run test -- -u`: a prefix on a word boundary |
| `Bash(git log *)`                    | `*` is a wildcard; a trailing ` *` also matches plain `git log`   |
| `Edit(src/**)`                       | Edits and writes under `src/`, relative to the project root       |
| `Read(*.env)`                        | That file name at any depth                                       |
| `Read(~/notes/**)`, `Edit(//tmp/**)` | Home-relative and absolute paths                                  |
| `WebFetch(domain:github.com)`        | A domain and its subdomains                                       |
| `mcp__github__*`                     | Every tool from one MCP server                                    |

A compound command such as `a && b | c` is allowed only when **every** part matches an allow rule. Commands containing `$(…)` or backticks always ask.

### Managing rules with `/permissions`

`/permissions` (also `/allowed-tools` and `/approvals`) shows the mode and every rule in effect under Allow, Ask and Deny, with where each came from. Then it offers to:

- **Add an allow, ask or deny rule.** The rule is checked, saved where you choose (this project only for you in `.vinax/settings.local.json`, this project shared in `.vinax/settings.json`, or all your projects in `~/.vinax/settings.json`) and applied straight away.
- **Remove a rule**, picked from a searchable list. It is removed from the session and from your settings files.
- **Change the permission mode** for this session.

## Rewind

Press **Esc Esc** on an empty prompt (or run `/rewind`) and pick an earlier prompt. You can restore the conversation, the files, or both. To undo a single file instead, use [Review changes](/interactive-mode#reviewing-changes) (`Ctrl+G`).

What rewind covers:

- **Files changed through VinaX's own file tools** (Edit, MultiEdit, Write). Before a tool changes a file, VinaX saves its content; after the tool runs, it records what it wrote.
- **Not shell commands.** Effects of `Bash` and `!` commands (installs, generated or deleted files, git operations) are not checkpointed and are never undone. The picker says how many commands ran since the prompt you chose.
- A file VinaX **cannot read** (no permission, a folder, or not UTF-8 text) is never changed by its file tools, because the change could not be undone. The tool reports why instead.

### Edits made outside VinaX

Before restoring, VinaX compares each file with what it last wrote. If you (or a shell command, or another program) changed a file since then, or between two of VinaX's turns, nothing is changed yet. The picker lists those files with why and how much would change, and asks:

- **Keep my versions**, and restore only the other files,
- **Overwrite them too**, after copying your current versions to a backup folder,
- **Show what restoring would change** (the diff), or
- **Cancel**.

Sessions from older VinaX versions did not record what was written, so their files are shown as `? not verified` and handled the same way.

### Backups and failures

Every file is copied before it is restored, to `~/.vinax/projects/<folder>/rewind-backups/<time>-turn<n>/` with a `manifest.json` listing where each copy came from. The 20 newest backups are kept. If writing a file fails partway, the files already restored are put back, the conversation is left as it was, and the message says what happened (and where the backup is if putting files back also failed).

Checkpoints are saved with the session, so rewind also works after `vinax -c`.
