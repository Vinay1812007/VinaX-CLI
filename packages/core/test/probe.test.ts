import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startMockServer, type MockServer, type MockServerOptions } from '@vinax/testkit';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AbortError,
  createGatewayProvider,
  createRuntime,
  GatewayClient,
  noopLogger,
  OpenAICompatibleProvider,
  PROBE_TTL_MS,
  ProbeCache,
  NVIDIA_FREE_CHAT_MODELS,
  probeCandidates,
  probeModels,
  ProviderError,
  RateLimitLedger,
  resolveSettings,
  summarizeProbe,
  type ChatRequest,
  type ModelInfo,
  type ProbeResult,
  type Provider,
  type ProviderName,
  type StreamDelta,
} from '../src/index.js';

const servers: MockServer[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
  await Promise.all(
    dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true, maxRetries: 10 })),
  );
});

async function mock(opts: MockServerOptions): Promise<MockServer> {
  const s = await startMockServer(opts);
  servers.push(s);
  return s;
}

async function tmp(): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'vinax-probe-'));
  dirs.push(d);
  return d;
}

type Behaviour = 'ok' | 'hang' | 401 | 404 | 429 | 'statusThenOk';

/** Answers, hangs until aborted, or fails with an HTTP status, per model; counts concurrency. */
class FakeProvider implements Provider {
  inFlight = 0;
  maxInFlight = 0;
  readonly requests: ChatRequest[] = [];
  constructor(
    readonly name: ProviderName,
    private readonly behaviour: Record<string, Behaviour>,
    private readonly delayMs = 5,
  ) {}
  listModels = (): Promise<ModelInfo[]> => Promise.resolve([]);
  validateKey = (): Promise<{ ok: true }> => Promise.resolve({ ok: true });
  async *stream(req: ChatRequest): AsyncGenerator<StreamDelta> {
    this.requests.push(req);
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      const b = this.behaviour[req.model] ?? 'ok';
      await new Promise((r) => setTimeout(r, this.delayMs));
      if (b === 'hang') {
        await new Promise<void>((resolve) => {
          req.signal.addEventListener('abort', () => {
            resolve();
          });
        });
        throw new ProviderError('aborted', 'Request aborted', this.name);
      }
      if (typeof b === 'number')
        throw new ProviderError(
          b === 401 ? 'auth' : b === 404 ? 'not_found' : 'rate_limit',
          `${this.name} ${String(b)}: nope`,
          this.name,
          b,
        );
      if (b === 'statusThenOk') yield { type: 'status', text: 'waking' };
      yield { type: 'reasoning', text: 'thinking' };
      yield { type: 'text', text: 'OK' };
    } finally {
      this.inFlight--;
    }
  }
}

const info = (id: string, extra: Partial<ModelInfo> = {}): ModelInfo => ({
  id,
  contextWindow: undefined,
  supportsTools: undefined,
  free: true,
  ...extra,
});

describe('probeModels', () => {
  it('passes answers and reports timeouts, rejected keys and missing models briefly', async () => {
    const provider = new FakeProvider('nvidia', {
      good: 'ok',
      slow: 'hang',
      locked: 401,
      gone: 404,
      busy: 429,
      waking: 'statusThenOk',
    });
    const seen: number[] = [];
    const results = await probeModels(
      provider,
      ['good', 'slow', 'locked', 'gone', 'busy', 'waking'],
      {
        timeoutMs: 60,
        onResult: (_r, done) => seen.push(done),
      },
    );
    expect(results.map((r) => [r.model, r.ok ? 'ok' : r.reason])).toEqual([
      ['good', 'ok'],
      ['slow', 'no answer within 0s'],
      ['locked', 'key rejected (HTTP 401)'],
      ['gone', 'HTTP 404'],
      ['busy', 'rate limited'],
      ['waking', 'ok'],
    ]);
    expect(results.find((r) => r.model === 'slow')).toMatchObject({ ok: false, kind: 'timeout' });
    expect(seen).toEqual([1, 2, 3, 4, 5, 6]);
    // a minimal request: one short user message and a small token budget
    expect(provider.requests[0]).toMatchObject({
      messages: [{ role: 'user', content: 'Reply with OK' }],
      maxTokens: 16,
    });
    expect(summarizeProbe(results)).toEqual({
      tested: 6,
      ok: 2,
      keyRejected: false,
      unreachable: false,
    });
  });

  it('never has more than `concurrency` requests in flight', async () => {
    const provider = new FakeProvider('nvidia', {}, 20);
    const models = Array.from({ length: 9 }, (_, i) => `m${String(i)}`);
    const results = await probeModels(provider, models, { concurrency: 3 });
    expect(results).toHaveLength(9);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(provider.maxInFlight).toBe(3);
  });

  it('calls a key rejected only when every model refused it, and a dead network unreachable', async () => {
    const rejected = await probeModels(new FakeProvider('nvidia', { a: 401, b: 401 }), ['a', 'b']);
    expect(summarizeProbe(rejected)).toMatchObject({ keyRejected: true, unreachable: false });
    const mixed = await probeModels(new FakeProvider('nvidia', { a: 401, b: 'ok' }), ['a', 'b']);
    expect(summarizeProbe(mixed).keyRejected).toBe(false);
    const dead = await probeModels(new FakeProvider('nvidia', { a: 'hang', b: 429 }), ['a', 'b'], {
      timeoutMs: 30,
    });
    expect(summarizeProbe(dead)).toMatchObject({ ok: 0, unreachable: true });
  });

  it('stops when cancelled, keeping what already finished', async () => {
    const provider = new FakeProvider('nvidia', { a: 'ok', b: 'hang', c: 'hang' });
    const ac = new AbortController();
    const finished: ProbeResult[] = [];
    const run = probeModels(provider, ['a', 'b', 'c'], {
      concurrency: 1,
      signal: ac.signal,
      onResult: (r) => {
        finished.push(r);
        // cancel while `b` hangs
        setTimeout(() => {
          ac.abort();
        }, 10);
      },
    });
    await expect(run).rejects.toBeInstanceOf(AbortError);
    expect(finished.map((r) => r.model)).toEqual(['a']);
    expect(provider.requests.map((r) => r.model)).toEqual(['a', 'b']);
  });
});

describe('probeCandidates', () => {
  it('tests free chat models and known models, never embeddings or paid ones', () => {
    const catalog = [
      info('openai/gpt-oss-20b'),
      info('nvidia/nv-embedqa-e5-v5'),
      info('google/gemma-4-31b-it'),
      info('tiny', { contextWindow: 2048 }),
    ];
    // known models lead, then the catalog's chat models
    expect(probeCandidates('nvidia', catalog, { freeOnly: true })).toEqual([
      'openai/gpt-oss-20b',
      'google/gemma-4-31b-it',
    ]);
    // without a catalog only VinaX's known models remain: NVIDIA's free chat models
    expect(new Set(probeCandidates('nvidia', undefined, { freeOnly: true }))).toEqual(
      new Set(NVIDIA_FREE_CHAT_MODELS),
    );
    const priced = [
      info('free:free'),
      info('paid', { free: false, pricing: { prompt: 0.000001, completion: 0.000002 } }),
    ];
    expect(probeCandidates('openrouter', priced, { freeOnly: true })).toEqual(['free:free']);
    expect(probeCandidates('openrouter', priced, { freeOnly: false })).toEqual([
      'free:free',
      'paid',
    ]);
    // a paid-only API has nothing free to test
    expect(
      probeCandidates('openai', [info('gpt-4.1-mini', { free: false })], { freeOnly: true }),
    ).toEqual([]);
  });
});

describe('ProbeCache', () => {
  const ok = (model: string, at: number): ProbeResult => ({ model, ok: true, at, ms: 5 });
  const failed = (model: string, at: number, kind: 'timeout' | 'rate_limit'): ProbeResult => ({
    model,
    ok: false,
    at,
    kind,
    reason: kind,
  });

  it('trusts answers for a day, failures for six hours and rate limits for ten minutes', async () => {
    const dir = await tmp();
    let now = 1_000_000;
    const cache = new ProbeCache(dir, () => now);
    await cache.save('nvidia', [
      ok('a', now),
      failed('b', now, 'timeout'),
      failed('c', now, 'rate_limit'),
    ]);
    expect(
      JSON.parse(await fs.readFile(path.join(dir, 'probe-nvidia.json'), 'utf8')),
    ).toMatchObject({ version: 1 });
    const at = async (offset: number) => {
      now = 1_000_000 + offset;
      return [...(await cache.load('nvidia')).keys()];
    };
    expect(await at(0)).toEqual(['a', 'b', 'c']);
    expect(await at(PROBE_TTL_MS.inconclusive)).toEqual(['a', 'b']);
    expect(await at(PROBE_TTL_MS.failed)).toEqual(['a']);
    expect(await at(PROBE_TTL_MS.ok - 1)).toEqual(['a']);
    expect(await at(PROBE_TTL_MS.ok)).toEqual([]);
  });

  it('merges new results, ignores other versions, and forgets a provider', async () => {
    const dir = await tmp();
    const cache = new ProbeCache(dir, () => 5000);
    await cache.save('nvidia', [ok('a', 5000), failed('b', 5000, 'timeout')]);
    await cache.save('nvidia', [ok('b', 5000)]);
    expect([...(await cache.load('nvidia')).values()].map((r) => [r.model, r.ok])).toEqual([
      ['a', true],
      ['b', true],
    ]);
    await cache.save('groq', [ok('x', 5000)]);
    await cache.clear('nvidia');
    expect((await cache.load('nvidia')).size).toBe(0);
    expect((await cache.load('groq')).size).toBe(1);
    await fs.writeFile(
      path.join(dir, 'probe-groq.json'),
      JSON.stringify({ version: 99, results: [ok('x', 5000)] }),
    );
    expect((await cache.load('groq')).size).toBe(0);
  });
});

describe('model tests over HTTP', () => {
  it('sends gateway-routed probes with the provider prefix', async () => {
    const server = await mock({
      apiKeys: ['vxg_tok'],
      health: () => true,
      script: { 'nvidia:openai/gpt-oss-20b': [{ text: 'OK' }] },
    });
    const settings = resolveSettings({});
    const gateway = new GatewayClient(server.url.replace(/\/v1$/, ''), { timeoutMs: 5000 });
    const provider = createGatewayProvider('nvidia', gateway, 'vxg_tok', {
      settings,
      ledger: new RateLimitLedger(() => Infinity),
      logger: noopLogger,
    });
    const [result] = await probeModels(provider, ['openai/gpt-oss-20b']);
    expect(result?.ok).toBe(true);
    const sent = server.requests.find((r) => r.path === '/v1/chat/completions');
    expect(sent?.body).toMatchObject({ model: 'nvidia:openai/gpt-oss-20b', max_tokens: 16 });
  });

  it('verifies an NVIDIA key when any model answers, without waiting on a hung one', async () => {
    const server = await mock({
      apiKeys: ['nvapi-good'],
      script: {
        'openai/gpt-oss-20b': [{ delayMs: 3000, text: 'late' }],
        'meta/llama-3.2-11b-vision-instruct': [{ text: 'p' }],
      },
    });
    const make = (key: string, keyCheckTimeoutMs = 2000) =>
      new OpenAICompatibleProvider({
        name: 'nvidia',
        baseURL: server.url,
        apiKey: key,
        timeoutMs: 90_000,
        keyCheckTimeoutMs,
        ledger: new RateLimitLedger(() => Infinity),
        logger: noopLogger,
        keyCheck: {
          completionModels: ['openai/gpt-oss-20b', 'meta/llama-3.2-11b-vision-instruct'],
        },
      });
    const started = Date.now();
    expect(await make('nvapi-good').validateKey()).toEqual({ ok: true });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(await make('nvapi-bad').validateKey()).toEqual({
      ok: false,
      rejected: true,
      reason: 'the key was rejected',
    });
  });

  it('gives up on a key check after the short key-check timeout', async () => {
    const server = await mock({
      script: { 'openai/gpt-oss-20b': [{ delayMs: 2000, text: 'late' }] },
    });
    const provider = new OpenAICompatibleProvider({
      name: 'nvidia',
      baseURL: server.url,
      apiKey: 'nvapi-x',
      timeoutMs: 90_000,
      keyCheckTimeoutMs: 100,
      ledger: new RateLimitLedger(() => Infinity),
      logger: noopLogger,
      keyCheck: { completionModels: ['openai/gpt-oss-20b'] },
    });
    expect(await provider.validateKey()).toEqual({
      ok: false,
      rejected: false,
      reason: 'NVIDIA did not answer within 0s',
    });
  });
});

describe('runtime model tests', () => {
  async function nvidiaRuntime(opts: { model: string; script: MockServerOptions['script'] }) {
    const home = await tmp();
    const server = await mock({
      models: [
        { id: 'openai/gpt-oss-20b' },
        { id: 'google/gemma-4-31b-it' },
        { id: 'nvidia/nv-embedqa-e5-v5' },
      ],
      ...(opts.script === undefined ? {} : { script: opts.script }),
    });
    await fs.writeFile(
      path.join(home, 'settings.json'),
      JSON.stringify({
        model: opts.model,
        smallModel: opts.model,
        fallbackChain: ['nvidia:google/gemma-4-31b-it'],
        providers: {
          nvidia: { baseUrl: server.url },
          groq: { enabled: false },
          openrouter: { enabled: false },
        },
        router: { maxRetries: 0 },
      }),
    );
    const env = {
      VINAX_HOME: home,
      VINAX_SECRETS_BACKEND: 'file',
      NVIDIA_API_KEY: 'nvapi-test',
    };
    const create = () => createRuntime({ cwd: home, env, probeTimeoutMs: 500 });
    return { home, server, env, create };
  }

  it('remembers failed models, skips them in routing and warns at startup', async () => {
    const { home, create } = await nvidiaRuntime({
      model: 'nvidia:openai/gpt-oss-20b',
      script: {
        'openai/gpt-oss-20b': [{ status: 404, error: { message: 'Function not found' } }],
        'google/gemma-4-31b-it': [{ text: 'OK' }, { text: 'hello' }],
      },
    });
    const runtime = await create();
    expect(runtime.needsProbe('nvidia')).toBe(true);
    expect(runtime.probeCandidates('nvidia')).toEqual([
      'openai/gpt-oss-20b',
      'google/gemma-4-31b-it',
    ]);
    const progress: [number, number][] = [];
    const run = await runtime.probeModels('nvidia', {
      onProgress: (done, total) => progress.push([done, total]),
    });
    expect(run).toMatchObject({ tested: 2, ok: 1, keyRejected: false, unreachable: false });
    expect(progress[0]).toEqual([0, 2]);
    expect(progress.at(-1)).toEqual([2, 2]);
    expect([...runtime.unhealthy]).toEqual(['nvidia:openai/gpt-oss-20b']);
    expect(runtime.needsProbe('nvidia')).toBe(false);
    // the default model failed its test, so a turn goes straight to one that answered
    expect(runtime.router.chain('main').map((r) => r.model)).toEqual(['google/gemma-4-31b-it']);
    // …unless it is asked for by name
    expect(runtime.router.chain('main', 'nvidia:openai/gpt-oss-20b')[0]?.model).toBe(
      'openai/gpt-oss-20b',
    );
    const file = JSON.parse(
      await fs.readFile(path.join(home, 'cache', 'probe-nvidia.json'), 'utf8'),
    ) as { results: ProbeResult[] };
    expect(file.results.map((r) => [r.model, r.ok])).toEqual([
      ['openai/gpt-oss-20b', false],
      ['google/gemma-4-31b-it', true],
    ]);

    // the next start reads the results back without asking the provider again
    const next = await create();
    expect(next.unhealthy.has('nvidia:openai/gpt-oss-20b')).toBe(true);
    expect(next.warnings.join('\n')).toContain(
      'nvidia:openai/gpt-oss-20b did not answer the last model test (HTTP 404); skipping it.',
    );

    // a new key starts from scratch
    await next.forgetProbes('nvidia');
    expect(next.unhealthy.size).toBe(0);
    expect(next.needsProbe('nvidia')).toBe(true);
    await expect(fs.access(path.join(home, 'cache', 'probe-nvidia.json'))).rejects.toThrow();
  });

  it('does not keep a run where nothing answered for lack of a network', async () => {
    const { home, create } = await nvidiaRuntime({
      model: 'nvidia:openai/gpt-oss-20b',
      script: {
        'openai/gpt-oss-20b': [{ delayMs: 2000, text: 'late' }],
        'google/gemma-4-31b-it': [{ delayMs: 2000, text: 'late' }],
      },
    });
    const runtime = await create();
    const run = await runtime.probeModels('nvidia');
    expect(run).toMatchObject({ ok: 0, unreachable: true });
    expect(runtime.unhealthy.size).toBe(0);
    expect(runtime.needsProbe('nvidia')).toBe(true);
    await expect(fs.access(path.join(home, 'cache', 'probe-nvidia.json'))).rejects.toThrow();
  });
});
