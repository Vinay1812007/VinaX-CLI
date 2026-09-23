# Hooks

<p class="lead">Run your own shell commands at points in the agent loop, to block actions, add context, or keep VinaX working.</p>

## Configure

Hooks go in any [settings file](/settings); lists from every file are combined. `disableAllHooks: true` turns them all off, and `/hooks` shows what's active.

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash", "hooks": [{ "type": "command", "command": ".vinax/hooks/guard.sh" }] }
    ],
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [
          {
            "type": "command",
            "command": "npx prettier --write \"$(jq -r .tool_input.file_path)\""
          }
        ]
      }
    ],
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "git log --oneline -5" }] }]
  }
}
```

`matcher` is a tool name, a `|`-separated list, or a regular expression. Leave it out to match everything. Each hook can set `timeout` in seconds (default 60).

## Events

| Event              | When                                             | Can                                              |
| ------------------ | ------------------------------------------------ | ------------------------------------------------ |
| `PreToolUse`       | Before a tool runs, after its input is validated | Block it, or approve it without a prompt         |
| `PostToolUse`      | After a tool runs                                | Send feedback to the model                       |
| `UserPromptSubmit` | When you send a prompt                           | Block it, or add context                         |
| `Stop`             | When VinaX is about to finish                    | Block, and tell it to keep going (up to 3 times) |
| `SessionStart`     | On start, `-c`/`-r` resume, and `/clear`         | Add context (whatever it prints)                 |

## Input and output

Each hook gets the event as JSON on stdin. Fields include `hook_event_name`, `session_id`, `cwd`, `permission_mode`, `tool_name`, `tool_input`, `tool_response` and `prompt`, depending on the event.

| Exit code     | Effect                                                                          |
| ------------- | ------------------------------------------------------------------------------- |
| `0`           | Continue. For `UserPromptSubmit` and `SessionStart`, stdout is added as context |
| `2`           | Block. stderr is sent to the model (or shown to you, for a blocked prompt)      |
| anything else | Continue, and show a warning                                                    |

A hook can print JSON instead:

```json
{ "decision": "block", "reason": "Use pnpm, not npm", "additionalContext": "…" }
```

`decision` is `block` or `approve`. An approval never overrides a deny rule or VinaX's built-in dangerous-command check.

## Example: block deletes

```bash
#!/bin/sh
# .vinax/hooks/guard.sh — refuse rm in Bash commands
if grep -q '"command":"rm '; then
  echo "Deleting files is disabled in this repository. Ask the user to do it." >&2
  exit 2
fi
exit 0
```

In the transcript it shows as:

<pre class="vx-terminal"><span class="accent">▸</span> Bash rm -rf build
  <span class="dim">└ Blocked by a hook</span></pre>
