import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startMockServer, systemEnv, type MockServer } from '@vinax/testkit';
import {
  AllModelsFailedError,
  chatModels,
  createProvider,
  findCatalogModel,
  isNvidiaFreeChatModel,
  knownModel,
  modelSlug,
  NVIDIA_FREE_CHAT_MODELS,
  NVIDIA_FREE_OTHER_MODELS,
  probeCandidates,
  restrictToFreeModels,
  createRuntime,
  DEFAULT_SETTINGS,
  explainError,
  formatFailureReport,
  ModelCatalog,
  modelAlias,
  noopLogger,
  normalizeModelRef,
  parseModelRef,
  parseSettings,
  ProviderError,
  providerHost,
  providerLabel,
  RateLimitLedger,
  redact,
  resolveSettings,
  PROVIDER_NAMES,
  Router,
  SecretStore,
  SECRET_ENV_VARS,
  StreamInterruptedError,
  toProviderError,
  type ChatRequest,
  type ModelInfo,
  type Provider,
  type ProviderName,
  type ResolvedSettings,
  type RouterEvent,
  type StreamDelta,
} from '../src/index.js';

const servers: MockServer[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
  await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

async function mock(opts: Parameters<typeof startMockServer>[0]): Promise<MockServer> {
  const s = await startMockServer(opts);
  servers.push(s);
  return s;
}

async function tmp(): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'vinax-nvidia-'));
  dirs.push(d);
  return d;
}

function nvidiaSettings(baseUrl: string): ResolvedSettings {
  const s = resolveSettings({ providers: { nvidia: { baseUrl } } });
  return { ...s, router: { ...s.router, requestTimeoutMs: 5000 } };
}

describe('NVIDIA model identifiers', () => {
  it('maps the NVD_CHAT_OSS_20_B alias (any case) to the NVIDIA ref', () => {
    expect(normalizeModelRef('NVD_CHAT_OSS_20_B')).toBe('nvidia:openai/gpt-oss-20b');
    expect(normalizeModelRef('nvd_chat_oss_20_b')).toBe('nvidia:openai/gpt-oss-20b');
    expect(modelAlias('nvidia:openai/gpt-oss-20b')).toBe('NVD_CHAT_OSS_20_B');
  });

  it('accepts the provider domain and keeps other refs unchanged', () => {
    expect(normalizeModelRef('nvidia.com:openai/gpt-oss-20b')).toBe('nvidia:openai/gpt-oss-20b');
    expect(normalizeModelRef('NVIDIA:openai/gpt-oss-20b')).toBe('nvidia:openai/gpt-oss-20b');
    expect(normalizeModelRef('groq:openai/gpt-oss-120b')).toBe('groq:openai/gpt-oss-120b');
    expect(normalizeModelRef('openrouter:qwen/qwen3.8-27b:free')).toBe(
      'openrouter:qwen/qwen3.8-27b:free',
    );
  });

  it('rejects things that are not model refs', () => {
    for (const bad of ['', 'gpt-oss', 'nvidia:', ':x', 'acme:model', 'nvidia:a b', 'NVD_NOPE'])
      expect(normalizeModelRef(bad)).toBeUndefined();
    expect(() => parseModelRef('acme:model')).toThrow(/providers: groq, openrouter, nvidia/);
  });

  it('parses aliases into provider and model', () => {
    expect(parseModelRef('NVD_CHAT_OSS_20_B')).toEqual({
      provider: 'nvidia',
      model: 'openai/gpt-oss-20b',
    });
  });

  it('has a label, host and credential variable', () => {
    expect(providerLabel('nvidia')).toBe('NVIDIA');
    expect(providerHost('nvidia')).toBe('nvidia.com');
    expect(SECRET_ENV_VARS.nvidia).toBe('NVIDIA_API_KEY');
  });
});

describe('NVIDIA settings', () => {
  it('defaults to the hosted NVIDIA API and joins the fallback chain last', () => {
    expect(DEFAULT_SETTINGS.providers.nvidia).toEqual({
      enabled: true,
      baseUrl: 'https://integrate.api.nvidia.com/v1',
      rpm: Infinity,
    });
    // NVIDIA's strongest free agentic model leads its entries, gpt-oss-20b closes the chain
    expect(DEFAULT_SETTINGS.fallbackChain.filter((r) => r.startsWith('nvidia:'))).toEqual([
      'nvidia:nvidia/nemotron-3-super-120b-a12b',
      'nvidia:openai/gpt-oss-20b',
    ]);
    expect(DEFAULT_SETTINGS.fallbackChain.at(-1)).toBe('nvidia:openai/gpt-oss-20b');
  });

  it('accepts a custom base URL and aliases, storing the canonical ref', () => {
    const { settings, warnings } = parseSettings(
      {
        model: 'NVD_CHAT_OSS_20_B',
        fallbackChain: ['nvidia.com:openai/gpt-oss-20b', 'groq:x'],
        providers: { nvidia: { baseUrl: 'http://nim.internal:8000/v1', rpm: 5 } },
      },
      'test',
    );
    expect(warnings).toEqual([]);
    const r = resolveSettings(settings);
    expect(r.model).toBe('nvidia:openai/gpt-oss-20b');
    expect(r.fallbackChain).toEqual(['nvidia:openai/gpt-oss-20b', 'groq:x']);
    expect(r.providers.nvidia).toEqual({
      enabled: true,
      baseUrl: 'http://nim.internal:8000/v1',
      rpm: 5,
    });
  });

  it('explains invalid models and unknown provider keys', () => {
    expect(() => parseSettings({ model: 'nvidia-gpt' }, 'settings.json')).toThrow(
      /model: expected "<provider>:<model-id>" \(providers: groq, openrouter, nvidia, .*mistral.*\)/,
    );
    expect(
      parseSettings({ providers: { nvidia: { apiKey: 'nvapi-x' } } }, 'settings.json').warnings,
    ).toEqual(['Unknown setting "providers.nvidia.apiKey" in settings.json (ignored)']);
  });
});

describe('NVIDIA credentials', () => {
  it('reads NVIDIA_API_KEY from the environment first', async () => {
    const store = new SecretStore([], { NVIDIA_API_KEY: '  nvapi-from-env  ' });
    expect(await store.get('nvidia')).toEqual({ value: 'nvapi-from-env', source: 'env' });
  });

  it('redacts NVIDIA keys from logs', () => {
    expect(redact('key nvapi-AbCdEf123456_xyz used')).toBe('key [REDACTED] used');
  });
});

describe('NVIDIA provider', () => {
  const deps = (s: ResolvedSettings) => ({
    settings: s,
    ledger: new RateLimitLedger(() => 40),
    logger: noopLogger,
  });

  it('streams from the configured base URL with the bearer key and raw model id', async () => {
    const server = await mock({
      apiKeys: ['nvapi-good'],
      script: { 'openai/gpt-oss-20b': [{ text: ['Hel', 'lo'] }] },
    });
    const provider = createProvider('nvidia', 'nvapi-good', deps(nvidiaSettings(server.url)));
    const out: StreamDelta[] = [];
    for await (const d of provider.stream({
      model: 'openai/gpt-oss-20b',
      messages: [{ role: 'user', content: 'hi' }],
      signal: new AbortController().signal,
    }))
      out.push(d);
    expect(out.filter((d) => d.type === 'text').map((d) => d.text)).toEqual(['Hel', 'lo']);
    const req = server.requests.find((r) => r.path === '/v1/chat/completions');
    expect(req?.headers.authorization).toBe('Bearer nvapi-good');
    expect((req?.body as { model: string }).model).toBe('openai/gpt-oss-20b');
  });

  it('validates a key with a one-token completion, since /models is public', async () => {
    const server = await mock({
      apiKeys: ['nvapi-good'],
      script: { 'openai/gpt-oss-20b': [{ text: 'p' }] },
    });
    const s = nvidiaSettings(server.url);
    expect(await createProvider('nvidia', 'nvapi-good', deps(s)).validateKey()).toEqual({
      ok: true,
    });
    const checks = server.requests.filter((r) => r.path === '/v1/chat/completions');
    expect(checks.map((r) => (r.body as { model: string }).model)).toContain('openai/gpt-oss-20b');
    expect(checks[0]?.body).toMatchObject({ max_tokens: 1 });
    expect(await createProvider('nvidia', 'nvapi-bad', deps(s)).validateKey()).toEqual({
      ok: false,
      rejected: true,
      reason: 'the key was rejected',
    });
  });

  it('labels NVIDIA errors and classifies them', () => {
    const err = toProviderError(
      new ProviderError('auth', 'NVIDIA 401: bad', 'nvidia', 401),
      'nvidia',
      0,
    );
    expect(err.kind).toBe('auth');
    expect(err.message).toContain('NVIDIA');
  });

  it("fills in the context window NVIDIA's catalog leaves out", async () => {
    const provider: Provider = {
      name: 'nvidia',
      listModels: () =>
        Promise.resolve<ModelInfo[]>([
          {
            id: 'openai/gpt-oss-20b',
            contextWindow: undefined,
            supportsTools: undefined,
            free: false,
          },
          { id: 'other/model', contextWindow: undefined, supportsTools: undefined, free: false },
        ]),
      validateKey: () => Promise.resolve({ ok: true }),
      stream: () => {
        throw new Error('unused');
      },
    };
    const catalog = new ModelCatalog(await tmp());
    const { models } = await catalog.get(provider);
    // `other/model` is not one of NVIDIA's free endpoints, so it is not listed at all
    expect(models.map((m) => [m.id, m.contextWindow])).toEqual([['openai/gpt-oss-20b', 131_072]]);
    // the cached copy gets the same treatment
    expect((await catalog.get(provider)).models[0]?.contextWindow).toBe(131_072);
  });
});

type Step = { text: string } | { error: ProviderError };

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
    await Promise.resolve();
    if (!step) throw new ProviderError('server', `no script`, this.name, 500);
    if ('error' in step) throw step.error;
    yield { type: 'text', text: step.text };
  }
}

function router(
  chain: string[],
  providers: [ProviderName, Record<string, Step[]>][],
): { router: Router; fakes: Map<ProviderName, FakeProvider> } {
  const fakes = new Map(providers.map(([n, s]) => [n, new FakeProvider(n, s)]));
  const settings: ResolvedSettings = {
    ...DEFAULT_SETTINGS,
    model: chain[0] ?? '',
    fallbackChain: chain.slice(1),
    router: { ...DEFAULT_SETTINGS.router, maxRetries: 0 },
  };
  return {
    router: new Router({
      providers: fakes,
      ledger: new RateLimitLedger(() => 40),
      settings,
      sleep: () => Promise.resolve(),
    }),
    fakes,
  };
}

async function drain(gen: AsyncGenerator<RouterEvent>): Promise<RouterEvent[]> {
  const out: RouterEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

const request = () => ({
  messages: [{ role: 'user' as const, content: 'hi' }],
  signal: new AbortController().signal,
});

describe('NVIDIA in the fallback chain', () => {
  it('falls back to NVIDIA when Groq is rate limited', async () => {
    const { router: r } = router(
      ['groq:main', 'nvidia:openai/gpt-oss-20b'],
      [
        [
          'groq',
          { main: [{ error: new ProviderError('rate_limit', 'Groq 429: slow', 'groq', 429) }] },
        ],
        ['nvidia', { 'openai/gpt-oss-20b': [{ text: 'from nvidia' }] }],
      ],
    );
    const events = await drain(r.stream(request()));
    const fallback = events.find((e) => e.type === 'fallback');
    expect(fallback).toMatchObject({ to: { provider: 'nvidia', model: 'openai/gpt-oss-20b' } });
    expect(events.filter((e) => e.type === 'text').map((e) => e.text)).toEqual(['from nvidia']);
  });

  it('moves past an NVIDIA model that is not available and past a missing key', async () => {
    const { router: r } = router(
      ['nvidia:gone/model', 'openrouter:free:free', 'groq:backup'],
      [
        [
          'nvidia',
          {
            'gone/model': [
              { error: new ProviderError('not_found', 'NVIDIA 404: Not found', 'nvidia', 404) },
            ],
          },
        ],
        ['groq', { backup: [{ text: 'ok' }] }],
      ],
    );
    const events = await drain(r.stream(request()));
    expect(events.at(-1)).toMatchObject({ type: 'done', ref: { provider: 'groq' } });
  });

  it('reports every failure with a category and actions', async () => {
    const { router: r } = router(
      ['nvidia:openai/gpt-oss-20b', 'openrouter:free:free', 'groq:main'],
      [
        [
          'nvidia',
          {
            'openai/gpt-oss-20b': [
              { error: new ProviderError('auth', 'NVIDIA 401: Invalid API Key', 'nvidia', 401) },
            ],
          },
        ],
        [
          'groq',
          {
            main: [{ error: new ProviderError('rate_limit', 'Groq 429: slow down', 'groq', 429) }],
          },
        ],
      ],
    );
    let caught: unknown;
    try {
      await drain(r.stream(request()));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AllModelsFailedError);
    const report = explainError(caught);
    expect(report.title).toBe('Every model in the fallback chain failed');
    expect(report.category).toBe('auth');
    expect(report.lines.map((l) => [l.provider, l.category, l.reason])).toEqual([
      ['nvidia', 'auth', 'HTTP 401: Invalid API Key'],
      ['openrouter', 'no_key', 'no OpenRouter API key configured'],
      ['groq', 'rate_limit', 'HTTP 429: slow down'],
    ]);
    expect(report.actions[0]).toContain('NVIDIA_API_KEY');
    const text = formatFailureReport(report);
    expect(text).toContain('• NVIDIA · openai/gpt-oss-20b — authentication failed');
    expect(text).toContain('Try: ');
  });

  it('explains single failures, interrupted streams and plain errors', () => {
    const one = explainError(
      new AllModelsFailedError([
        {
          ref: { provider: 'nvidia', model: 'openai/gpt-oss-20b' },
          reason: 'Could not reach NVIDIA: ECONNREFUSED',
          kind: 'network',
        },
      ]),
    );
    expect(one.title).toBe('Provider request failed');
    expect(one.category).toBe('network');
    expect(one.actions).toContain('check your internet connection');

    const cut = explainError(
      new StreamInterruptedError(
        { provider: 'nvidia', model: 'openai/gpt-oss-20b' },
        new ProviderError('server', 'NVIDIA 502: bad gateway', 'nvidia', 502),
      ),
    );
    expect(cut.category).toBe('temporary');
    expect(cut.actions[0]).toBe('ask again to retry');

    // after VinaX's own retries the card says so, and the raw server text is only the detail
    const ref = { provider: 'nvidia' as const, model: 'openai/gpt-oss-20b' };
    const reason = 'NVIDIA: list index out of range';
    const exhausted = explainError(
      new StreamInterruptedError(ref, new ProviderError('server', reason, 'nvidia'), [
        { ref, reason, kind: 'server' },
        {
          ref: { provider: 'groq', model: 'openai/gpt-oss-120b' },
          reason: 'Groq 503',
          kind: 'server',
        },
      ]),
    );
    expect(exhausted.title).toBe('NVIDIA failed partway through the reply');
    expect(exhausted.title).not.toContain('list index');
    expect(exhausted.reason).toContain('already retried and switched models');
    expect(exhausted.lines[0]).toMatchObject({ model: 'openai/gpt-oss-20b' });
    expect(exhausted.lines[0]?.reason).toContain('list index out of range');

    expect(explainError(new AllModelsFailedError([])).category).toBe('no_key');
    expect(explainError(new Error('boom'))).toMatchObject({ category: 'unknown', reason: 'boom' });
  });
});

describe('NVIDIA runtime', () => {
  it('uses an NVIDIA key from the environment and lists NVIDIA models', async () => {
    const home = await tmp();
    const nvidia = await mock({
      apiKeys: ['nvapi-good'],
      models: [{ id: 'openai/gpt-oss-20b' }, { id: 'meta/llama-3.3-70b-instruct' }],
    });
    await fs.writeFile(
      path.join(home, 'settings.json'),
      JSON.stringify({
        model: 'NVD_CHAT_OSS_20_B',
        smallModel: 'nvidia:openai/gpt-oss-20b',
        fallbackChain: [],
        providers: { nvidia: { baseUrl: nvidia.url } },
      }),
    );
    const runtime = await createRuntime({
      cwd: home,
      env: {
        ...systemEnv(),
        VINAX_HOME: home,
        VINAX_SECRETS_BACKEND: 'file',
        NVIDIA_API_KEY: 'nvapi-good',
      },
    });
    expect(runtime.settings.resolved.model).toBe('nvidia:openai/gpt-oss-20b');
    expect(runtime.providers.has('nvidia')).toBe(true);
    // Every provider except the one whose key is in the environment.
    expect(runtime.missingKeys).toEqual(PROVIDER_NAMES.filter((p) => p !== 'nvidia'));
    expect(runtime.models.get('nvidia')?.find((m) => m.id === 'openai/gpt-oss-20b')).toMatchObject({
      contextWindow: 131_072,
    });
    // llama-3.3-70b has no free endpoint, so VinaX does not list it
    expect(runtime.models.get('nvidia')?.map((m) => m.id)).toEqual(['openai/gpt-oss-20b']);
    expect(runtime.warnings).toEqual([]);
  });

  it('skips a configured NVIDIA model missing from the catalog, with a warning', async () => {
    const home = await tmp();
    const nvidia = await mock({
      apiKeys: ['nvapi-good'],
      models: [{ id: 'nvidia/nemotron-3-super-120b-a12b' }],
    });
    await fs.writeFile(
      path.join(home, 'settings.json'),
      JSON.stringify({
        model: 'nvidia:openai/gpt-oss-20b',
        smallModel: 'nvidia:openai/gpt-oss-20b',
        fallbackChain: [],
        providers: { nvidia: { baseUrl: nvidia.url } },
      }),
    );
    const runtime = await createRuntime({
      cwd: home,
      env: {
        ...systemEnv(),
        VINAX_HOME: home,
        VINAX_SECRETS_BACKEND: 'file',
        NVIDIA_API_KEY: 'nvapi-good',
      },
    });
    expect([...runtime.skipped]).toEqual(['nvidia:openai/gpt-oss-20b']);
    expect(runtime.warnings.join('\n')).toContain(
      "nvidia:openai/gpt-oss-20b is not in NVIDIA's model list",
    );
  });
});

describe('stale empty catalogs', () => {
  const fake = (lists: ModelInfo[][]): Provider & { calls: number } => {
    const p = {
      name: 'nvidia' as const,
      calls: 0,
      listModels: () => Promise.resolve(lists[Math.min(p.calls++, lists.length - 1)] ?? []),
      validateKey: () => Promise.resolve({ ok: true as const }),
      stream: () => {
        throw new Error('unused');
      },
    };
    return p;
  };
  const m = (id: string): ModelInfo => ({
    id,
    contextWindow: undefined,
    supportsTools: undefined,
    free: false,
  });

  it('never caches an empty model list', async () => {
    const dir = await tmp();
    const provider = fake([[], [m('openai/gpt-oss-20b')]]);
    const catalog = new ModelCatalog(dir);
    expect((await catalog.get(provider)).models).toEqual([]);
    // the empty answer was not kept, so the next call asks again and gets the real list
    expect((await catalog.get(provider)).models.map((x) => x.id)).toEqual(['openai/gpt-oss-20b']);
    expect(provider.calls).toBe(2);
    await catalog.get(provider);
    expect(provider.calls).toBe(2);
  });

  it('ignores an empty list cached by an older version', async () => {
    const dir = await tmp();
    await fs.writeFile(
      path.join(dir, 'models-nvidia.json'),
      JSON.stringify({ fetchedAt: Date.now(), models: [] }),
    );
    const provider = fake([[m('openai/gpt-oss-20b')]]);
    expect((await new ModelCatalog(dir).get(provider)).models).toHaveLength(1);
  });

  it('refreshes the catalog and the skip list after a key is added', async () => {
    const home = await tmp();
    const nvidia = await mock({ apiKeys: ['nvapi-good'], models: [{ id: 'openai/gpt-oss-20b' }] });
    await fs.writeFile(
      path.join(home, 'settings.json'),
      JSON.stringify({
        model: 'nvidia:openai/gpt-oss-20b',
        smallModel: 'nvidia:openai/gpt-oss-20b',
        fallbackChain: [],
        providers: { nvidia: { baseUrl: nvidia.url } },
      }),
    );
    const env = { ...systemEnv(), VINAX_HOME: home, VINAX_SECRETS_BACKEND: 'file' };
    const runtime = await createRuntime({ cwd: home, env });
    expect(runtime.providers.has('nvidia')).toBe(false);
    expect(runtime.models.get('nvidia')).toBeUndefined();
    runtime.setProviderKey('nvidia', 'nvapi-good');
    await runtime.refreshCatalog('nvidia');
    expect(runtime.models.get('nvidia')?.map((x) => x.id)).toEqual(['openai/gpt-oss-20b']);
    expect(runtime.skipped.has('nvidia:openai/gpt-oss-20b')).toBe(false);
  });
});

describe('NVIDIA free endpoints only', () => {
  const info = (id: string): ModelInfo => ({
    id,
    contextWindow: undefined,
    supportsTools: undefined,
    free: true,
  });

  it('normalises ids to slugs', () => {
    expect(modelSlug('z-ai/GLM-5.3')).toBe('glm-5-3');
    expect(modelSlug('Step 5 Preview')).toBe('step-5-preview');
    expect(modelSlug('poolside/laguna_xs..2.1')).toBe('laguna-xs-2-1');
    expect(isNvidiaFreeChatModel('z-ai/glm-5.3')).toBe(true);
    expect(isNvidiaFreeChatModel('stepfun-ai/step5-preview')).toBe(true);
    expect(isNvidiaFreeChatModel('meta/llama-3.3-70b-instruct')).toBe(false);
    // free, but not chat models
    expect(isNvidiaFreeChatModel('nvidia/nemotron-3-embed-1b')).toBe(false);
    expect(isNvidiaFreeChatModel('meta/llama-guard-4-12b')).toBe(false);
    expect(NVIDIA_FREE_CHAT_MODELS.length + NVIDIA_FREE_OTHER_MODELS.length).toBe(39);
  });

  it("keeps only free chat models, in preference order, with the catalog's spelling", () => {
    const catalog = [
      info('meta/llama-3.3-70b-instruct'),
      info('z-ai/glm-5.3'),
      info('openai/gpt-oss-20b'),
      info('nvidia/nemotron-3-embed-1b'),
      info('nvidia/nemotron-3-super-120b-a12b'),
      info('nvidia/llama-3.1-nemotron-safety-guard-8b-v3'),
    ];
    expect(restrictToFreeModels('nvidia', catalog).map((m) => m.id)).toEqual([
      'nvidia/nemotron-3-super-120b-a12b',
      'openai/gpt-oss-20b',
      'z-ai/glm-5.3',
    ]);
    // other providers are untouched
    expect(restrictToFreeModels('groq', catalog)).toHaveLength(catalog.length);
    expect(chatModels(catalog, 'nvidia').map((m) => m.id)).toEqual([
      'nvidia/nemotron-3-super-120b-a12b',
      'openai/gpt-oss-20b',
      'z-ai/glm-5.3',
    ]);
    // `glm-5-3` (VinaX's guess) resolves to NVIDIA's `glm-5.3`; exact ids win
    expect(findCatalogModel('nvidia', catalog, 'z-ai/glm-5-3')?.id).toBe('z-ai/glm-5.3');
    expect(findCatalogModel('nvidia', catalog, 'z-ai/glm-5-3-flash')).toBeUndefined();
    expect(findCatalogModel('groq', catalog, 'z-ai/glm-5-3')).toBeUndefined();
  });

  it('falls back to the known ids when nothing in the catalog matches', () => {
    const ids = restrictToFreeModels('nvidia', [info('some/unknown')]).map((m) => m.id);
    expect(ids).toEqual([...NVIDIA_FREE_CHAT_MODELS]);
    expect(restrictToFreeModels('nvidia', [])).toEqual([]);
  });

  it('knows vision, video, context and tool support for the free models by slug', () => {
    expect(knownModel('nvidia', 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning')).toMatchObject({
      vision: true,
      video: true,
    });
    expect(knownModel('nvidia', 'nvidia/cosmos3-nano-reasoner')).toMatchObject({
      vision: true,
      video: true,
    });
    expect(knownModel('nvidia', 'z-ai/glm-5.3-flash')).toMatchObject({ vision: true });
    expect(knownModel('nvidia', 'stepfun-ai/step5-preview')?.contextWindow).toBe(1_000_000);
    expect(knownModel('nvidia', 'nvidia/nemotron-3-ultra-550b-a55b')?.contextWindow).toBe(
      1_000_000,
    );
    expect(knownModel('nvidia', 'meta/llama-3.2-11b-vision-instruct')).toMatchObject({
      contextWindow: 131_072,
      tools: false,
    });
    // slug matching is NVIDIA-only
    expect(knownModel('groq', 'z-ai/glm-5.3')).toBeUndefined();
  });

  it('lists only free models from /models and tests only those', async () => {
    const nvidia = await mock({
      models: [
        { id: 'meta/llama-3.3-70b-instruct' },
        { id: 'z-ai/glm-5.3' },
        { id: 'nvidia/nemotron-3-super-120b-a12b' },
        { id: 'nvidia/nemotron-3-embed-1b' },
      ],
    });
    const provider = createProvider('nvidia', 'nvapi-test', {
      settings: nvidiaSettings(nvidia.url),
      ledger: new RateLimitLedger(() => Infinity),
      logger: noopLogger,
    });
    const listed = await provider.listModels();
    expect(listed.map((m) => m.id)).toEqual(['nvidia/nemotron-3-super-120b-a12b', 'z-ai/glm-5.3']);
    expect(listed.every((m) => m.free)).toBe(true);
    const candidates = probeCandidates('nvidia', listed, { freeOnly: true });
    expect(candidates).toContain('z-ai/glm-5.3');
    expect(candidates).not.toContain('z-ai/glm-5-3');
    expect(candidates).not.toContain('meta/llama-3.3-70b-instruct');
  });

  it('routes a configured id to the catalog spelling of the same model', () => {
    const router = new Router({
      settings: {
        ...DEFAULT_SETTINGS,
        model: 'nvidia:z-ai/glm-5-3',
        fallbackChain: ['nvidia:z-ai/glm-5.3', 'nvidia:openai/gpt-oss-20b'],
      },
      ledger: new RateLimitLedger(() => Infinity),
      providers: new Map([['nvidia', {} as Provider]]),
      models: new Map([['nvidia', [info('z-ai/glm-5.3'), info('openai/gpt-oss-20b')]]]),
    });
    expect(router.chain().map((r) => `${r.provider}:${r.model}`)).toEqual([
      'nvidia:z-ai/glm-5.3',
      'nvidia:openai/gpt-oss-20b',
    ]);
  });
});

describe('NVIDIA errors partway through a reply', () => {
  it('asks again after an SSE error mid-stream, and the retry answers', async () => {
    const nvidia = await mock({
      script: {
        'openai/gpt-oss-20b': [
          { text: ['Half an ans'], streamError: 'list index out of range' },
          { text: ['The whole answer.'] },
        ],
      },
    });
    const settings: ResolvedSettings = {
      ...nvidiaSettings(nvidia.url),
      model: 'nvidia:openai/gpt-oss-20b',
      fallbackChain: [],
    };
    const ledger = new RateLimitLedger(() => Infinity);
    const router = new Router({
      settings,
      ledger,
      providers: new Map([
        [
          'nvidia',
          createProvider('nvidia', 'nvapi-test', { settings, ledger, logger: noopLogger }),
        ],
      ]),
      sleep: () => Promise.resolve(),
    });
    const events: RouterEvent[] = [];
    for await (const e of router.stream(request())) events.push(e);
    expect(events.filter((e) => e.type !== 'reasoning').map((e) => e.type)).toEqual([
      'attempt',
      'text',
      'restart',
      'retry',
      'attempt',
      'text',
      'done',
    ]);
    expect(events.find((e) => e.type === 'restart')).toMatchObject({
      reason: 'NVIDIA: list index out of range',
    });
    expect(events.filter((e) => e.type === 'text').at(-1)).toEqual({
      type: 'text',
      text: 'The whole answer.',
    });
  });
});
