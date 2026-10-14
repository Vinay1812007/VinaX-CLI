import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { AbortError } from '../router/backoff.js';
import { chatModels, freeToTry } from './chat-models.js';
import { toProviderError, type ProviderError } from './errors.js';
import { KNOWN_MODELS } from './known-models.js';
import type { ModelInfo, Provider, ProviderName } from './types.js';

/**
 * Catalogs list far more than answers: NVIDIA's `/models` has ~80 entries, many of them
 * embeddings, retired or simply hanging. A model test sends each candidate a tiny chat request so
 * pickers and routing can stick to the ones that actually reply.
 */

export const PROBE_PROMPT = 'Reply with OK';
/** Reasoning models (gpt-oss) spend a few tokens thinking first; any 200 counts anyway. */
export const PROBE_MAX_TOKENS = 16;
export const PROBE_TIMEOUT_MS = 20_000;
export const PROBE_CONCURRENCY = 6;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/** How long a result is trusted: answers for a day, failures for a few hours, 429s briefly. */
export const PROBE_TTL_MS = {
  ok: 24 * HOUR_MS,
  failed: 6 * HOUR_MS,
  /** A rate limit says nothing about the model, so it is retested soon. */
  inconclusive: 10 * MINUTE_MS,
} as const;

/** Bumped when the stored fields change, so older files are simply retested. */
const PROBE_CACHE_VERSION = 1;

export type ProbeFailure = 'timeout' | 'auth' | 'rate_limit' | 'not_found' | 'http' | 'network';

export type ProbeResult =
  | { model: string; ok: true; at: number; ms: number }
  | {
      model: string;
      ok: false;
      at: number;
      kind: ProbeFailure;
      /** Short and user-facing, e.g. "no answer within 20s" or "HTTP 404". */
      reason: string;
      status?: number;
    };

export type FailedProbe = Extract<ProbeResult, { ok: false }>;

/** A failure that says nothing about the model itself (the provider was busy). */
export function probeInconclusive(r: ProbeResult): boolean {
  return !r.ok && r.kind === 'rate_limit';
}

/** The model did not answer, and the reason is the model's, not the moment's. */
export function probeFailed(r: ProbeResult | undefined): boolean {
  return r !== undefined && !r.ok && !probeInconclusive(r);
}

export function probeTtl(r: ProbeResult): number {
  if (r.ok) return PROBE_TTL_MS.ok;
  return probeInconclusive(r) ? PROBE_TTL_MS.inconclusive : PROBE_TTL_MS.failed;
}

/**
 * The models worth testing for a provider: chat-capable catalog entries (free ones unless
 * `freeOnly` is off) and VinaX's known models. Known models the catalog no longer lists are left
 * out, since the provider does not serve them; with no catalog at all only known models remain.
 */
export function probeCandidates(
  provider: ProviderName,
  catalog: readonly ModelInfo[] | undefined,
  opts: { freeOnly: boolean },
): string[] {
  const allowed = (info: Partial<Pick<ModelInfo, 'free' | 'pricing'>>): boolean =>
    !opts.freeOnly || freeToTry(provider, info);
  const ids = new Set<string>();
  for (const k of KNOWN_MODELS) {
    if (k.provider !== provider) continue;
    const listed = catalog?.find((m) => m.id === k.model);
    if (catalog !== undefined && listed === undefined) continue;
    if (allowed(listed ?? {})) ids.add(k.model);
  }
  for (const m of chatModels(catalog ?? [], provider)) if (allowed(m)) ids.add(m.id);
  return [...ids];
}

function failure(
  model: string,
  at: number,
  kind: ProbeFailure,
  reason: string,
  status?: number,
): ProbeResult {
  return { model, ok: false, at, kind, reason, ...(status === undefined ? {} : { status }) };
}

/** Squeezes a provider error into a few words for the picker. */
function describe(model: string, at: number, err: ProviderError): ProbeResult {
  const status = err.status;
  const http = status === undefined ? undefined : `HTTP ${String(status)}`;
  switch (err.kind) {
    case 'auth':
      return failure(model, at, 'auth', `key rejected${http ? ` (${http})` : ''}`, status);
    case 'rate_limit':
      return failure(model, at, 'rate_limit', 'rate limited', status);
    case 'not_found':
      return failure(model, at, 'not_found', http ?? 'not found', status);
    case 'timeout':
      return failure(model, at, 'timeout', 'no answer in time', status);
    case 'network':
      return failure(model, at, 'network', 'could not connect', status);
    default:
      return failure(model, at, 'http', http ?? err.message.slice(0, 80), status);
  }
}

export interface ProbeOptions {
  timeoutMs?: number;
  /** Aborting it stops the test (an `AbortError` is thrown); a timeout is just a failed result. */
  signal?: AbortSignal;
  now?: () => number;
}

/** Sends one minimal chat request; any complete answer (HTTP 200) is a pass. */
export async function probeModel(
  provider: Provider,
  model: string,
  opts: ProbeOptions = {},
): Promise<ProbeResult> {
  const now = opts.now ?? Date.now;
  const timeoutMs = opts.timeoutMs ?? PROBE_TIMEOUT_MS;
  const started = now();
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  const timedOut = (): ProbeResult =>
    failure(model, now(), 'timeout', `no answer within ${String(Math.round(timeoutMs / 1000))}s`);
  try {
    const deltas = provider
      .stream({
        model,
        messages: [{ role: 'user', content: PROBE_PROMPT }],
        maxTokens: PROBE_MAX_TOKENS,
        signal,
      })
      [Symbol.asyncIterator]();
    // Drain it: a model that sends headers and then stalls has not answered.
    while (!(await deltas.next()).done) {
      // the content does not matter, only that the answer completes
    }
  } catch (err) {
    if (opts.signal?.aborted === true) throw new AbortError();
    if (timeout.aborted) return timedOut();
    return describe(model, now(), toProviderError(err, provider.name, now()));
  }
  if (opts.signal?.aborted === true) throw new AbortError();
  // some SDKs end an aborted stream quietly instead of throwing
  if (timeout.aborted) return timedOut();
  return { model, ok: true, at: now(), ms: now() - started };
}

export interface ProbeRunOptions extends ProbeOptions {
  concurrency?: number;
  /** Called as each model finishes, e.g. for "Testing… 7/31" and to keep partial results. */
  onResult?: (result: ProbeResult, done: number, total: number) => void;
}

/** Tests `models` a few at a time; results come back in the order of `models`. */
export async function probeModels(
  provider: Provider,
  models: readonly string[],
  opts: ProbeRunOptions = {},
): Promise<ProbeResult[]> {
  const results: (ProbeResult | undefined)[] = models.map(() => undefined);
  let next = 0;
  let done = 0;
  const worker = async (): Promise<void> => {
    while (next < models.length) {
      if (opts.signal?.aborted === true) throw new AbortError();
      const index = next++;
      const model = models[index];
      if (model === undefined) return;
      const result = await probeModel(provider, model, opts);
      results[index] = result;
      done++;
      opts.onResult?.(result, done, models.length);
    }
  };
  const width = Math.max(1, Math.min(opts.concurrency ?? PROBE_CONCURRENCY, models.length));
  await Promise.all(Array.from({ length: width }, worker));
  return results.filter((r): r is ProbeResult => r !== undefined);
}

export interface ProbeSummary {
  tested: number;
  ok: number;
  /** Every model refused the key: the key is bad, not the models. */
  keyRejected: boolean;
  /**
   * Nothing answered and every failure was a timeout, connection error or rate limit, which
   * points at the network or the provider as a whole; such a run is not worth remembering.
   */
  unreachable: boolean;
}

export function summarizeProbe(results: readonly ProbeResult[]): ProbeSummary {
  const ok = results.filter((r) => r.ok).length;
  const failures = results.filter((r): r is FailedProbe => !r.ok);
  return {
    tested: results.length,
    ok,
    keyRejected:
      results.length > 0 &&
      failures.length === results.length &&
      failures.every((r) => r.kind === 'auth'),
    unreachable:
      results.length > 0 &&
      ok === 0 &&
      failures.every(
        (r) => r.kind === 'timeout' || r.kind === 'network' || r.kind === 'rate_limit',
      ),
  };
}

const resultSchema = z.discriminatedUnion('ok', [
  z.object({ model: z.string(), ok: z.literal(true), at: z.number(), ms: z.number() }),
  z.object({
    model: z.string(),
    ok: z.literal(false),
    at: z.number(),
    kind: z.enum(['timeout', 'auth', 'rate_limit', 'not_found', 'http', 'network']),
    reason: z.string(),
    status: z.number().optional(),
  }),
]);
const cacheSchema = z.object({
  version: z.number(),
  results: z.array(z.unknown()),
});

/** Test results per provider, next to the model catalogs (`probe-<provider>.json`). */
export class ProbeCache {
  constructor(
    private readonly dir: string,
    private readonly now: () => number = Date.now,
  ) {}

  private file(provider: ProviderName): string {
    return path.join(this.dir, `probe-${provider}.json`);
  }

  isFresh(r: ProbeResult): boolean {
    const age = this.now() - r.at;
    return age >= 0 && age < probeTtl(r);
  }

  /** The results still worth trusting, by model id. */
  async load(provider: ProviderName): Promise<Map<string, ProbeResult>> {
    const out = new Map<string, ProbeResult>();
    try {
      const parsed = cacheSchema.safeParse(
        JSON.parse(await fs.readFile(this.file(provider), 'utf8')),
      );
      if (!parsed.success || parsed.data.version !== PROBE_CACHE_VERSION) return out;
      for (const raw of parsed.data.results) {
        const r = resultSchema.safeParse(raw);
        if (r.success && this.isFresh(r.data)) out.set(r.data.model, r.data);
      }
    } catch {
      // no file yet, or unreadable: everything is untested
    }
    return out;
  }

  /** Adds `results` to what is stored (newer results win) and drops expired entries. */
  async save(provider: ProviderName, results: readonly ProbeResult[]): Promise<void> {
    const merged = await this.load(provider);
    for (const r of results) merged.set(r.model, r);
    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(
      this.file(provider),
      JSON.stringify({ version: PROBE_CACHE_VERSION, results: [...merged.values()] }),
      'utf8',
    );
  }

  /** Forgets a provider's results, e.g. because its key changed. */
  async clear(provider: ProviderName): Promise<void> {
    await fs.rm(this.file(provider), { force: true });
  }
}
