# Settings

<p class="lead">Where settings live, how they combine, and every key you can set.</p>

## Settings files

Settings are JSON. They merge from lowest to highest precedence:

1. `~/.vinax/settings.json`: yours, in every project
2. `.vinax/settings.json`: the project's; commit it
3. `.vinax/settings.local.json`: yours, for this project only. VinaX adds it to `.gitignore`
4. Command-line flags

Permission rule lists (`permissions.allow`, `ask`, `deny`) and hooks **add up** across files. Every other key is overridden by later files. Unknown keys produce a warning, and invalid values are rejected with the exact key and reason.

## Edit from the shell

```bash
vinax config list                                  # effective settings and where they come from
vinax config get router.maxRetries
vinax config set model groq:openai/gpt-oss-20b     # --scope user|project|local (default: user)
vinax config set fallbackChain '["openrouter:qwen/qwen3.8-27b:free"]' --scope project
vinax config unset model
```

`/config` shows the same view inside a session.

## Example

```json
{
  "model": "groq:openai/gpt-oss-120b",
  "fallbackChain": ["openrouter:qwen/qwen3.8-27b:free"],
  "permissions": {
    "allow": ["Bash(npm test:*)", "Edit(src/**)"],
    "deny": ["Bash(git push:*)"],
    "defaultMode": "default"
  },
  "context": { "maxTokens": 24000 },
  "theme": "dark"
}
```

## All settings

| Key                                       | Default                    | Meaning                                                     |
| ----------------------------------------- | -------------------------- | ----------------------------------------------------------- |
| `model`                                   | `groq:openai/gpt-oss-120b` | Main model                                                  |
| `smallModel`                              | `groq:openai/gpt-oss-20b`  | Model for titles, summaries and compaction                  |
| `fallbackChain`                           | see [Models](/models)      | Models tried after the main one                             |
| `providers.<name>.enabled`                | `true`                     | Turn a provider off                                         |
| `providers.<name>.baseUrl`                | the provider's API         | Point a provider at another OpenAI-compatible endpoint      |
| `providers.<name>.rpm`                    | `30` Groq, `20` OpenRouter | Requests per minute to allow locally                        |
| `router.maxRetries`                       | `2`                        | Retries on one model before falling back                    |
| `router.baseDelayMs`, `router.maxDelayMs` | `1000`, `20000`            | Backoff range                                               |
| `router.maxWaitMs`                        | `20000`                    | Longest wait for a rate-limit window before falling back    |
| `router.requestTimeoutMs`                 | `90000`                    | Request timeout                                             |
| `permissions.allow` / `ask` / `deny`      | `[]`                       | [Permission rules](/permissions#rules)                      |
| `permissions.defaultMode`                 | `default`                  | `default`, `acceptEdits` or `plan`                          |
| `permissions.additionalDirectories`       | `[]`                       | Extra folders tools may work in                             |
| `context.maxTokens`                       | `24000`                    | Conversation budget; compaction starts at 85%               |
| `context.autoCompact`                     | `true`                     | Compact automatically                                       |
| `hooks`                                   | `{}`                       | [Hooks](/hooks)                                             |
| `disableAllHooks`                         | `false`                    | Turn every hook off                                         |
| `gateway.url`                             | none                       | A [VinaX gateway](/gateway), set by `vinax login --gateway` |
| `gateway.timeoutMs`                       | `120000`                   | Longest wait for a sleeping gateway to wake                 |
| `theme`                                   | `dark`                     | `dark`, `light` or `colorblind`                             |
| `editorMode`                              | `normal`                   | `normal` or `vim`                                           |

## Environment variables

| Variable                             | Effect                                                         |
| ------------------------------------ | -------------------------------------------------------------- |
| `GROQ_API_KEY`, `OPENROUTER_API_KEY` | Provider keys; take precedence over stored keys                |
| `VINAX_GATEWAY_TOKEN`                | Gateway token; takes precedence over the stored one            |
| `VINAX_HOME`                         | Moves `~/.vinax`                                               |
| `VINAX_SECRETS_BACKEND=file`         | Skip the OS keychain; keep keys in `~/.vinax/credentials.json` |
| `VINAX_GIT_BASH_PATH`                | Windows: the Git Bash to run commands with                     |
| `NO_COLOR`                           | Turn off all colour                                            |
