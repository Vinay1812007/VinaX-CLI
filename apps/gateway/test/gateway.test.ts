import { afterEach, describe, expect, it } from 'vitest';
import { startMockServer, type MockServer } from '@vinax/testkit';
import { createApp } from '../src/app.js';
import { ConfigError, loadConfig, type GatewayConfig } from '../src/config.js';
import { RateLimiter } from '../src/limits.js';
import { generateToken, hashToken, parseTokenHashes } from '../src/tokens.js';

const TOKEN = 'vxg_test-token-alice';
const servers: MockServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

async function mock(opts: Parameters<typeof startMockServer>[0]): Promise<MockServer> {
  const s = await startMockServer(opts);
  servers.push(s);
  return s;
}

function config(over: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    port: 0,
    upstreams: {},
    tokens: new Map([[hashToken(TOKEN), 'alice']]),
    rpm: 100,
    rpd: 1000,
    maxBodyBytes: 100_000,
    defaultModels: [],
    upstreamTimeoutMs: 5000,
    ...over,
  };
}

function chat(body: unknown, token = TOKEN): Request {
  return new Request('http://gw/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const messages = [{ role: 'user', content: 'hi' }];

describe('tokens', () => {
  it('parses named and bare hashes and rejects junk', () => {
    const h = hashToken('x');
    const map = parseTokenHashes(`alice:${h}, ${hashToken('y')}\n`);
    expect(map.get(h)).toBe('alice');
    expect(map.get(hashToken('y'))).toBe('token2');
    expect(() => parseTokenHashes('bob:1234')).toThrow(/sha256/);
  });

  it('generates distinct prefixed tokens', () => {
    const a = generateToken();
    expect(a).toMatch(/^vxg_[A-Za-z0-9_-]{32}$/);
    expect(generateToken()).not.toBe(a);
  });
});

describe('config', () => {
  it('needs a provider key and at least one token', () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({ GROQ_API_KEY: 'k' })).toThrow(/VINAX_TOKEN_HASHES/);
    const c = loadConfig({
      GROQ_API_KEY: 'k',
      VINAX_TOKEN_HASHES: `a:${hashToken('t')}`,
      RATE_LIMIT_RPM: '5',
    });
    expect(Object.keys(c.upstreams)).toEqual(['groq']);
    expect(c.rpm).toBe(5);
    expect(() =>
      loadConfig({ GROQ_API_KEY: 'k', VINAX_TOKEN_HASHES: `a:${hashToken('t')}`, PORT: 'x' }),
    ).toThrow(/PORT/);
  });
});

describe('rate limiter', () => {
  it('enforces per-minute and per-day limits per token', () => {
    let t = Date.UTC(2026, 0, 1, 12);
    const rl = new RateLimiter(2, 3, () => t);
    expect(rl.take('a').ok).toBe(true);
    expect(rl.take('a').ok).toBe(true);
    const third = rl.take('a');
    expect(third.ok).toBe(false);
    expect(third.ok ? 0 : third.retryAfterSec).toBe(60);
    expect(rl.take('b').ok).toBe(true);
    t += 61_000;
    expect(rl.take('a').ok).toBe(true);
    t += 61_000;
    const daily = rl.take('a');
    expect(daily.ok ? '' : daily.reason).toMatch(/daily/);
    t = Date.UTC(2026, 0, 2, 0, 0, 1);
    expect(rl.take('a').ok).toBe(true);
  });
});

describe('gateway app', () => {
  it('serves /health without a token and never sends CORS headers', async () => {
    const app = createApp(config(), { log: () => undefined });
    const res = await app.request('/health', { headers: { Origin: 'https://evil.example' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'ok', service: 'vinax-gateway' });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    const pre = await app.request('/v1/chat/completions', { method: 'OPTIONS' });
    expect(pre.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('rejects missing and unknown tokens', async () => {
    const app = createApp(config(), { log: () => undefined });
    expect((await app.request('/v1/models')).status).toBe(401);
    expect((await app.request(chat({ model: 'groq:m', messages }, 'vxg_wrong'))).status).toBe(401);
  });

  it('streams a completion through and passes on rate-limit headers', async () => {
    const groq = await mock({
      apiKeys: ['gsk_server'],
      script: {
        'openai/gpt-oss-120b': [
          { text: ['Hel', 'lo'], headers: { 'x-ratelimit-remaining-requests': '29' } },
        ],
      },
    });
    const lines: Record<string, unknown>[] = [];
    const app = createApp(
      config({ upstreams: { groq: { name: 'groq', baseUrl: groq.url, apiKey: 'gsk_server' } } }),
      { log: (l) => lines.push(l) },
    );
    const res = await app.request(
      chat({ model: 'groq:openai/gpt-oss-120b', messages, stream: true, secret: 'do-not-log' }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
    expect(res.headers.get('x-ratelimit-remaining-requests')).toBe('29');
    expect(res.headers.get('x-vinax-model')).toBe('groq:openai/gpt-oss-120b');
    const text = await res.text();
    expect(text).toContain('"Hel"');
    expect(text).toContain('[DONE]');
    // the upstream got the bare model id and the server's key, not the client's token
    const sent = groq.requests.find((r) => r.path.endsWith('/chat/completions'));
    expect((sent?.body as { model: string }).model).toBe('openai/gpt-oss-120b');
    expect(sent?.headers.authorization).toBe('Bearer gsk_server');
    // one log line, with the token's name and no body
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ status: 200, token: 'alice', path: '/v1/chat/completions' });
    expect(JSON.stringify(lines)).not.toContain('do-not-log');
    expect(JSON.stringify(lines)).not.toContain('hi');
  });

  it('falls back to the next model when the first is rate limited', async () => {
    const groq = await mock({
      script: {
        m1: [
          {
            status: 429,
            error: { message: 'Rate limit reached' },
            headers: { 'retry-after': '30' },
          },
        ],
      },
    });
    const openrouter = await mock({ script: { 'm2:free': [{ text: 'from openrouter' }] } });
    const app = createApp(
      config({
        upstreams: {
          groq: { name: 'groq', baseUrl: groq.url, apiKey: 'a' },
          openrouter: { name: 'openrouter', baseUrl: openrouter.url, apiKey: 'b' },
        },
        defaultModels: ['groq:m1', 'openrouter:m2:free'],
      }),
      { log: () => undefined },
    );
    const res = await app.request(chat({ model: 'auto', messages, stream: true }));
    expect(res.status).toBe(200);
    expect(res.headers.get('x-vinax-model')).toBe('openrouter:m2:free');
    expect(res.headers.get('x-vinax-fallback')).toBe('1');
    expect(await res.text()).toContain('from openrouter');
    const orReq = openrouter.requests.find((r) => r.path.endsWith('/chat/completions'));
    expect(orReq?.headers['http-referer']).toContain('github.com');

    // an explicit `models` list works the same way
    groq.enqueue('m1', { status: 503, error: { message: 'down' } });
    openrouter.enqueue('m2:free', { text: 'again' });
    const res2 = await app.request(
      chat({ model: 'groq:m1', models: ['openrouter:m2:free'], messages, stream: true }),
    );
    expect(await res2.text()).toContain('again');
  });

  it('passes a final rate limit through with its retry-after', async () => {
    const groq = await mock({
      script: {
        m1: [{ status: 429, error: { message: 'slow down' }, headers: { 'retry-after': '12' } }],
      },
    });
    const app = createApp(
      config({ upstreams: { groq: { name: 'groq', baseUrl: groq.url, apiKey: 'a' } } }),
      { log: () => undefined },
    );
    const res = await app.request(chat({ model: 'groq:m1', messages }));
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('12');
    expect(await res.text()).toContain('slow down');
  });

  it('returns client errors unchanged and hides upstream auth failures', async () => {
    const groq = await mock({
      script: {
        bad: [{ status: 400, error: { message: 'messages must not be empty' } }],
        m1: [{ status: 401, error: { message: 'Invalid API Key' } }],
      },
    });
    const app = createApp(
      config({ upstreams: { groq: { name: 'groq', baseUrl: groq.url, apiKey: 'a' } } }),
      { log: () => undefined },
    );
    const bad = await app.request(chat({ model: 'groq:bad', messages }));
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain('messages must not be empty');
    // the gateway's own key being rejected must not look like the client's token failing
    const auth = await app.request(chat({ model: 'groq:m1', messages }));
    expect(auth.status).toBe(502);
    expect(await auth.text()).toContain('groq:m1: HTTP 401');
  });

  it('explains unknown providers and providers without a key', async () => {
    const app = createApp(config(), { log: () => undefined });
    const res = await app.request(chat({ model: 'groq:m', models: ['acme:x'], messages }));
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).toContain('this gateway has no groq key');
    expect(text).toContain('unknown provider');
    expect((await app.request(chat({ messages }))).status).toBe(400);
  });

  it('enforces the per-token rate limit', async () => {
    const groq = await mock({ script: { '*': [{ text: 'a' }, { text: 'b' }] } });
    const app = createApp(
      config({ rpm: 1, upstreams: { groq: { name: 'groq', baseUrl: groq.url, apiKey: 'a' } } }),
      { log: () => undefined },
    );
    expect((await app.request(chat({ model: 'groq:m', messages }))).status).toBe(200);
    const limited = await app.request(chat({ model: 'groq:m', messages }));
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(await limited.text()).toContain('VinaX gateway');
  });

  it('caps the request size', async () => {
    const app = createApp(config({ maxBodyBytes: 200 }), { log: () => undefined });
    const res = await app.request(
      chat({ model: 'groq:m', messages: [{ role: 'user', content: 'x'.repeat(500) }] }),
    );
    expect(res.status).toBe(413);
  });

  it('merges both model lists with provider prefixes', async () => {
    const groq = await mock({ models: [{ id: 'openai/gpt-oss-120b', context_window: 131072 }] });
    const openrouter = await mock({ models: [{ id: 'qwen/qwen3.8-27b:free' }] });
    const app = createApp(
      config({
        upstreams: {
          groq: { name: 'groq', baseUrl: groq.url, apiKey: 'a' },
          openrouter: { name: 'openrouter', baseUrl: openrouter.url, apiKey: 'b' },
        },
      }),
      { log: () => undefined },
    );
    const res = await app.request('/v1/models', { headers: { Authorization: `Bearer ${TOKEN}` } });
    const body = (await res.json()) as { data: { id: string; context_window?: number }[] };
    expect(body.data.map((m) => m.id)).toEqual([
      'groq:openai/gpt-oss-120b',
      'openrouter:qwen/qwen3.8-27b:free',
    ]);
    expect(body.data[0]?.context_window).toBe(131072);
  });
});
