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

Shift+Tab cycles the modes. `--permission-mode` sets one at start.

| Mode          | Behaviour                                                                                                                    |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `default`     | Asks before edits and commands                                                                                               |
| `acceptEdits` | Edits inside the project are approved automatically; commands still ask                                                      |
| `plan`        | Read-only. VinaX researches, then presents a plan for you to approve (with or without auto-accept) or send back with changes |

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

A compound command such as `a && b | c` is allowed only when **every** part matches an allow rule. Commands containing `$(…)` or backticks always ask. `/permissions` lists the rules in effect and where each came from.

## Rewind

Press **Esc Esc** on an empty prompt (or run `/rewind`) and pick an earlier prompt. You can restore:

- the conversation, the files, or both
- only files changed through VinaX's own file tools (Edit, MultiEdit, Write), not files changed by shell commands

Checkpoints are saved with the session, so rewind also works after `vinax -c`.
