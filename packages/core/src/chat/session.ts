import { estimateTokens } from '../context/tokens.js';
import type { ModelCatalog } from '../providers/catalog.js';
import type { RateLimitLedger } from '../providers/ratelimit.js';
import type { ChatMessage, ModelRef, Provider, ProviderName, Usage } from '../providers/types.js';
import { AbortError } from '../router/backoff.js';
import type { Router, RouterEvent } from '../router/router.js';

/** Used when the catalog does not report a context window. */
const FALLBACK_CONTEXT_WINDOW = 32_768;
/** Share of a tokens-per-minute limit one request may use (it must fit in a single minute). */
const TPM_SHARE = 0.75;

export const INTERRUPTED_MARKER = '[interrupted by the user]';

export interface TurnOutcome {
  status: 'done' | 'interrupted' | 'failed';
  text: string;
  ref: ModelRef | undefined;
  usage: Usage | undefined;
  error?: string;
}

/**
 * The context a request can really use: the model's window, capped by its tokens-per-minute
 * limit when the provider reports one (Groq free tier: ~8K TPM, so ~6K usable).
 */
export async function effectiveContextWindow(
  ref: ModelRef,
  deps: {
    providers: ReadonlyMap<ProviderName, Provider>;
    catalog: ModelCatalog;
    ledger: RateLimitLedger;
  },
): Promise<number> {
  let window = FALLBACK_CONTEXT_WINDOW;
  const provider = deps.providers.get(ref.provider);
  if (provider) {
    try {
      const { models } = await deps.catalog.get(provider);
      window = models.find((m) => m.id === ref.model)?.contextWindow ?? window;
    } catch {
      // keep the fallback
    }
  }
  const tpm = deps.ledger.snapshot(ref.provider, ref.model)?.tokens.limit;
  return tpm === undefined ? window : Math.min(window, Math.floor(tpm * TPM_SHARE));
}

/**
 * A multi-turn conversation without tools. Keeps the message history and records partial
 * answers when a turn is interrupted, so the model sees what it already said.
 */
export class ChatSession {
  private readonly turns: ChatMessage[] = [];

  constructor(
    private readonly router: Router,
    private readonly systemPrompt: string,
  ) {}

  get messages(): ChatMessage[] {
    return [{ role: 'system', content: this.systemPrompt }, ...this.turns];
  }

  contextTokens(): number {
    return estimateTokens(this.messages);
  }

  clear(): void {
    this.turns.length = 0;
  }

  async send(
    prompt: string,
    opts: { signal: AbortSignal; model?: string; onEvent: (ev: RouterEvent) => void },
  ): Promise<TurnOutcome> {
    this.turns.push({ role: 'user', content: prompt });
    let text = '';
    let ref: ModelRef | undefined;
    let usage: Usage | undefined;
    try {
      const events = this.router.stream({
        messages: this.messages,
        signal: opts.signal,
        ...(opts.model === undefined ? {} : { model: opts.model }),
      });
      for await (const ev of events) {
        if (ev.type === 'text') text += ev.text;
        if (ev.type === 'attempt') ref = ev.ref;
        if (ev.type === 'done') usage = ev.usage;
        opts.onEvent(ev);
      }
      this.turns.push({ role: 'assistant', content: text });
      return { status: 'done', text, ref, usage };
    } catch (err) {
      if (err instanceof AbortError) {
        this.turns.push({
          role: 'assistant',
          content: text === '' ? INTERRUPTED_MARKER : `${text}\n\n${INTERRUPTED_MARKER}`,
        });
        return { status: 'interrupted', text, ref, usage };
      }
      if (text !== '') this.turns.push({ role: 'assistant', content: text });
      else this.turns.pop(); // nothing was answered; let the user simply ask again
      return {
        status: 'failed',
        text,
        ref,
        usage,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
