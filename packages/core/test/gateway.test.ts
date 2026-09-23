import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startMockServer, type MockServer, type MockServerOptions } from '@vinax/testkit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  checkGateway,
  createRuntime,
  GATEWAY_WAKING,
  GatewayClient,
  gatewayUrlProblem,
  GatewayUnavailableError,
  openSecretStore,
  removeGatewayLogin,
  runDoctor,
  saveGatewayLogin,
  type RouterEvent,
} from '../src/index.js';

let home: string;
const servers: MockServer[] = [];

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'vinax-gw-'));
});
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
  await fs.rm(home, { recursive: true, force: true });
});

async function gatewayMock(opts: MockServerOptions): Promise<{ server: MockServer; url: string }> {
  const server = await startMockServer(opts);
  servers.push(server);
  return { server, url: server.url.replace(/\/v1$/, '') };
}

/** A fake clock whose sleeps advance time instantly. */
function fakeTime() {
  let t = 1_000_000;
  return {
    now: () => t,
    sleep: (ms: number) => {
      t += ms;
      return Promise.resolve();
    },
  };
}

function healthFetch(answers: boolean[]): { fetch: typeof fetch; calls: () => number } {
  let calls = 0;
  const fn = (() => {
    const up = answers[Math.min(calls, answers.length - 1)] ?? false;
    calls++;
    return Promise.resolve(
      up
        ? new Response(JSON.stringify({ status: 'ok', version: '9.9.9' }), { status: 200 })
        : new Response('starting', { status: 503 }),
    );
  }) as typeof fetch;
  return { fetch: fn, calls: () => calls };
}

describe('GatewayClient', () => {
  it('polls /health until the gateway wakes, sharing one wake-up between callers', async () => {
    const time = fakeTime();
    const h = healthFetch([false, false, true]);
    const client = new GatewayClient('https://gw.example.com/', {
      timeoutMs: 60_000,
      fetch: h.fetch,
      ...time,
    });
    expect(client.baseURL).toBe('https://gw.example.com/v1');
    expect(client.isAwake()).toBe(false);
    await Promise.all([client.wake(), client.wake()]);
    expect(h.calls()).toBe(3);
    expect(client.isAwake()).toBe(true);
    await client.wake(); // awake: no more requests
    expect(h.calls()).toBe(3);
  });

  it('gives up after the timeout and fails fast for a while afterwards', async () => {
    const time = fakeTime();
    const h = healthFetch([false]);
    const client = new GatewayClient('https://gw.example.com', {
      timeoutMs: 10_000,
      fetch: h.fetch,
      ...time,
    });
    await expect(client.wake()).rejects.toBeInstanceOf(GatewayUnavailableError);
    const calls = h.calls();
    await expect(client.wake()).rejects.toThrow(/not responding/);
    expect(h.calls()).toBe(calls);
  });

  it('only accepts https URLs, except for local addresses', () => {
    expect(gatewayUrlProblem('https://gw.onrender.com')).toBeUndefined();
    expect(gatewayUrlProblem('http://localhost:8787')).toBeUndefined();
    expect(gatewayUrlProblem('http://gw.example.com')).toMatch(/https/);
    expect(gatewayUrlProblem('gw.example.com')).toMatch(/not a URL/);
  });
});

describe('checkGateway', () => {
  it('reports a rejected token, a working one, and wakes a sleeping gateway first', async () => {
    let checks = 0;
    const { url } = await gatewayMock({
      apiKeys: ['vxg_good'],
      models: [{ id: 'groq:openai/gpt-oss-120b' }, { id: 'openrouter:x:free' }],
      health: () => ++checks > 1,
    });
    let woke = false;
    const ok = await checkGateway(url, 'vxg_good', {
      timeoutMs: 20_000,
      onWaking: () => {
        woke = true;
      },
    });
    expect(ok).toEqual({ ok: true, models: 2, version: 'mock' });
    expect(woke).toBe(true);
    const bad = await checkGateway(url, 'vxg_bad', { timeoutMs: 5000 });
    expect(bad).toMatchObject({ ok: false, rejected: true });
    expect(await checkGateway('http://gw.example.com', 't', { timeoutMs: 5000 })).toMatchObject({
      ok: false,
      rejected: true,
    });
  });
});

describe('gateway login and runtime', () => {
  const env = () => ({ VINAX_HOME: home, VINAX_SECRETS_BACKEND: 'file' });

  it('saves and removes the gateway URL and token', async () => {
    await saveGatewayLogin('https://gw.example.com/', 'vxg_tok', { cwd: home, env: env() });
    const settings = JSON.parse(await fs.readFile(path.join(home, 'settings.json'), 'utf8')) as {
      gateway: { url: string };
    };
    expect(settings.gateway.url).toBe('https://gw.example.com');
    expect((await (await openSecretStore(env())).get('gateway'))?.value).toBe('vxg_tok');
    expect(await removeGatewayLogin({ cwd: home, env: env() })).toBe(true);
    expect(await fs.readFile(path.join(home, 'settings.json'), 'utf8')).not.toContain('gateway');
    expect(await (await openSecretStore(env())).get('gateway')).toBeUndefined();
  });

  it('routes providers without a key through the gateway, waking it on the first request', async () => {
    let up = false;
    const { server, url } = await gatewayMock({
      apiKeys: ['vxg_tok'],
      health: () => up,
      models: [{ id: 'groq:main', context_window: 131072 }],
      script: { 'groq:main': [{ text: 'hello via gateway' }] },
    });
    await fs.writeFile(
      path.join(home, 'settings.json'),
      JSON.stringify({
        model: 'groq:main',
        smallModel: 'groq:main',
        fallbackChain: [],
        providers: { openrouter: { enabled: false } },
        router: { maxRetries: 0 },
        gateway: { url, timeoutMs: 20_000 },
      }),
    );
    const runtime = await createRuntime({
      cwd: home,
      env: { ...env(), VINAX_GATEWAY_TOKEN: 'vxg_tok' },
    });
    expect([...runtime.viaGateway]).toEqual(['groq']);
    expect(runtime.missingKeys).toEqual([]);
    expect(runtime.warnings.join('\n')).toContain('Waking VinaX gateway');
    setTimeout(() => {
      up = true;
    }, 300);

    const events: RouterEvent[] = [];
    for await (const ev of runtime.router.stream({
      messages: [{ role: 'user', content: 'hi' }],
      signal: new AbortController().signal,
    }))
      events.push(ev);
    const text = events.flatMap((e) => (e.type === 'text' ? [e.text] : [])).join('');
    expect(text).toBe('hello via gateway');
    const statuses = events.flatMap((e) => (e.type === 'status' ? [e.text] : []));
    // the background wake-up started at startup may already have finished
    if (statuses.length > 0) expect(statuses).toEqual([GATEWAY_WAKING, '']);
    const sent = server.requests.find((r) => r.path === '/v1/chat/completions');
    expect((sent?.body as { model: string }).model).toBe('groq:main');
    expect(sent?.headers.authorization).toBe('Bearer vxg_tok');

    // the model list comes back without the provider prefix
    const models = await runtime.providers.get('groq')?.listModels();
    expect(models?.map((m) => m.id)).toEqual(['main']);

    // an own key takes over from the gateway, and logging out of it falls back to the gateway
    runtime.setProviderKey('groq', 'gsk_own');
    expect(runtime.viaGateway.has('groq')).toBe(false);
    runtime.removeProvider('groq');
    expect(runtime.viaGateway.has('groq')).toBe(true);
    runtime.removeProvider('gateway');
    expect(runtime.providers.has('groq')).toBe(false);
    expect(runtime.gateway).toBeUndefined();
  });

  it('shows the waking status when a request finds the gateway asleep', async () => {
    let healthCalls = 0;
    const { url } = await gatewayMock({
      apiKeys: ['vxg_tok'],
      // asleep for the startup probe and the first request's probe, then awake
      health: () => ++healthCalls > 3,
      script: { 'groq:main': [{ text: 'awake now' }] },
    });
    await fs.writeFile(
      path.join(home, 'settings.json'),
      JSON.stringify({
        model: 'groq:main',
        smallModel: 'groq:main',
        fallbackChain: [],
        providers: { openrouter: { enabled: false } },
        gateway: { url, timeoutMs: 30_000 },
      }),
    );
    const runtime = await createRuntime({
      cwd: home,
      env: { ...env(), VINAX_GATEWAY_TOKEN: 'vxg_tok' },
    });
    runtime.setGateway(url, 'vxg_tok'); // a fresh client that has not started waking yet
    const events: RouterEvent[] = [];
    for await (const ev of runtime.router.stream({
      messages: [{ role: 'user', content: 'hi' }],
      signal: new AbortController().signal,
    }))
      events.push(ev);
    expect(events.flatMap((e) => (e.type === 'status' ? [e.text] : []))).toEqual([
      GATEWAY_WAKING,
      '',
    ]);
    expect(events.some((e) => e.type === 'text' && e.text === 'awake now')).toBe(true);
  }, 20_000);

  it('doctor reports the gateway', async () => {
    const { url } = await gatewayMock({ apiKeys: ['vxg_tok'], health: () => true });
    await fs.writeFile(path.join(home, 'settings.json'), JSON.stringify({ gateway: { url } }));
    const checks = await runDoctor({
      cwd: home,
      env: { ...env(), VINAX_GATEWAY_TOKEN: 'vxg_tok' },
      version: '1.0.0',
      terminal: { isTTY: false, columns: undefined },
    });
    const gw = checks.find((c) => c.name === 'Gateway');
    expect(gw).toMatchObject({ status: 'ok' });
    expect(gw?.detail).toContain('is up (vmock)');
    expect(checks.find((c) => c.name === 'API keys')).toBeUndefined();
    expect(checks.find((c) => c.name === 'Groq key')?.detail).toContain(
      'through the VinaX gateway',
    );
  });
});
