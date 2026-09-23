# Print mode and scripts

<p class="lead">Run VinaX once without the interactive UI: in pipes, scripts and CI.</p>

```bash
vinax -p "explain the difference between map and flatMap"
git diff | vinax -p "write a commit message for this diff"
vinax -p "fix the failing test" --allowedTools "Bash(npm test:*)" --permission-mode acceptEdits
vinax -p "summarize src/" --output-format stream-json --max-turns 10
```

Piped input is added to the prompt as context.

## Approvals in print mode

Nobody can answer an approval prompt in print mode. An action that would need approval fails with a hint naming the `--allowedTools` rule that would allow it, and the model carries on without it. Pre-approve what the task needs:

```bash
vinax -p "run the tests and fix failures" \
  --allowedTools "Bash(npm test:*),Edit" \
  --disallowedTools "Bash(git push:*)"
```

## Output formats

::::tabs
== text
The answer only, on stdout. Notices such as fallbacks and waits go to stderr.
== json
One result object when the run ends:

```json
{
  "type": "result",
  "subtype": "success",
  "is_error": false,
  "result": "…",
  "model": "groq:openai/gpt-oss-120b",
  "usage": { "input_tokens": 5120, "output_tokens": 410 },
  "session_id": "20260923-110440-18d19d",
  "num_turns": 3,
  "tool_calls": 2,
  "fallbacks": [],
  "duration_ms": 8420
}
```

== stream-json
One JSON event per line (NDJSON) as the run happens:

- `system` (init)
- `text`
- `tool_use`
- `tool_result`
- `notice` (`fallback`, `wait`, `retry`, `status`, `info`)
- a final `result`, the same object `json` prints

::::

## Exit codes

| Code  | Meaning                                                                      |
| ----- | ---------------------------------------------------------------------------- |
| `0`   | Success                                                                      |
| `1`   | Failure: no keys, bad settings, every model failed, or `--max-turns` reached |
| `2`   | Usage error (a bad flag or argument)                                         |
| `130` | Interrupted with Ctrl+C                                                      |

All flags are in the [CLI reference](/cli-reference).
