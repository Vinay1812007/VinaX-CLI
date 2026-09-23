# Tools

<p class="lead">The tools VinaX's agent can call, and which of them ask first.</p>

| Tool                     | What it does                                                                                        | Asks first?                      |
| ------------------------ | --------------------------------------------------------------------------------------------------- | -------------------------------- |
| `Read`                   | Reads a file with line numbers; `offset`/`limit` for long files                                     | Only outside the project         |
| `Glob`                   | Finds files by pattern, respecting `.gitignore`                                                     | No                               |
| `Grep`                   | Searches file contents with ripgrep (or a built-in search), respecting `.gitignore`                 | No                               |
| `LS`                     | Lists a folder two levels deep                                                                      | No                               |
| `Edit`, `MultiEdit`      | Replace exact text. The file must have been read first, and the edit is refused if it changed since | Yes, unless auto-accepting edits |
| `Write`                  | Creates a file, or replaces one that has been read                                                  | Yes, unless auto-accepting edits |
| `Bash`                   | Runs a command                                                                                      | Yes, unless a rule allows it     |
| `BashOutput`, `KillBash` | Read or stop a background command                                                                   | No                               |
| `TodoWrite`              | Keeps the task list shown above the prompt                                                          | No                               |
| `ExitPlanMode`           | Presents a plan for your approval in plan mode                                                      | You approve the plan             |
| `WebFetch`               | Fetches a URL, converts HTML to Markdown and answers a question about it with the small model       | Yes, per domain                  |
| `Task`                   | Runs a [sub-agent](/sub-agents)                                                                     | No (its own tools ask)           |
| `mcp__<server>__<tool>`  | Tools from [MCP servers](/mcp)                                                                      | Yes, unless a rule allows it     |

## Bash

- The working directory carries over between calls, so `cd sub` persists.
- Commands time out after 2 minutes by default (10 at most) and can run in the background.
- Interactive programs, such as editors, pagers and REPLs, are refused, because nobody can type into them.
- On Windows, commands run in Git Bash when it's installed, otherwise in PowerShell.

## WebFetch

- `http` is upgraded to `https`, except for `localhost`.
- A redirect to another host is reported instead of followed.
- Pages are cached for 15 minutes.
- Allow a site with `WebFetch(domain:docs.python.org)`.

## How tool calls appear

Each call is one line, with the result underneath. Edits show their diff:

<pre class="vx-terminal"><span class="accent">▸</span> Grep TODO
  <span class="dim">└ Found 3 files</span>
<span class="accent">▸</span> Edit src/math.js
  <span class="dim">└ Changed +1 −1 lines</span>
      4 -   return sum / (values.length - 1);
      4 +   return sum / values.length;</pre>

Read-only calls run in parallel. Every argument is validated, and mistakes go back to the model so it can correct them.
