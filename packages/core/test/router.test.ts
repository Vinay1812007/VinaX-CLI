import { describe, expect, it } from 'vitest';
import {
  AbortError,
  AllModelsFailedError,
  backoffDelay,
  cooldownNote,
  DEFAULT_SETTINGS,
  formatModelRef,
  MODEL_COOLDOWN_MS,
  ProviderError,
  RateLimitLedger,
  Router,
  StreamInterruptedError,
  type ChatRequest,
  type Provider,
  type ProviderName,
  type ResolvedSettings,
  type RouterEvent,
  type StreamDelta,
} from '../src/index.js';

type Step =
  { text: string[] } | { error: ProviderError } | { textThenError: [string, ProviderError] };

/** A provider whose replies are scripted per model; records every call. */
class FakeProvider implements Provider {
  readonly calls: string[] = [];
  constructor(
    readonly name: ProviderName,
    private readonly script: Record<string, Step[]>,
  ) {}
  listModels = (): Promise<never[]> => Promise.resolve([]);
  validateKey = (): Promise<{ ok: true }> => Promise.resolve({ ok: true });
  async *stream(req: ChatRequest): AsyncGenerator<StreamDelta> {
    this.calls.push(req.model);
    const step = this.script[req.model]?.shift();
    if (!step) throw new ProviderError('server', `no script for ${req.model}`, this.name, 500);
    await Promise.resolve();
    if ('error' in step) throw step.error;
    if ('textThenError' in step) {
      yield { type: 'text', text: step.textThenError[0] };
      throw step.textThenError[1];
    }
    for (const t of step.text) yield { type: 'text', text: t };
    yield { type: 'usage', usage: { promptTokens: 5, completionTokens: step.text.length } };
  }
}

const settings: ResolvedSettings = {
  ...DEFAULT_SETTINGS,
  model: 'groq:main',
  smallModel: 'groq:small',
  fallbackChain: ['groq:backup', 'openrouter:free-a:free'],
  router: {
    maxRetries: 2,
    baseDelayMs: 100,
    maxDelayMs: 1000,
    maxWaitMs: 5000,
    requestTimeoutMs: 1000,
    firstTokenTimeoutMs: 1000,
  },
};

const rl = (provider: ProviderName, retryAfterMs?: number): ProviderError =>
  new ProviderError('rate_limit', `${provider} 429: slow down`, provider, 429, retryAfterMs);

it('auto discovers a configured provider outside the default chain and skips non-chat models', async () => {
  const provider = new FakeProvider('gemini', { 'gemini-test': [{ text: ['ok'] }] });
  const router = new Router({
    settings,
    ledger: new RateLimitLedger(),
    providers: new Map([['gemini', provider]]),
    models: new Map([
      [
        'gemini',
        [
          { id: 'embed-v1', contextWindow: undefined, supportsTools: undefined, free: false },
          { id: 'gemini-test', contextWindow: undefined, supportsTools: undefined, free: false },
        ],
      ],
    ]),
  });
  expect(router.chain('main', 'auto').map(formatModelRef)).toEqual(['gemini:gemini-test']);
  const result: RouterEvent[] = [];
  for await (const event of router.stream({
    model: 'auto',
    messages: [],
    signal: new AbortController().signal,
  }))
    result.push(event);
  expect(result).toContainEqual({ type: 'text', text: 'ok' });
});

function setup(groq: Record<string, Step[]>, openrouter: Record<string, Step[]> = {}) {
  const sleeps: number[] = [];
  const clock = { t: 0 };
  const ledger = new RateLimitLedger(() => clock.t);
  const providers = new Map<ProviderName, Provider>([
    ['groq', new FakeProvider('groq', groq)],
    ['openrouter', new FakeProvider('openrouter', openrouter)],
  ]);
  const router = new Router({
    providers,
    ledger,
    settings,
    random: () => 0.5,
    now: () => clock.t,
    sleep: (ms) => {
      sleeps.push(ms);
      clock.t += ms;
      return Promise.resolve();
    },
  });
  return { router, ledger, sleeps, providers, clock };
}

async function collect(gen: AsyncGenerator<RouterEvent>): Promise<RouterEvent[]> {
  const out: RouterEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

const req = (extra: Partial<Parameters<Router['stream']>[0]> = {}) => ({
  messages: [{ role: 'user' as const, content: 'hi' }],
  signal: new AbortController().signal,
  ...extra,
});

const summarize = (events: RouterEvent[]): string[] =>
  events.map((e) => {
    switch (e.type) {
      case 'attempt':
        return `attempt ${formatModelRef(e.ref)}`;
      case 'text':
        return `text ${e.text}`;
      case 'retry':
        return `retry ${formatModelRef(e.ref)} in ${e.delayMs}ms`;
      case 'wait':
        return `wait ${formatModelRef(e.ref)} ${e.ms}ms`;
      case 'fallback':
        return `fallback ${formatModelRef(e.from)} → ${formatModelRef(e.to)}`;
      case 'done':
        return `done ${formatModelRef(e.ref)}`;
      case 'tool_call_delta':
        return `tool ${e.name ?? ''}${e.argsChunk ?? ''}`;
      case 'status':
        return `status ${e.text}`;
      case 'reasoning':
        return `reasoning ${e.text}`;
    }
  });

describe('backoffDelay', () => {
  it('grows exponentially, is capped, and keeps at least half the delay', () => {
    const opts = { baseMs: 100, maxMs: 1000 };
    expect(backoffDelay(0, opts, () => 0)).toBe(50);
    expect(backoffDelay(0, opts, () => 1)).toBe(100);
    expect(backoffDelay(2, opts, () => 1)).toBe(400);
    expect(backoffDelay(10, opts, () => 1)).toBe(1000);
    expect(backoffDelay(10, opts, () => 0)).toBe(500);
  });
});

describe('Router', () => {
  it('builds main and small chains without duplicates', () => {
    const { router } = setup({});
    expect(router.chain('main').map(formatModelRef)).toEqual([
      'groq:main',
      'groq:backup',
      'openrouter:free-a:free',
    ]);
    expect(router.chain('small').map(formatModelRef)).toEqual([
      'groq:small',
      'groq:main',
      'groq:backup',
      'openrouter:free-a:free',
    ]);
    expect(router.chain('main', 'groq:backup').map(formatModelRef)).toEqual([
      'groq:backup',
      'openrouter:free-a:free',
    ]);
  });

  it('routes plan mode to planModel, and like a normal turn when none is set', () => {
    const { router } = setup({});
    expect(router.chain('plan').map(formatModelRef)).toEqual(
      router.chain('main').map(formatModelRef),
    );
    const withPlan = new Router({
      settings: { ...settings, planModel: 'groq:thinker' },
      ledger: new RateLimitLedger(),
      providers: new Map(),
    });
    expect(withPlan.chain('plan').map(formatModelRef)).toEqual([
      'groq:thinker',
      'groq:main',
      'groq:backup',
      'openrouter:free-a:free',
    ]);
    // Only plan turns get it; ordinary and small turns are untouched.
    expect(withPlan.chain('main').map(formatModelRef)[0]).toBe('groq:main');
    expect(withPlan.chain('small').map(formatModelRef)[0]).toBe('groq:small');
  });

  it('puts discovered free models ahead of paid ones across providers in auto mode', () => {
    const model = (id: string, free: boolean) => ({
      id,
      contextWindow: undefined,
      supportsTools: undefined,
      free,
    });
    const router = new Router({
      settings: { ...settings, model: 'groq:main', fallbackChain: [] },
      ledger: new RateLimitLedger(),
      providers: new Map([
        ['groq', {} as never],
        ['nvidia', {} as never],
      ]),
      // Groq is walked first and has a paid model; without a global free-first grouping it would
      // outrank NVIDIA's free ones purely because its provider comes first.
      models: new Map([
        ['groq', [model('main', false), model('groq-paid', false)]],
        ['nvidia', [model('nv-free-a', true), model('nv-free-b', true)]],
      ]),
    });
    expect(router.chain('main', 'auto').map(formatModelRef)).toEqual([
      'groq:main',
      'nvidia:nv-free-a',
      'nvidia:nv-free-b',
      'groq:groq-paid',
    ]);
  });

  it('streams from the head of the chain', async () => {
    const { router } = setup({ main: [{ text: ['Hel', 'lo'] }] });
    const events = await collect(router.stream(req()));
    expect(summarize(events)).toEqual([
      'attempt groq:main',
      'text Hel',
      'text lo',
      'done groq:main',
    ]);
    expect(events.at(-1)).toMatchObject({ usage: { promptTokens: 5, completionTokens: 2 } });
  });

  it('retries a short retry-after on the same model, then succeeds', async () => {
    const { router, sleeps } = setup({ main: [{ error: rl('groq', 2000) }, { text: ['ok'] }] });
    const events = await collect(router.stream(req()));
    expect(summarize(events)).toEqual([
      'attempt groq:main',
      'retry groq:main in 2000ms',
      'attempt groq:main',
      'text ok',
      'done groq:main',
    ]);
    expect(sleeps).toEqual([2000]);
  });

  it('uses jittered exponential backoff for server errors', async () => {
    const err = new ProviderError('server', 'groq 503', 'groq', 503);
    const { router, sleeps } = setup({ main: [{ error: err }, { error: err }, { text: ['ok'] }] });
    await collect(router.stream(req()));
    expect(sleeps).toEqual([75, 150]);
  });

  it('falls back across providers when retry-after is too long', async () => {
    const { router, sleeps } = setup(
      { main: [{ error: rl('groq', 60_000) }], backup: [{ error: rl('groq', 60_000) }] },
      { 'free-a:free': [{ text: ['from openrouter'] }] },
    );
    const events = await collect(router.stream(req()));
    expect(summarize(events)).toEqual([
      'attempt groq:main',
      'fallback groq:main → groq:backup',
      'attempt groq:backup',
      'fallback groq:backup → openrouter:free-a:free',
      'attempt openrouter:free-a:free',
      'text from openrouter',
      'done openrouter:free-a:free',
    ]);
    expect(sleeps).toEqual([]);
    const fb = events.find((e) => e.type === 'fallback');
    expect(fb).toMatchObject({ reason: 'groq 429: slow down' });
  });

  it('skips a model whose token budget cannot fit, without sending', async () => {
    const { router, ledger, providers } = setup({ backup: [{ text: ['ok'] }] });
    ledger.observe('groq', 'main', new Headers({ 'x-ratelimit-limit-tokens': '100' }));
    const events = await collect(router.stream(req()));
    expect(summarize(events)).toEqual([
      'fallback groq:main → groq:backup',
      'attempt groq:backup',
      'text ok',
      'done groq:backup',
    ]);
    expect((providers.get('groq') as FakeProvider).calls).toEqual(['backup']);
  });

  it('waits briefly for a nearly refilled token bucket instead of falling back', async () => {
    const { router, ledger, sleeps } = setup({ main: [{ text: ['ok'] }] });
    ledger.observe(
      'groq',
      'main',
      new Headers({
        'x-ratelimit-limit-tokens': '8000',
        'x-ratelimit-remaining-tokens': '0',
        'x-ratelimit-reset-tokens': '3s',
      }),
    );
    const events = await collect(router.stream(req()));
    expect(summarize(events)[0]).toBe('wait groq:main 3000ms');
    expect(sleeps).toEqual([3000]);
  });

  it('moves on immediately for non-retryable errors', async () => {
    const { router } = setup({
      main: [{ error: new ProviderError('auth', 'groq 401: bad key', 'groq', 401) }],
      backup: [{ text: ['ok'] }],
    });
    const events = await collect(router.stream(req()));
    expect(summarize(events).slice(0, 2)).toEqual([
      'attempt groq:main',
      'fallback groq:main → groq:backup',
    ]);
  });

  it('never falls back once text was emitted', async () => {
    const { router } = setup({
      main: [
        { textThenError: ['partial', new ProviderError('server', 'groq: stream reset', 'groq')] },
      ],
      backup: [{ text: ['should not be used'] }],
    });
    const events: RouterEvent[] = [];
    await expect(async () => {
      for await (const e of router.stream(req())) events.push(e);
    }).rejects.toThrow(StreamInterruptedError);
    expect(summarize(events)).toEqual(['attempt groq:main', 'text partial']);
  });

  it('reports every failure when the whole chain is exhausted', async () => {
    const bad = (p: ProviderName) =>
      new ProviderError('not_found', `${p} 404: no such model`, p, 404);
    const { router } = setup(
      { main: [{ error: bad('groq') }], backup: [{ error: bad('groq') }] },
      { 'free-a:free': [{ error: bad('openrouter') }] },
    );
    const err = await collect(router.stream(req())).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AllModelsFailedError);
    expect((err as AllModelsFailedError).failures.map((f) => formatModelRef(f.ref))).toEqual([
      'groq:main',
      'groq:backup',
      'openrouter:free-a:free',
    ]);
  });

  it('skips providers without a key', async () => {
    const { router, providers } = setup({ main: [{ error: rl('groq', 60_000) }] });
    providers.delete('openrouter');
    const err = await collect(router.stream(req({ model: 'groq:main' }))).catch((e: unknown) => e);
    expect((err as AllModelsFailedError).message).toContain('no OpenRouter API key configured');
  });

  it('stops with AbortError when the signal fires', async () => {
    const ac = new AbortController();
    ac.abort();
    const { router } = setup({ main: [{ text: ['x'] }] });
    await expect(collect(router.stream(req({ signal: ac.signal })))).rejects.toBeInstanceOf(
      AbortError,
    );
  });
});

describe('Router stickiness after a dead model', () => {
  const timeout = new ProviderError('timeout', 'Groq did not respond in time', 'groq');

  it('skips a model that timed out for the cooldown, then tries it first again', async () => {
    const { router, providers, clock } = setup({
      main: [{ error: timeout }, { text: ['back'] }],
      backup: [{ text: ['one'] }, { text: ['two'] }],
    });
    const first = await collect(router.stream(req()));
    const fallback = first.find((e) => e.type === 'fallback');
    expect(fallback).toMatchObject({ cooldownMs: MODEL_COOLDOWN_MS });
    // the next turn goes straight to the model that answered, and the dead one is tried last
    expect(router.chain('main').map(formatModelRef)).toEqual([
      'groq:backup',
      'openrouter:free-a:free',
      'groq:main',
    ]);
    expect(router.coolingUntil('groq:main')).toBe(MODEL_COOLDOWN_MS);
    const second = await collect(router.stream(req()));
    expect(summarize(second)).toEqual(['attempt groq:backup', 'text two', 'done groq:backup']);
    expect((providers.get('groq') as FakeProvider).calls).toEqual(['main', 'backup', 'backup']);

    clock.t += MODEL_COOLDOWN_MS;
    expect(router.coolingUntil('groq:main')).toBeUndefined();
    expect(summarize(await collect(router.stream(req())))[0]).toBe('attempt groq:main');
  });

  it('keeps an explicitly chosen model in cooldown too, until it is chosen again', async () => {
    const { router } = setup({
      main: [{ error: timeout }],
      backup: [{ text: ['ok'] }],
    });
    await collect(router.stream(req({ model: 'groq:main' })));
    expect(router.chain('main', 'groq:main').map(formatModelRef)[0]).toBe('groq:backup');
    router.clearCooldown('groq:main');
    expect(router.chain('main', 'groq:main').map(formatModelRef)[0]).toBe('groq:main');
  });

  it('does not set aside a model that was only rate-limited or rejected the request', async () => {
    const { router } = setup({
      main: [{ error: new ProviderError('bad_request', 'groq 400: nope', 'groq', 400) }],
      backup: [{ text: ['ok'] }],
    });
    const events = await collect(router.stream(req()));
    expect(events.find((e) => e.type === 'fallback')).not.toHaveProperty('cooldownMs');
    expect(router.chain('main').map(formatModelRef)[0]).toBe('groq:main');
  });

  it('leaves out models that failed their test, unless named, and never empties the chain', () => {
    const router = new Router({
      settings,
      ledger: new RateLimitLedger(),
      providers: new Map(),
      unhealthy: new Set(['groq:main', 'openrouter:free-a:free']),
    });
    expect(router.chain('main').map(formatModelRef)).toEqual(['groq:backup']);
    expect(router.chain('main', 'groq:main').map(formatModelRef)).toEqual([
      'groq:main',
      'groq:backup',
    ]);
    const allBad = new Router({
      settings: { ...settings, fallbackChain: [] },
      ledger: new RateLimitLedger(),
      providers: new Map(),
      unhealthy: new Set(['groq:main']),
    });
    expect(allBad.chain('main').map(formatModelRef)).toEqual(['groq:main']);
  });
});

describe('Router first-token timeout', () => {
  /** Never answers until aborted; can report gateway-style progress first. */
  class SilentProvider implements Provider {
    calls = 0;
    constructor(
      readonly name: ProviderName,
      private readonly statusFirstMs?: number,
    ) {}
    listModels = (): Promise<never[]> => Promise.resolve([]);
    validateKey = (): Promise<{ ok: true }> => Promise.resolve({ ok: true });
    async *stream(req: ChatRequest): AsyncGenerator<StreamDelta> {
      this.calls++;
      if (this.statusFirstMs !== undefined) {
        // a waking gateway: progress, a long pause, then the answer
        yield { type: 'status', text: 'Waking the gateway' };
        await new Promise((r) => setTimeout(r, this.statusFirstMs));
        yield { type: 'status', text: '' };
        yield { type: 'text', text: 'awake' };
        return;
      }
      await new Promise<void>((resolve) => {
        req.signal.addEventListener('abort', () => {
          resolve();
        });
      });
      throw new ProviderError('aborted', 'Request aborted', this.name);
    }
  }

  const quick = { ...settings, router: { ...settings.router, firstTokenTimeoutMs: 40 } };

  it('treats a model that sends nothing as timed out and falls back', async () => {
    const backup = new FakeProvider('openrouter', { 'free-a:free': [{ text: ['saved'] }] });
    const router = new Router({
      settings: { ...quick, fallbackChain: ['openrouter:free-a:free'] },
      ledger: new RateLimitLedger(),
      providers: new Map<ProviderName, Provider>([
        ['groq', new SilentProvider('groq')],
        ['openrouter', backup],
      ]),
    });
    const started = Date.now();
    const events = await collect(router.stream(req()));
    expect(Date.now() - started).toBeLessThan(1000);
    const fallback = events.find((e) => e.type === 'fallback');
    expect(fallback).toMatchObject({ reason: 'Groq sent nothing for 0s' });
    expect(fallback).toHaveProperty('cooldownMs');
    expect(events).toContainEqual({ type: 'text', text: 'saved' });
  });

  it('does not count time spent waking a gateway', async () => {
    const provider = new SilentProvider('groq', 100);
    const router = new Router({
      settings: { ...quick, fallbackChain: [] },
      ledger: new RateLimitLedger(),
      providers: new Map<ProviderName, Provider>([['groq', provider]]),
    });
    const events = await collect(router.stream(req()));
    expect(events).toContainEqual({ type: 'text', text: 'awake' });
    expect(provider.calls).toBe(1);
  });
});

it('says in the fallback notice how long a dead model is skipped', () => {
  const from = { provider: 'nvidia' as const, model: 'openai/gpt-oss-20b' };
  expect(cooldownNote({ from, cooldownMs: MODEL_COOLDOWN_MS })).toBe(
    ' (nvidia:openai/gpt-oss-20b is skipped for the next 10 min)',
  );
  expect(cooldownNote({ from })).toBe('');
});

describe('NVIDIA rate limits', () => {
  function nvidiaSetup(nvidia: Record<string, Step[]>) {
    const sleeps: number[] = [];
    const clock = { t: 0 };
    const ledger = new RateLimitLedger(() => clock.t);
    const groq = new FakeProvider('groq', { backup: [{ text: ['from groq'] }] });
    const router = new Router({
      providers: new Map<ProviderName, Provider>([
        ['nvidia', new FakeProvider('nvidia', nvidia)],
        ['groq', groq],
      ]),
      ledger,
      settings: { ...settings, model: 'nvidia:m', fallbackChain: ['groq:backup'] },
      random: () => 0.5,
      now: () => clock.t,
      sleep: (ms) => {
        sleeps.push(ms);
        clock.t += ms;
        return Promise.resolve();
      },
    });
    return { router, ledger, sleeps, groq };
  }

  it('waits out 429s on the same model instead of falling back, however many there are', async () => {
    const { router, sleeps, groq } = nvidiaSetup({
      m: [
        // longer than maxWaitMs, which would make any other provider fall back
        { error: rl('nvidia', 60_000) },
        ...Array.from({ length: 8 }, () => ({ error: rl('nvidia') })),
        { text: ['finally'] },
      ],
    });
    const events = await collect(router.stream(req()));
    expect(events).toContainEqual({ type: 'text', text: 'finally' });
    expect(events.some((e) => e.type === 'fallback')).toBe(false);
    expect(groq.calls).toEqual([]);
    const retries = events.filter((e) => e.type === 'retry');
    expect(retries).toHaveLength(9);
    expect(retries[0]).toMatchObject({ reason: 'waiting for the NVIDIA rate limit' });
    // Retry-After is honoured; otherwise the backoff grows but never past 30s
    expect(sleeps[0]).toBe(60_000);
    expect(Math.max(...sleeps.slice(1))).toBeLessThanOrEqual(30_000);
    expect(sleeps.at(-1)).toBeGreaterThan(sleeps[1] ?? 0);
    expect(router.coolingUntil('nvidia:m')).toBeUndefined();
  });

  it('still uses its retries for real failures after waiting out rate limits', async () => {
    const { router, groq } = nvidiaSetup({
      m: [
        { error: rl('nvidia') },
        { error: rl('nvidia') },
        { error: rl('nvidia') },
        { error: new ProviderError('server', 'NVIDIA 500: boom', 'nvidia', 500) },
        { text: ['recovered'] },
      ],
    });
    const events = await collect(router.stream(req()));
    expect(events).toContainEqual({ type: 'text', text: 'recovered' });
    expect(groq.calls).toEqual([]);
  });

  it('waits on a known NVIDIA rate limit before sending instead of skipping the model', async () => {
    const { router, ledger, sleeps, groq } = nvidiaSetup({ m: [{ text: ['ok'] }] });
    ledger.observe('nvidia', 'm', new Headers({ 'retry-after': '120' }));
    const events = await collect(router.stream(req()));
    expect(events).toContainEqual({ type: 'text', text: 'ok' });
    expect(events.some((e) => e.type === 'fallback')).toBe(false);
    expect(groq.calls).toEqual([]);
    expect(sleeps).toEqual([30_000]);
  });

  it('stops waiting when the user interrupts', async () => {
    const ac = new AbortController();
    const script = { m: Array.from({ length: 50 }, () => ({ error: rl('nvidia') })) };
    const router = new Router({
      providers: new Map<ProviderName, Provider>([['nvidia', new FakeProvider('nvidia', script)]]),
      ledger: new RateLimitLedger(),
      settings: { ...settings, model: 'nvidia:m', fallbackChain: [] },
      random: () => 0.5,
      sleep: (_ms, signal) => {
        ac.abort();
        return signal?.aborted === true ? Promise.reject(new AbortError()) : Promise.resolve();
      },
    });
    await expect(collect(router.stream(req({ signal: ac.signal })))).rejects.toBeInstanceOf(
      AbortError,
    );
  });

  it('keeps other providers falling back on a long rate limit', async () => {
    const { router } = setup({ main: [{ error: rl('groq', 60_000) }], backup: [{ text: ['b'] }] });
    const events = await collect(router.stream(req()));
    expect(events.some((e) => e.type === 'fallback')).toBe(true);
    expect(events).toContainEqual({ type: 'text', text: 'b' });
  });
});
