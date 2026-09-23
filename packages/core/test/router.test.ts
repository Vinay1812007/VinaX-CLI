import { describe, expect, it } from 'vitest';
import {
  AbortError,
  AllModelsFailedError,
  backoffDelay,
  DEFAULT_SETTINGS,
  formatModelRef,
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
  },
};

const rl = (provider: ProviderName, retryAfterMs?: number): ProviderError =>
  new ProviderError('rate_limit', `${provider} 429: slow down`, provider, 429, retryAfterMs);

function setup(groq: Record<string, Step[]>, openrouter: Record<string, Step[]> = {}) {
  const sleeps: number[] = [];
  const clock = { t: 0 };
  const ledger = new RateLimitLedger(
    () => 30,
    () => clock.t,
  );
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
