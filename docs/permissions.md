# Permissions

<p class="lead">What VinaX may do without asking, how to change that, and how to undo changes.</p>

Reading inside the project is always allowed. Edits, commands, network access, MCP tools, and reads outside the project ask first.

## Approval prompts

When VinaX needs approval, it shows what it wants to do: the command, the diff, or the URL. You can answer:

1. **Yes.**
2. **Yes, and don't ask again.** This allows a suggested rule, such as `Bash(npm test:*)`, either for this session or for this project (saved to `.vinax/settings.local.json`). For edits, you can instead auto-accept edits for the rest of the session.
3. **No, and tell VinaX what to do differently.** Your note goes to the model and it carries on. Esc just stops.

:::warning Always asked
These always ask, whatever your rules or mode say:

- recursive deletes such as `rm -rf`
- force-pushes, `git reset --hard` and `git clean`
- `curl … | sh`
- `sudo`
- writes outside the project

:::

## Modes

The footer shows the current mode. Shift+Tab cycles them in this order; `--permission-mode` sets one at start and `permissions.defaultMode` in [settings](/settings) sets the default.

| Footer               | Mode          | Behaviour                                                                                                                    |
| -------------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `⏸ manual mode on`   | `default`     | Asks before edits, commands and web access                                                                                   |
| `⏵⏵ accept edits on` | `acceptEdits` | Edits inside the project are approved automatically; commands still ask                                                      |
| `⏸ plan mode on`     | `plan`        | Read-only. VinaX researches, then presents a plan for you to approve (with or without auto-accept) or send back with changes |
| `⏵⏵ auto mode on`    | `auto`        | Edits, commands and web access inside the project run without asking                                                         |

Auto mode is for letting VinaX work through a task on its own. It still stops and asks for:

- everything in the "always asked" list above (dangerous commands such as `rm -rf`, force-pushes and `sudo`)
- anything matching an ask rule; deny rules still refuse
- paths outside the project, and commands whose shell is currently in a folder outside the project
- MCP tools, which are third-party code

```bash
vinax --permission-mode auto
```

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

`/permissions` (also `/allowed-tools`) shows the mode and every rule in effect under Allow, Ask and Deny, with where each came from. Then it offers to:

- **Add an allow, ask or deny rule.** The rule is checked, saved where you choose (this project only for you in `.vinax/settings.local.json`, this project shared in `.vinax/settings.json`, or all your projects in `~/.vinax/settings.json`) and applied straight away.
- **Remove a rule**, picked from a searchable list. It is removed from the session and from your settings files.
- **Change the permission mode** for this session.

## Rewind

Press **Esc Esc** on an empty prompt (or run `/rewind`) and pick an earlier prompt. You can restore:

- the conversation, the files, or both
- only files changed through VinaX's own file tools (Edit, MultiEdit, Write), not files changed by shell commands

Checkpoints are saved with the session, so rewind also works after `vinax -c`.
