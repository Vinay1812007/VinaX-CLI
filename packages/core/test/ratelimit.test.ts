import { describe, expect, it } from 'vitest';
import {
  parseDuration,
  parseRateLimitHeaders,
  parseRetryAfter,
  RateLimitLedger,
} from '../src/index.js';

describe('parseDuration', () => {
  it.each([
    ['7.66s', 7660],
    ['2m59.56s', 179_560],
    ['1h2m', 3_720_000],
    ['450ms', 450],
    ['12', 12_000],
    ['soon', undefined],
    ['5x', undefined],
  ])('%s → %s', (input, expected) => {
    expect(parseDuration(input)).toBe(expected);
  });
});

describe('parseRetryAfter', () => {
  it('reads seconds, milliseconds and HTTP dates', () => {
    const now = Date.parse('2026-09-23T10:00:00Z');
    expect(parseRetryAfter(new Headers({ 'retry-after': '3' }), now)).toBe(3000);
    expect(parseRetryAfter(new Headers({ 'retry-after-ms': '250' }), now)).toBe(250);
    expect(
      parseRetryAfter(new Headers({ 'retry-after': 'Wed, 23 Sep 2026 10:00:10 GMT' }), now),
    ).toBe(10_000);
    expect(parseRetryAfter(new Headers(), now)).toBeUndefined();
  });
});

describe('parseRateLimitHeaders', () => {
  it('parses Groq headers with duration resets', () => {
    const h = new Headers({
      'x-ratelimit-limit-requests': '1000',
      'x-ratelimit-remaining-requests': '998',
      'x-ratelimit-reset-requests': '2m52.8s',
      'x-ratelimit-limit-tokens': '8000',
      'x-ratelimit-remaining-tokens': '1200',
      'x-ratelimit-reset-tokens': '6.5s',
    });
    expect(parseRateLimitHeaders('groq', h, 1000)).toEqual({
      requests: { limit: 1000, remaining: 998, resetAt: 1000 + 172_800 },
      tokens: { limit: 8000, remaining: 1200, resetAt: 1000 + 6500 },
    });
  });

  it('parses OpenRouter headers with epoch-ms resets', () => {
    const h = new Headers({
      'x-ratelimit-limit': '20',
      'x-ratelimit-remaining': '0',
      'x-ratelimit-reset': '1790000000000',
    });
    expect(parseRateLimitHeaders('openrouter', h, 0).requests).toEqual({
      limit: 20,
      remaining: 0,
      resetAt: 1_790_000_000_000,
    });
  });
});

describe('RateLimitLedger.check', () => {
  const setup = (rpm = 30): { ledger: RateLimitLedger; clock: { t: number } } => {
    const clock = { t: 1_000_000 };
    return {
      ledger: new RateLimitLedger(
        () => rpm,
        () => clock.t,
      ),
      clock,
    };
  };

  it('allows a request with no history', () => {
    const { ledger } = setup();
    expect(ledger.check('groq', 'm', 500)).toEqual({ waitMs: 0 });
  });

  it('waits for the RPM window to slide', () => {
    const { ledger, clock } = setup(2);
    ledger.recordRequest('groq', 'm');
    clock.t += 10_000;
    ledger.recordRequest('groq', 'm');
    clock.t += 5_000;
    expect(ledger.check('groq', 'm', 10)).toEqual({
      waitMs: 45_000,
      reason: 'is at its 2 requests/min limit',
    });
    clock.t += 45_000;
    expect(ledger.check('groq', 'm', 10).waitMs).toBe(0);
  });

  it('waits for the token bucket to refill', () => {
    const { ledger } = setup();
    ledger.observe(
      'groq',
      'm',
      new Headers({
        'x-ratelimit-limit-tokens': '8000',
        'x-ratelimit-remaining-tokens': '900',
        'x-ratelimit-reset-tokens': '12s',
      }),
    );
    expect(ledger.check('groq', 'm', 800).waitMs).toBe(0);
    expect(ledger.check('groq', 'm', 2000)).toEqual({
      waitMs: 12_000,
      reason: 'tokens/min budget is used up',
    });
  });

  it('flags requests larger than the whole per-minute budget as impossible', () => {
    const { ledger } = setup();
    ledger.observe('groq', 'm', new Headers({ 'x-ratelimit-limit-tokens': '8000' }));
    const d = ledger.check('groq', 'm', 9100);
    expect(d.waitMs).toBe(Number.POSITIVE_INFINITY);
    expect(d.reason).toBe(
      "can't take this request (~9.1K tokens exceeds its 8.0K tokens/min limit)",
    );
  });

  it('honours retry-after and exhausted daily quotas', () => {
    const { ledger, clock } = setup();
    ledger.observe('groq', 'm', new Headers({ 'retry-after': '4' }));
    expect(ledger.check('groq', 'm', 1).waitMs).toBe(4000);
    ledger.observe(
      'openrouter',
      'x:free',
      new Headers({
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': String(clock.t + 3_600_000),
      }),
    );
    expect(ledger.check('openrouter', 'x:free', 1)).toEqual({
      waitMs: 3_600_000,
      reason: 'request quota is used up',
    });
  });
});
