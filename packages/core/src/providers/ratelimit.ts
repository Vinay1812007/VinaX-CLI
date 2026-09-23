import type { ProviderName } from './types.js';

export interface Bucket {
  limit?: number;
  remaining?: number;
  /** Epoch ms when the bucket refills. */
  resetAt?: number;
}

export interface RateLimitSnapshot {
  /** Groq: requests per day. OpenRouter: the account's current request window. */
  requests: Bucket;
  /** Groq only: tokens per minute. */
  tokens: Bucket;
  /** Set after a 429 that carried `retry-after`. */
  blockedUntil?: number;
  updatedAt: number;
}

/** Parses Go-style durations used by Groq ("2m59.56s", "7.66s", "1h2m", "450ms") or plain seconds. */
export function parseDuration(value: string): number | undefined {
  const v = value.trim();
  if (/^\d+(\.\d+)?$/.test(v)) return Math.round(Number(v) * 1000);
  const re = /(\d+(?:\.\d+)?)(ms|h|m|s)/g;
  let total = 0;
  let consumed = 0;
  for (const m of v.matchAll(re)) {
    const n = Number(m[1]);
    const unit = m[2];
    total += unit === 'h' ? n * 3_600_000 : unit === 'm' ? n * 60_000 : unit === 's' ? n * 1000 : n;
    consumed += m[0].length;
  }
  return consumed === v.length && consumed > 0 ? Math.round(total) : undefined;
}

function num(headers: Headers, name: string): number | undefined {
  const raw = headers.get(name);
  if (raw === null || raw.trim() === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/** Milliseconds to wait according to `retry-after-ms` / `retry-after` (seconds or HTTP date). */
export function parseRetryAfter(headers: Headers, now: number): number | undefined {
  const ms = num(headers, 'retry-after-ms');
  if (ms !== undefined) return Math.max(0, ms);
  const raw = headers.get('retry-after');
  if (raw === null) return undefined;
  const secs = Number(raw);
  if (Number.isFinite(secs)) return Math.max(0, Math.round(secs * 1000));
  const date = Date.parse(raw);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

export function parseRateLimitHeaders(
  provider: ProviderName,
  headers: Headers,
  now: number,
): Pick<RateLimitSnapshot, 'requests' | 'tokens'> {
  if (provider === 'groq') {
    const reset = (name: string): number | undefined => {
      const raw = headers.get(name);
      const d = raw === null ? undefined : parseDuration(raw);
      return d === undefined ? undefined : now + d;
    };
    return {
      requests: {
        limit: num(headers, 'x-ratelimit-limit-requests'),
        remaining: num(headers, 'x-ratelimit-remaining-requests'),
        resetAt: reset('x-ratelimit-reset-requests'),
      },
      tokens: {
        limit: num(headers, 'x-ratelimit-limit-tokens'),
        remaining: num(headers, 'x-ratelimit-remaining-tokens'),
        resetAt: reset('x-ratelimit-reset-tokens'),
      },
    };
  }
  // OpenRouter: X-RateLimit-Reset is an epoch timestamp in milliseconds.
  return {
    requests: {
      limit: num(headers, 'x-ratelimit-limit'),
      remaining: num(headers, 'x-ratelimit-remaining'),
      resetAt: num(headers, 'x-ratelimit-reset'),
    },
    tokens: {},
  };
}

export interface WaitDecision {
  waitMs: number;
  reason?: string;
}

function compact(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}K` : String(n);
}

function stripUndefined(b: Bucket): Bucket {
  const out: Bucket = {};
  if (b.limit !== undefined) out.limit = b.limit;
  if (b.remaining !== undefined) out.remaining = b.remaining;
  if (b.resetAt !== undefined) out.resetAt = b.resetAt;
  return out;
}

/**
 * Tracks what each provider/model has left, from response headers plus a local sliding window
 * for requests-per-minute (Groq's headers report the daily request budget, not RPM).
 * The router asks `check()` before sending, so we wait or fall back instead of causing a 429.
 */
export class RateLimitLedger {
  private readonly snapshots = new Map<string, RateLimitSnapshot>();
  private readonly recent = new Map<string, number[]>();

  constructor(
    private readonly rpmFor: (provider: ProviderName) => number,
    private readonly now: () => number = Date.now,
  ) {}

  static key(provider: ProviderName, model: string): string {
    return `${provider}:${model}`;
  }

  observe(provider: ProviderName, model: string, headers: Headers): void {
    const now = this.now();
    const parsed = parseRateLimitHeaders(provider, headers, now);
    const key = RateLimitLedger.key(provider, model);
    const prev = this.snapshots.get(key);
    const snap: RateLimitSnapshot = {
      requests: { ...prev?.requests, ...stripUndefined(parsed.requests) },
      tokens: { ...prev?.tokens, ...stripUndefined(parsed.tokens) },
      updatedAt: now,
    };
    const retryAfter = parseRetryAfter(headers, now);
    if (retryAfter !== undefined) snap.blockedUntil = now + retryAfter;
    this.snapshots.set(key, snap);
  }

  recordRequest(provider: ProviderName, model: string): void {
    const key = RateLimitLedger.key(provider, model);
    const list = this.recent.get(key) ?? [];
    list.push(this.now());
    this.recent.set(key, list);
  }

  snapshot(provider: ProviderName, model: string): RateLimitSnapshot | undefined {
    return this.snapshots.get(RateLimitLedger.key(provider, model));
  }

  entries(): [string, RateLimitSnapshot][] {
    return [...this.snapshots.entries()];
  }

  /** How long to wait before sending ~`estTokens` to this model; `Infinity` means it cannot fit. */
  check(provider: ProviderName, model: string, estTokens: number): WaitDecision {
    const now = this.now();
    const key = RateLimitLedger.key(provider, model);
    const waits: WaitDecision[] = [];

    const window = (this.recent.get(key) ?? []).filter((t) => t > now - 60_000);
    this.recent.set(key, window);
    const rpm = this.rpmFor(provider);
    const oldest = window[0];
    if (window.length >= rpm && oldest !== undefined) {
      waits.push({
        waitMs: oldest + 60_000 - now,
        reason: `is at its ${String(rpm)} requests/min limit`,
      });
    }

    const snap = this.snapshots.get(key);
    if (snap) {
      if (snap.blockedUntil !== undefined && snap.blockedUntil > now) {
        const secs = Math.ceil((snap.blockedUntil - now) / 1000);
        waits.push({
          waitMs: snap.blockedUntil - now,
          reason: `is rate-limited for another ${String(secs)}s`,
        });
      }
      const { tokens, requests } = snap;
      if (tokens.limit !== undefined && estTokens > tokens.limit) {
        waits.push({
          waitMs: Number.POSITIVE_INFINITY,
          reason: `can't take this request (~${compact(estTokens)} tokens exceeds its ${compact(tokens.limit)} tokens/min limit)`,
        });
      } else if (
        tokens.remaining !== undefined &&
        tokens.resetAt !== undefined &&
        tokens.resetAt > now &&
        tokens.remaining < estTokens
      ) {
        waits.push({ waitMs: tokens.resetAt - now, reason: 'tokens/min budget is used up' });
      }
      if (requests.remaining === 0 && requests.resetAt !== undefined && requests.resetAt > now) {
        waits.push({ waitMs: requests.resetAt - now, reason: 'request quota is used up' });
      }
    }

    return waits.reduce<WaitDecision>((a, b) => (b.waitMs > a.waitMs ? b : a), { waitMs: 0 });
  }
}
