# Architecture

VinaX is a pnpm monorepo with a strict one-way dependency: the CLI uses the core, and the core
knows nothing about the terminal UI.

```
packages/cli ─────────► packages/core ─────────► Groq / OpenRouter (direct, your keys)
 Ink UI, commands,       settings, secrets,  └──► apps/gateway (optional) ─► Groq / OpenRouter
 print mode, login,      providers, router,
 update                  agent loop, tools,
                         permissions, hooks,
                         MCP, sessions
```

| Package            | Contents                                                                                            |
| ------------------ | --------------------------------------------------------------------------------------------------- |
| `packages/core`    | Everything testable without a terminal. It exports the `.ts` source, and the CLI bundle includes it |
| `packages/cli`     | The `vinax` executable: commander entry, the Ink app, slash commands, print mode, login, update     |
| `packages/testkit` | A scriptable mock OpenAI-compatible server and a demo MCP server, used by the tests                 |
| `apps/gateway`     | The Hono relay deployed to Render (see [gateway.md](gateway.md))                                    |

## One agent turn

1. **Prompt.** The `UserPromptSubmit` hooks run first; they can block the prompt or add context.
   The prompt is recorded in the session file, and a checkpoint mark is set for rewind.
2. **Context.** If the conversation is past 85% of its budget, VinaX first trims old tool outputs,
   then asks the small model for a structured summary.
3. **Model call.** The router picks the first model in the chain whose rate-limit ledger allows the
   request. It waits briefly or skips the model, retries transient errors with jittered backoff,
   and falls back down the chain. It never switches once output has started. Tool calls arrive
   natively, or as `<vx:call>` blocks in the text protocol for models that can't call tools.
4. **Tools.** Each call is validated with zod; errors go back to the model. `PreToolUse` hooks run
   next. Then the permission engine decides, in this order: deny rules, then the dangerous-command
   check, then ask and allow rules, then the mode's default. Read-only calls run in parallel.
   Edits are checkpointed. `PostToolUse` hooks can add feedback.
5. **Loop.** Results go back to the model until it answers without tool calls. `Stop` hooks can
   send it back to work.

The loop reports progress as a stream of typed events: text, tool calls and results, notices,
fallbacks and waits. The Ink UI and `vinax -p` consume the same stream, so the two modes can't
drift apart.

## Where state lives

| Path                                                 | Contents                                          |
| ---------------------------------------------------- | ------------------------------------------------- |
| `~/.vinax/settings.json`                             | User settings (also `gateway.url`)                |
| `.vinax/settings.json`, `.vinax/settings.local.json` | Project and personal project settings             |
| OS keychain, or `~/.vinax/credentials.json`          | Provider keys and the gateway token (mode 0600)   |
| `~/.vinax/projects/<folder>/sessions/*.jsonl`        | Conversations; checkpoint contents in `blobs/`    |
| `~/.vinax/state.json`                                | Onboarding, trusted folders, approved MCP servers |
| `~/.vinax/cache/`                                    | Model catalogs (24 h)                             |
| `~/.vinax/mcp.json`, `.vinax/mcp.json`               | MCP servers                                       |

`VINAX_HOME` moves `~/.vinax` elsewhere.

The design notes and trade-offs behind all this are in [PLAN.md](https://github.com/Vinay1812007/VinaX-CLI/blob/main/docs/PLAN.md).
