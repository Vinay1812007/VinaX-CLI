# Usage, budgets and cost

<p class="lead">What a task used, how to cap it, and what it cost when the price is actually known.</p>

## Reported and estimated tokens

VinaX keeps two kinds of token counts apart everywhere it shows them:

- **Reported:** the provider counted them and sent the numbers with its response.
- **Estimated:** the provider sent no count (some do not), or the response was cut off by an interruption or a time budget. VinaX then counts about four characters per token for the output, and the request it sent for the input.

You see them in the transcript (`Ctrl+O`, under each prompt), in `/usage`, in the summary printed when you leave, and in [print mode](/print-mode)'s JSON (`usage` and `estimated_usage`).

## Budgets

A budget caps one **task**: a prompt and everything VinaX does for it, including the tokens of [sub-agents](/sub-agents) it starts. Each new prompt gets a fresh budget.

```json
{ "budget": { "tokens": 60000, "seconds": 300 } }
```

or for one run: `vinax --token-budget 60000 --time-budget 300`.

- **Tokens.** Reported and estimated tokens both count. Before each model request VinaX checks whether it would go over the budget, and stops instead of sending it.
- **Time.** When the time is up, the request or command in progress is stopped (commands are killed with everything they started).

When a budget stops a task, the status line shows `⏹ stopped at the budget`, a notice says what was used, and everything done so far is kept. Send a message to continue, or raise the limit. While a token budget is set, the status line shows the tokens used so far, for example `● working 0:42 · 12K/60K tokens`. In print mode the run ends with exit code `1` and `"subtype": "error"`.

## When a task goes in circles

VinaX notices a task that stops making progress:

- the same tool call (same tool, same input) **failing** again and again,
- the same call returning the **same result** again and again,
- five model replies in a row whose tool calls all failed.

The model is warned first (a note is added to the tool result telling it to change course). If it keeps going, the task stops with `⟲ stopped: going in circles` and a notice explaining which call repeated, its last error, and what to do: tell VinaX what to try instead, run the failing command yourself with `!`, or rewind with `Esc Esc`. Polling a background command with `BashOutput` does not count.

## Cost

VinaX shows a dollar amount only from **explicit prices**:

1. `pricing` in your [settings](/settings), in US dollars per million tokens:

   ```json
   {
     "pricing": {
       "groq:openai/gpt-oss-120b": { "inputPerMillion": 0.15, "outputPerMillion": 0.6 }
     }
   }
   ```

2. a fixed price the provider publishes in its model catalog (OpenRouter does; variable prices are ignored).

Anything else is shown as **unknown**, never guessed: `$0.0123 + unknown more (no price for groq:openai/gpt-oss-20b)`. A `≈` in front means part of the tokens were estimated. Free models priced at zero show `$0.00`.

## Fallbacks and model limits

When a request moves to another model, a notice says why (`Groq 429: rate limited — switched to openrouter:…`), and `Ctrl+O` lists the fallbacks of each prompt with their reasons. VinaX also says once per session when a model in use limits what it can do: a model without native tool calling (VinaX then drives its tools through a text protocol), or one whose context window is smaller than the request about to be sent.
