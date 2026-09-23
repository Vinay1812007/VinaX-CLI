# CLI reference

<p class="lead">Every <code>vinax</code> command and flag.</p>

## Commands

| Command                           | What it does                                                                      |
| --------------------------------- | --------------------------------------------------------------------------------- |
| `vinax`                           | Start interactive mode in the current folder                                      |
| `vinax "prompt"`                  | Start interactive mode with a first prompt                                        |
| `vinax -p "prompt"`               | Answer once and exit ([print mode](/print-mode)); piped stdin is added as context |
| `vinax -c`                        | Continue the most recent conversation in this folder                              |
| `vinax -r [id]`                   | Resume a conversation (a picker without an id)                                    |
| `vinax login <groq\|openrouter>`  | Store a provider key; it's checked live first                                     |
| `vinax login --gateway <url>`     | Connect to a [VinaX gateway](/gateway)                                            |
| `vinax logout <groq\|openrouter>` | Remove a stored key                                                               |
| `vinax logout --gateway`          | Disconnect the gateway and delete its token                                       |
| `vinax update [--check]`          | Update to the latest release, or only check                                       |
| `vinax doctor`                    | Check the installation, keys, search, shell, terminal and gateway                 |
| `vinax config …`                  | View and edit settings and keys (below)                                           |
| `vinax mcp …`                     | Manage [MCP servers](/mcp) (below)                                                |

## Flags

| Flag                                      | Meaning                                                               |
| ----------------------------------------- | --------------------------------------------------------------------- |
| `-p, --print`                             | Answer once without the interactive UI, then exit                     |
| `--output-format text\|json\|stream-json` | Print-mode output format (default `text`)                             |
| `--model <provider:model>`                | Model to try first, e.g. `groq:openai/gpt-oss-120b`                   |
| `--permission-mode <mode>`                | Start in `default`, `acceptEdits` or `plan`                           |
| `--allowedTools <rules>`                  | Allow without asking, e.g. `"Bash(npm test:*),Edit"`                  |
| `--disallowedTools <rules>`               | Never allow, e.g. `"Bash(git push:*)"`                                |
| `--add-dir <path>`                        | Also let tools work in this folder (repeatable)                       |
| `--max-turns <n>`                         | Stop after this many model calls per prompt                           |
| `-c, --continue`                          | Continue the most recent conversation in this folder                  |
| `-r, --resume [session-id]`               | Resume a conversation                                                 |
| `--verbose`                               | Write a debug log of every request to `~/.vinax/logs/`, keys redacted |
| `-v, --version`                           | Print the version                                                     |
| `-h, --help`                              | Show help                                                             |

## vinax config

| Subcommand                                         | What it does                                                 |
| -------------------------------------------------- | ------------------------------------------------------------ |
| `list`                                             | Effective settings, and the files they come from             |
| `get <key>`                                        | One effective setting, e.g. `router.maxRetries`              |
| `set <key> <value> [--scope user\|project\|local]` | Set a value; JSON such as `3`, `true` or `["a"]` is parsed   |
| `unset <key> [--scope …]`                          | Remove a value                                               |
| `keys`                                             | Which keys are configured (masked) and where each comes from |
| `set-key <provider> [--no-verify]`                 | Store a key; reads it from stdin when piped                  |
| `remove-key <provider>`                            | Delete a stored key                                          |

## vinax mcp

| Subcommand                        | What it does                                                      |
| --------------------------------- | ----------------------------------------------------------------- |
| `add <name> <url>`                | Add a remote server (`--transport http\|sse`, `-H "Name: value"`) |
| `add <name> -- <command> [args…]` | Add a server VinaX starts (`-e KEY=VALUE`)                        |
| `list`                            | Start each server and report its tools                            |
| `remove <name>`                   | Remove a server                                                   |

`add` and `remove` take `--scope user` (default) or `--scope project`.

## Exit codes

| Code  | Meaning     |
| ----- | ----------- |
| `0`   | Success     |
| `1`   | Failure     |
| `2`   | Usage error |
| `130` | Interrupted |
