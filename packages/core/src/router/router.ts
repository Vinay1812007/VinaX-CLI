import type { ResolvedSettings } from '../config/schema.js';
import { estimateTokens } from '../context/tokens.js';
import { noopLogger, type Logger } from '../log/logger.js';
import {
  ProviderError,
  providerLabel,
  toProviderError,
  type ProviderErrorKind,
} from '../providers/errors.js';
import type { RateLimitLedger } from '../providers/ratelimit.js';
import type { UsageTracker } from '../state/usage.js';
import {
  formatModelRef,
  parseModelRef,
  type ChatMessage,
  type ModelRef,
  type ModelInfo,
  type Provider,
  type ProviderName,
  type ReasoningEffort,
  type ToolSpec,
  type Usage,
} from '../providers/types.js';
import { AbortError, backoffDelay, sleep as defaultSleep } from './backoff.js';
import { chatModels } from '../providers/chat-models.js';
import { findCatalogModel } from '../providers/nvidia-free.js';

/** Output tokens assumed when the caller sets no `maxTokens`; counts against tokens-per-minute. */
const DEFAULT_OUTPUT_RESERVE = 1024;

export type RouterEvent =
  | { type: 'attempt'; ref: ModelRef }
  | { type: 'wait'; ref: ModelRef; ms: number; reason: string }
  | { type: 'retry'; ref: ModelRef; attempt: number; delayMs: number; reason: string }
  /**
   * The reply from `ref` broke off mid-stream and is being asked for again (same model, text
   * tool protocol, or the next model): output since the last `attempt` is void, so discard it.
   */
  | { type: 'restart'; ref: ModelRef; reason: string }
  /**
   * `cooldownMs` is set when `from` timed out or was unavailable: later requests skip it for that
   * long, so the session stays on the model that answered.
   */
  | { type: 'fallback'; from: ModelRef; to: ModelRef; reason: string; cooldownMs?: number }
  /** Progress from the provider that is not output (an empty text clears it). */
  | { type: 'status'; ref: ModelRef; text: string }
  | { type: 'text'; text: string }
  /** Reasoning the model streams before answering; not output, so fallback stays possible. */
  | { type: 'reasoning'; ref: ModelRef; text: string }
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
  /** Why the link failed: a provider error kind, no key, or the local rate-limit ledger. */
  kind: ProviderErrorKind | 'no_key' | 'local_limit';
  /** Set when the model is now skipped for a while (see {@link COOLDOWN_KINDS}). */
  cooldownMs?: number;
}

/** How long a model that timed out or was unavailable is kept out of the way. */
export const MODEL_COOLDOWN_MS = 10 * 60_000;

/**
 * Failures that say the model itself is not answering right now. A rate limit or a bad request
 * says nothing of the sort, so those models are tried again on the next turn as usual.
 */
const COOLDOWN_KINDS: ReadonlySet<LinkFailure['kind']> = new Set([
  'timeout',
  'unavailable',
  'not_found',
  'server',
]);

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

/**
 * A reply broke off mid-stream and could not be recovered: retrying, the text tool protocol and
 * every fallback were used up (or the error was not one a retry can fix). `failures` lists every
 * model that was tried, when there was more than one attempt.
 */
export class StreamInterruptedError extends Error {
  constructor(
    readonly ref: ModelRef,
    override readonly cause: ProviderError,
    readonly failures: readonly LinkFailure[] = [],
  ) {
    super(`${formatModelRef(ref)} stopped mid-response: ${cause.message}`);
    this.name = 'StreamInterruptedError';
  }
}

/**
 * Mid-reply failures worth asking again for. NVIDIA's vLLM servers send errors such as "list
 * index out of range" as an SSE event after part of the answer (kind `server`).
 */
const RESTARTABLE_KINDS: ReadonlySet<ProviderErrorKind> = new Set([
  'server',
  'network',
  'timeout',
  'unavailable',
  'tool_format',
]);

/** `<provider>:<model>` for aliases and domains too; invalid refs are left for the chain to reject. */
function canonicalRef(ref: string): string {
  try {
    return formatModelRef(parseModelRef(ref));
  } catch {
    return ref;
  }
}

/**
 * Aborts a request that has produced nothing at all after `ms`: a hung endpoint otherwise holds
 * the turn for the whole request timeout before the chain can fall back. Paused while the
 * provider reports progress of its own (a waking gateway), and stopped by the first output.
 */
class FirstTokenWatch {
  private readonly controller = new AbortController();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private live = true;
  fired = false;

  constructor(readonly ms: number) {
    this.arm();
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  arm(): void {
    if (!this.live) return;
    this.pause();
    this.timer = setTimeout(() => {
      this.fired = true;
      this.controller.abort();
    }, this.ms);
  }

  pause(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  stop(): void {
    this.live = false;
    this.pause();
  }
}

/** Drops repeats, e.g. two spellings of one NVIDIA model that resolved to the same id. */
function distinct(refs: readonly ModelRef[]): ModelRef[] {
  const seen = new Set<string>();
  return refs.filter((r) => {
    const key = formatModelRef(r);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Reads the flag through a call so TypeScript does not narrow it across awaits. */
function isAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

export interface RouteRequest {
  messages: readonly ChatMessage[];
  signal: AbortSignal;
  maxTokens?: number;
  /**
   * `small` routes titles/summaries/compaction to the cheaper model first; `plan` routes plan
   * mode to `planModel` when one is configured.
   */
  purpose?: 'main' | 'small' | 'plan';
  /** Overrides the head of the chain (e.g. `--model`). */
  model?: string;
  /** Replaces the settings' fallback chain for this request (e.g. other vision models). */
  fallbacks?: readonly string[];
  /** Try only the head of the chain (for cheap extras like titles that must not spend fallbacks). */
  noFallback?: boolean;
  /** Reasoning effort for models that support it. */
  reasoningEffort?: ReasoningEffort;
  /** Builds the request per model; defaults to `messages` with no tools. */
  prepare?: (ref: ModelRef) => PreparedRequest;
  /**
   * Called when a model rejects or garbles tool calls (`tool_format`), or its replies broke off
   * mid-stream twice (`interrupted`, often the server's tool-call parser). Return true after
   * switching that model to a different tool mode, and the same model is retried straight away.
   */
  onToolFormatError?: (ref: ModelRef, why?: 'tool_format' | 'interrupted') => boolean;
}

export interface RouterDeps {
  models?: ReadonlyMap<ProviderName, readonly ModelInfo[]>;
  providers: ReadonlyMap<ProviderName, Provider>;
  ledger: RateLimitLedger;
  settings: ResolvedSettings;
  logger?: Logger;
  /** Model refs to leave out, e.g. ones missing from the provider catalog. */
  skip?: ReadonlySet<string>;
  /**
   * Model refs that failed their last model test. Left out like `skip`, except a model the
   * request names explicitly (`--model`, `/model`) — and never down to an empty chain.
   */
  unhealthy?: ReadonlySet<string>;
  /** How long a model that timed out is moved behind the others; default {@link MODEL_COOLDOWN_MS}. */
  cooldownMs?: number;
  /** Counts requests and tokens for `/usage`. */
  usage?: UsageTracker;
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
  /** Model ref → when it may lead the chain again (it timed out or was unavailable). */
  private readonly cooling = new Map<string, number>();

  constructor(private readonly deps: RouterDeps) {
    this.sleep = deps.sleep ?? defaultSleep;
    this.random = deps.random ?? Math.random;
    this.now = deps.now ?? Date.now;
    this.logger = deps.logger ?? noopLogger;
  }

  /** Until when `ref` is moved behind the other models, if it is. */
  coolingUntil(ref: string): number | undefined {
    const until = this.cooling.get(ref);
    if (until === undefined) return undefined;
    if (until > this.now()) return until;
    this.cooling.delete(ref);
    return undefined;
  }

  /** Lets a model lead again straight away, e.g. because the user picked it by name. */
  clearCooldown(ref?: string): void {
    if (ref === undefined) this.cooling.clear();
    else this.cooling.delete(ref);
  }

  /**
   * Drops models that failed their last test (unless named explicitly) and moves models in
   * cooldown to the back, where they are still tried if everything else fails.
   */
  private arrange(refs: readonly string[], explicit: string | undefined): string[] {
    const unhealthy = this.deps.unhealthy;
    const named = explicit === undefined ? undefined : canonicalRef(explicit);
    const usable =
      unhealthy === undefined
        ? [...refs]
        : refs.filter((r) => canonicalRef(r) === named || !unhealthy.has(canonicalRef(r)));
    // every model failing its test more likely means a bad network moment than dead models
    const list = usable.length > 0 ? usable : [...refs];
    const ready = list.filter((r) => this.coolingUntil(canonicalRef(r)) === undefined);
    return [...ready, ...list.filter((r) => !ready.includes(r))];
  }

  chain(
    purpose: 'main' | 'small' | 'plan' = 'main',
    override?: string,
    fallbacks: readonly string[] = this.deps.settings.fallbackChain,
  ): ModelRef[] {
    const s = this.deps.settings;
    // The model this purpose prefers ahead of the main one. Plan mode only has one when the user
    // configured `planModel`, so by default plan mode routes exactly like a normal turn.
    const lead = purpose === 'small' ? s.smallModel : purpose === 'plan' ? s.planModel : undefined;
    if (override === 'auto') {
      const preferred = [...(lead === undefined ? [] : [lead]), s.model, ...fallbacks];
      const free: string[] = [];
      const paid: string[] = [];
      for (const [p, list] of this.deps.models ?? []) {
        for (const m of chatModels(list, p)) (m.free ? free : paid).push(`${p}:${m.id}`);
      }
      // Configured defaults come first, then discovered free models before other models. Grouping
      // this way is what makes the preference global: `chatModels` only sorts free-first inside a
      // single provider, so concatenating providers would otherwise put one provider's paid models
      // ahead of the next provider's free ones.
      const candidates = this.arrange(
        [...new Set([...preferred, ...free, ...paid])].filter((r) => !this.deps.skip?.has(r)),
        undefined,
      )
        .map((r) => this.resolve(parseModelRef(r)))
        .filter(
          (r) =>
            this.deps.providers.has(r.provider) &&
            (!this.deps.models?.has(r.provider) ||
              this.deps.models.get(r.provider)?.some((m) => m.id === r.model)),
        );
      return distinct(candidates);
    }
    const head = override ?? s.model;
    const refs = lead === undefined ? [head, ...fallbacks] : [lead, head, ...fallbacks];
    const unique = [...new Set(refs)].filter((r) => !(this.deps.skip?.has(r) ?? false));
    return distinct(this.arrange(unique, override).map((r) => this.resolve(parseModelRef(r))));
  }

  /** The catalog's spelling of `ref` (NVIDIA ids match by slug), so that is what is sent. */
  private resolve(ref: ModelRef): ModelRef {
    const list = this.deps.models?.get(ref.provider);
    const found = list === undefined ? undefined : findCatalogModel(ref.provider, list, ref.model);
    return found === undefined || found.id === ref.model ? ref : { ...ref, model: found.id };
  }

  /** Sets a model that failed aside for a while, when the failure says it is not answering. */
  private linkFailure(ref: ModelRef, err: ProviderError): LinkFailure {
    const cooldownMs = COOLDOWN_KINDS.has(err.kind)
      ? (this.deps.cooldownMs ?? MODEL_COOLDOWN_MS)
      : undefined;
    if (cooldownMs !== undefined) this.cooling.set(formatModelRef(ref), this.now() + cooldownMs);
    return {
      ref,
      reason: err.message,
      kind: err.kind,
      ...(cooldownMs === undefined ? {} : { cooldownMs }),
    };
  }

  private retryDelay(err: ProviderError, attempt: number, isLast: boolean): number | undefined {
    const { maxRetries, baseDelayMs, maxDelayMs, maxWaitMs } = this.deps.settings.router;
    if (attempt >= maxRetries) return undefined;
    switch (err.kind) {
      case 'rate_limit':
        if (err.retryAfterMs !== undefined)
          return err.retryAfterMs <= maxWaitMs ? err.retryAfterMs : undefined;
        return backoffDelay(attempt, { baseMs: baseDelayMs, maxMs: maxDelayMs }, this.random);
      case 'timeout':
        // A model that did not answer in time rarely does on a retry: move on when we can.
        if (!isLast) return undefined;
        return backoffDelay(attempt, { baseMs: baseDelayMs, maxMs: maxDelayMs }, this.random);
      case 'server':
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
    // the last reply that broke off mid-stream; reported if nothing else answers
    let interrupted: { ref: ModelRef; err: ProviderError } | undefined;

    const full = this.chain(req.purpose, req.model, req.fallbacks);
    const chain = req.noFallback === true ? full.slice(0, 1) : full;
    for (const [linkIndex, ref] of chain.entries()) {
      const provider = providers.get(ref.provider);
      if (!provider) {
        failures.push({
          ref,
          reason: `no ${providerLabel(ref.provider)} API key configured`,
          kind: 'no_key',
        });
        continue;
      }
      const first = prepare(ref);
      const est =
        estimateTokens(first.messages, first.tools) + (req.maxTokens ?? DEFAULT_OUTPUT_RESERVE);
      const decision = ledger.check(ref.provider, ref.model, est);
      if (decision.waitMs > settings.router.maxWaitMs) {
        const failure: LinkFailure = {
          ref,
          reason: `${providerLabel(ref.provider)} ${decision.reason ?? 'rate limited'}`,
          kind: 'local_limit',
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
          ...(pendingFallback.cooldownMs === undefined
            ? {}
            : { cooldownMs: pendingFallback.cooldownMs }),
        };
      }
      if (decision.waitMs > 0) {
        yield { type: 'wait', ref, ms: decision.waitMs, reason: decision.reason ?? 'rate limit' };
        await this.sleep(decision.waitMs, req.signal);
      }

      let toolFormatRetried = false;
      let breaks = 0;
      for (let attempt = 0; ; attempt++) {
        if (req.signal.aborted) throw new AbortError();
        yield { type: 'attempt', ref };
        ledger.recordRequest(ref.provider, ref.model);
        this.deps.usage?.recordRequest(ref);
        let emitted = false;
        let usage: Usage | undefined;
        const watch = new FirstTokenWatch(settings.router.firstTokenTimeoutMs);
        try {
          const prepared = prepare(ref);
          const deltas = provider.stream({
            model: ref.model,
            messages: prepared.messages,
            signal: AbortSignal.any([req.signal, watch.signal]),
            ...(prepared.tools === undefined ? {} : { tools: prepared.tools }),
            ...(req.maxTokens === undefined ? {} : { maxTokens: req.maxTokens }),
            ...(req.reasoningEffort === undefined ? {} : { reasoningEffort: req.reasoningEffort }),
          });
          for await (const d of deltas) {
            if (d.type === 'usage') {
              usage = d.usage;
              continue;
            }
            if (d.type === 'status') {
              // waiting on something else (a waking gateway) is not the model stalling
              if (d.text === '') watch.arm();
              else watch.pause();
              yield { type: 'status', ref, text: d.text };
              continue;
            }
            watch.stop();
            if (d.type === 'reasoning') {
              yield { type: 'reasoning', ref, text: d.text };
              continue;
            }
            emitted = true;
            yield d;
          }
          if (usage) this.deps.usage?.recordTokens(ref, usage);
          this.cooling.delete(formatModelRef(ref));
          yield { type: 'done', ref, usage };
          return;
        } catch (raw) {
          const err = watch.fired
            ? new ProviderError(
                'timeout',
                `${providerLabel(ref.provider)} sent nothing for ${String(Math.round(watch.ms / 1000))}s`,
                ref.provider,
              )
            : toProviderError(raw, ref.provider, this.now());
          if (err.kind === 'aborted' || isAborted(req.signal)) throw new AbortError();
          if (emitted) {
            // Part of the reply was already streamed. Tool calls only run after a complete reply,
            // so asking again is safe; consumers discard the partial output on `restart`.
            if (!RESTARTABLE_KINDS.has(err.kind))
              throw new StreamInterruptedError(ref, err, failures);
            breaks++;
            interrupted = { ref, err };
            yield { type: 'restart', ref, reason: err.message };
            if (breaks === 1 && err.kind !== 'tool_format') {
              const { baseDelayMs, maxDelayMs } = settings.router;
              const delayMs = backoffDelay(
                0,
                { baseMs: baseDelayMs, maxMs: maxDelayMs },
                this.random,
              );
              yield {
                type: 'retry',
                ref,
                attempt: attempt + 1,
                delayMs,
                reason: `${err.message} — the reply broke off`,
              };
              await this.sleep(delayMs, req.signal);
              attempt--;
              continue;
            }
            // Twice in a row usually means the server's tool-call parser (vLLM's gpt-oss one):
            // VinaX's text tool protocol avoids it.
            if (!toolFormatRetried && req.onToolFormatError?.(ref, 'interrupted') === true) {
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
            const failure = this.linkFailure(ref, err);
            failures.push(failure);
            pendingFallback = failure;
            break;
          }
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
          const delay = this.retryDelay(err, attempt, linkIndex === chain.length - 1);
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
          const cooldownMs = COOLDOWN_KINDS.has(err.kind)
            ? (this.deps.cooldownMs ?? MODEL_COOLDOWN_MS)
            : undefined;
          if (cooldownMs !== undefined)
            this.cooling.set(formatModelRef(ref), this.now() + cooldownMs);
          const failure: LinkFailure = {
            ref,
            reason: err.message,
            kind: err.kind,
            ...(cooldownMs === undefined ? {} : { cooldownMs }),
          };
          failures.push(failure);
          pendingFallback = failure;
          break;
        } finally {
          watch.stop();
        }
      }
    }
    if (interrupted) throw new StreamInterruptedError(interrupted.ref, interrupted.err, failures);
    throw new AllModelsFailedError(failures);
  }
}
