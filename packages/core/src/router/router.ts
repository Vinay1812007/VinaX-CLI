import type { ResolvedSettings } from '../config/schema.js';
import { estimateTokens } from '../context/tokens.js';
import { noopLogger, type Logger } from '../log/logger.js';
import { ProviderError, providerLabel, toProviderError } from '../providers/errors.js';
import type { RateLimitLedger } from '../providers/ratelimit.js';
import {
  formatModelRef,
  parseModelRef,
  type ChatMessage,
  type ModelRef,
  type Provider,
  type ProviderName,
  type ToolSpec,
  type Usage,
} from '../providers/types.js';
import { AbortError, backoffDelay, sleep as defaultSleep } from './backoff.js';

/** Output tokens assumed when the caller sets no `maxTokens`; counts against tokens-per-minute. */
const DEFAULT_OUTPUT_RESERVE = 1024;

export type RouterEvent =
  | { type: 'attempt'; ref: ModelRef }
  | { type: 'wait'; ref: ModelRef; ms: number; reason: string }
  | { type: 'retry'; ref: ModelRef; attempt: number; delayMs: number; reason: string }
  | { type: 'fallback'; from: ModelRef; to: ModelRef; reason: string }
  | { type: 'text'; text: string }
  | { type: 'tool_call_delta'; index: number; id?: string; name?: string; argsChunk?: string }
  | { type: 'done'; ref: ModelRef; usage: Usage | undefined };

/** What to send to one particular model (e.g. native tools vs. the text tool protocol). */
export interface PreparedRequest {
  messages: readonly ChatMessage[];
  tools?: readonly ToolSpec[];
}

export interface LinkFailure {
  ref: ModelRef;
  reason: string;
}

export class AllModelsFailedError extends Error {
  constructor(readonly failures: readonly LinkFailure[]) {
    super(
      failures.length === 0
        ? 'No models are available: configure an API key or a model.'
        : `Every model in the fallback chain failed:\n${failures
            .map((f) => `  • ${formatModelRef(f.ref)}: ${f.reason}`)
            .join('\n')}`,
    );
    this.name = 'AllModelsFailedError';
  }
}

/** The stream broke after output was already shown, so a transparent fallback is impossible. */
export class StreamInterruptedError extends Error {
  constructor(
    readonly ref: ModelRef,
    override readonly cause: ProviderError,
  ) {
    super(`${formatModelRef(ref)} stopped mid-response: ${cause.message}`);
    this.name = 'StreamInterruptedError';
  }
}

/** Reads the flag through a call so TypeScript does not narrow it across awaits. */
function isAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

export interface RouteRequest {
  messages: readonly ChatMessage[];
  signal: AbortSignal;
  maxTokens?: number;
  /** `small` routes titles/summaries/compaction to the cheaper model first. */
  purpose?: 'main' | 'small';
  /** Overrides the head of the chain (e.g. `--model`). */
  model?: string;
  /** Builds the request per model; defaults to `messages` with no tools. */
  prepare?: (ref: ModelRef) => PreparedRequest;
  /**
   * Called when a model rejects or garbles tool calls. Return true after switching that model to
   * a different tool mode, and the same model is retried once straight away.
   */
  onToolFormatError?: (ref: ModelRef) => boolean;
}

export interface RouterDeps {
  providers: ReadonlyMap<ProviderName, Provider>;
  ledger: RateLimitLedger;
  settings: ResolvedSettings;
  logger?: Logger;
  /** Model refs to leave out, e.g. ones missing from the provider catalog. */
  skip?: ReadonlySet<string>;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
  now?: () => number;
}

/**
 * Streams a completion from the first model in the chain that can serve it. Before each send it
 * consults the rate-limit ledger (wait briefly or skip), retries transient errors with backoff,
 * and falls back down the chain. It never falls back once output has been emitted.
 */
export class Router {
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly random: () => number;
  private readonly now: () => number;
  private readonly logger: Logger;

  constructor(private readonly deps: RouterDeps) {
    this.sleep = deps.sleep ?? defaultSleep;
    this.random = deps.random ?? Math.random;
    this.now = deps.now ?? Date.now;
    this.logger = deps.logger ?? noopLogger;
  }

  chain(purpose: 'main' | 'small' = 'main', override?: string): ModelRef[] {
    const s = this.deps.settings;
    const head = override ?? s.model;
    const refs =
      purpose === 'small' ? [s.smallModel, head, ...s.fallbackChain] : [head, ...s.fallbackChain];
    const unique = [...new Set(refs)].filter((r) => !(this.deps.skip?.has(r) ?? false));
    return unique.map(parseModelRef);
  }

  private retryDelay(err: ProviderError, attempt: number): number | undefined {
    const { maxRetries, baseDelayMs, maxDelayMs, maxWaitMs } = this.deps.settings.router;
    if (attempt >= maxRetries) return undefined;
    switch (err.kind) {
      case 'rate_limit':
        if (err.retryAfterMs !== undefined)
          return err.retryAfterMs <= maxWaitMs ? err.retryAfterMs : undefined;
        return backoffDelay(attempt, { baseMs: baseDelayMs, maxMs: maxDelayMs }, this.random);
      case 'server':
      case 'timeout':
      case 'network':
        return backoffDelay(attempt, { baseMs: baseDelayMs, maxMs: maxDelayMs }, this.random);
      default:
        return undefined;
    }
  }

  async *stream(req: RouteRequest): AsyncGenerator<RouterEvent> {
    const { providers, ledger, settings } = this.deps;
    const prepare = req.prepare ?? ((): PreparedRequest => ({ messages: req.messages }));
    const failures: LinkFailure[] = [];
    let pendingFallback: LinkFailure | undefined;

    for (const ref of this.chain(req.purpose, req.model)) {
      const provider = providers.get(ref.provider);
      if (!provider) {
        failures.push({ ref, reason: `no ${providerLabel(ref.provider)} API key configured` });
        continue;
      }
      const first = prepare(ref);
      const est =
        estimateTokens(first.messages, first.tools) + (req.maxTokens ?? DEFAULT_OUTPUT_RESERVE);
      const decision = ledger.check(ref.provider, ref.model, est);
      if (decision.waitMs > settings.router.maxWaitMs) {
        const failure = {
          ref,
          reason: `${providerLabel(ref.provider)} ${decision.reason ?? 'rate limited'}`,
        };
        failures.push(failure);
        pendingFallback = failure;
        continue;
      }
      if (pendingFallback) {
        yield {
          type: 'fallback',
          from: pendingFallback.ref,
          to: ref,
          reason: pendingFallback.reason,
        };
      }
      if (decision.waitMs > 0) {
        yield { type: 'wait', ref, ms: decision.waitMs, reason: decision.reason ?? 'rate limit' };
        await this.sleep(decision.waitMs, req.signal);
      }

      let toolFormatRetried = false;
      for (let attempt = 0; ; attempt++) {
        if (req.signal.aborted) throw new AbortError();
        yield { type: 'attempt', ref };
        ledger.recordRequest(ref.provider, ref.model);
        let emitted = false;
        let usage: Usage | undefined;
        try {
          const prepared = prepare(ref);
          const deltas = provider.stream({
            model: ref.model,
            messages: prepared.messages,
            signal: req.signal,
            ...(prepared.tools === undefined ? {} : { tools: prepared.tools }),
            ...(req.maxTokens === undefined ? {} : { maxTokens: req.maxTokens }),
          });
          for await (const d of deltas) {
            if (d.type === 'usage') {
              usage = d.usage;
              continue;
            }
            emitted = true;
            yield d;
          }
          yield { type: 'done', ref, usage };
          return;
        } catch (raw) {
          const err = toProviderError(raw, ref.provider, this.now());
          if (err.kind === 'aborted' || isAborted(req.signal)) throw new AbortError();
          if (emitted) throw new StreamInterruptedError(ref, err);
          if (
            err.kind === 'tool_format' &&
            !toolFormatRetried &&
            req.onToolFormatError?.(ref) === true
          ) {
            toolFormatRetried = true;
            yield {
              type: 'retry',
              ref,
              attempt: attempt + 1,
              delayMs: 0,
              reason: `${err.message} — retrying with the text tool protocol`,
            };
            attempt--;
            continue;
          }
          const delay = this.retryDelay(err, attempt);
          this.logger.debug('router.failure', {
            ref: formatModelRef(ref),
            kind: err.kind,
            attempt,
            retryInMs: delay,
          });
          if (delay !== undefined) {
            yield { type: 'retry', ref, attempt: attempt + 1, delayMs: delay, reason: err.message };
            await this.sleep(delay, req.signal);
            continue;
          }
          const failure = { ref, reason: err.message };
          failures.push(failure);
          pendingFallback = failure;
          break;
        }
      }
    }
    throw new AllModelsFailedError(failures);
  }
}
