import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startMockServer, type MockServer } from '@vinax/testkit';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createFileLogger,
  ModelCatalog,
  noopLogger,
  OpenAICompatibleProvider,
  ProviderError,
  RateLimitLedger,
  redact,
  createProvider,
  resolveSettings,
  toWireMessages,
  wireArguments,
  type ChatMessage,
  type StreamDelta,
} from '../src/index.js';

let server: MockServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

function makeProvider(url: string, ledger = new RateLimitLedger(), apiKey = 'gsk_testkey123456') {
  return new OpenAICompatibleProvider({
    name: 'groq',
    baseURL: url,
    apiKey,
    timeoutMs: 5000,
    ledger,
    logger: noopLogger,
    keyCheck: { path: '/models' },
  });
}

async function drain(it: AsyncIterable<StreamDelta>): Promise<StreamDelta[]> {
  const out: StreamDelta[] = [];
  for await (const d of it) out.push(d);
  return out;
}

describe('OpenAICompatibleProvider', () => {
  it.each(['gemini', 'openai', 'deepseek', 'mistral'] as const)(
    'connects %s keys, model discovery and streaming to its configured endpoint',
    async (name) => {
      server = await startMockServer({
        models: [{ id: 'chat-model' }],
        script: { 'chat-model': [{ text: 'working' }] },
      });
      const provider = createProvider(name, 'new-provider-key', {
        settings: resolveSettings({ providers: { [name]: { baseUrl: server.url } } }),
        ledger: new RateLimitLedger(),
        logger: noopLogger,
      });
      expect(await provider.validateKey()).toEqual({ ok: true });
      expect((await provider.listModels())[0]?.id).toBe('chat-model');
      expect(
        await drain(
          provider.stream({
            model: 'chat-model',
            messages: [{ role: 'user', content: 'hello' }],
            signal: new AbortController().signal,
          }),
        ),
      ).toContainEqual({ type: 'text', text: 'working' });
      expect(server.requests.at(-1)?.headers.authorization).toBe('Bearer new-provider-key');
    },
  );
  it('streams text and usage, and records rate-limit headers', async () => {
    server = await startMockServer({
      script: {
        m: [
          {
            text: ['Hello', ', world'],
            usage: { prompt_tokens: 12, completion_tokens: 3 },
            headers: { 'x-ratelimit-limit-tokens': '8000', 'x-ratelimit-remaining-tokens': '7000' },
          },
        ],
      },
    });
    const ledger = new RateLimitLedger();
    const deltas = await drain(
      makeProvider(server.url, ledger).stream({
        model: 'm',
        messages: [{ role: 'user', content: 'hi' }],
        signal: new AbortController().signal,
      }),
    );
    expect(deltas).toEqual([
      { type: 'text', text: 'Hello' },
      { type: 'text', text: ', world' },
      { type: 'usage', usage: { promptTokens: 12, completionTokens: 3 } },
    ]);
    expect(ledger.snapshot('groq', 'm')?.tokens).toEqual({ limit: 8000, remaining: 7000 });
    const sent = server.requests.at(-1);
    expect(sent?.headers.authorization).toBe('Bearer gsk_testkey123456');
    expect(sent?.body).toMatchObject({
      model: 'm',
      stream: true,
      stream_options: { include_usage: true },
    });
  });

  it('maps a 429 to a rate_limit error with retry-after', async () => {
    server = await startMockServer({
      script: {
        m: [
          {
            status: 429,
            headers: { 'retry-after': '7' },
            error: { message: 'Rate limit reached' },
          },
        ],
      },
    });
    const err = await drain(
      makeProvider(server.url).stream({
        model: 'm',
        messages: [],
        signal: new AbortController().signal,
      }),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).toMatchObject({ kind: 'rate_limit', status: 429, retryAfterMs: 7000 });
    expect((err as Error).message).toBe('Groq 429: Rate limit reached');
  });

  it('reports an abort mid-stream as aborted, not as a finished answer', async () => {
    server = await startMockServer({
      script: { m: [{ text: ['first ', 'second ', 'third'], chunkDelayMs: 200 }] },
    });
    const ac = new AbortController();
    const seen: string[] = [];
    const err = await (async () => {
      for await (const d of makeProvider(server.url).stream({
        model: 'm',
        messages: [],
        signal: ac.signal,
      })) {
        if (d.type === 'text') seen.push(d.text);
        ac.abort();
      }
    })().catch((e: unknown) => e);
    expect(seen).toEqual(['first ']);
    expect(err).toMatchObject({ kind: 'aborted' });
  });

  it('maps 413 (request larger than the TPM budget) to too_large', async () => {
    server = await startMockServer({
      script: { m: [{ status: 413, error: { message: 'Request too large' } }] },
    });
    const err = await drain(
      makeProvider(server.url).stream({
        model: 'm',
        messages: [],
        signal: new AbortController().signal,
      }),
    ).catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: 'too_large' });
  });

  it('validates keys and lists models', async () => {
    server = await startMockServer({
      apiKeys: ['gsk_goodkey000000'],
      models: [
        { id: 'a', context_window: 131072 },
        { id: 'b:free', supported_parameters: ['tools'] },
      ],
    });
    expect(await makeProvider(server.url, undefined, 'gsk_goodkey000000').validateKey()).toEqual({
      ok: true,
    });
    expect(await makeProvider(server.url, undefined, 'gsk_badkey0000000').validateKey()).toEqual({
      ok: false,
      rejected: true,
      reason: 'the key was rejected',
    });
    expect(await makeProvider(server.url, undefined, 'gsk_goodkey000000').listModels()).toEqual([
      { id: 'a', contextWindow: 131072, supportsTools: undefined, free: false },
      { id: 'b:free', contextWindow: undefined, supportsTools: true, free: true },
    ]);
  });

  // NVIDIA's /models reports only id/owned_by — no pricing — so without freeCatalog every one of
  // its free NIM endpoints would be listed as paid.
  it('marks a whole catalog free when the provider publishes no prices', async () => {
    server = await startMockServer({
      apiKeys: ['gsk_goodkey000000'],
      models: [{ id: 'openai/gpt-oss-20b' }, { id: 'meta/llama-3.2-11b-vision-instruct' }],
    });
    const provider = new OpenAICompatibleProvider({
      name: 'nvidia',
      baseURL: server.url,
      apiKey: 'gsk_goodkey000000',
      timeoutMs: 5000,
      ledger: new RateLimitLedger(),
      logger: noopLogger,
      keyCheck: { path: '/models' },
      freeCatalog: true,
    });
    expect((await provider.listModels()).map((m) => [m.id, m.free])).toEqual([
      ['openai/gpt-oss-20b', true],
      ['meta/llama-3.2-11b-vision-instruct', true],
    ]);
  });
});

describe('ModelCatalog', () => {
  it('caches /models for 24h and falls back to a stale cache when offline', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vinax-catalog-'));
    server = await startMockServer({ models: [{ id: 'a' }] });
    const clock = { t: 0 };
    const catalog = new ModelCatalog(dir, () => clock.t);
    const provider = makeProvider(server.url);
    expect((await catalog.get(provider)).models.map((m) => m.id)).toEqual(['a']);
    clock.t += 60_000;
    await catalog.get(provider);
    expect(server.requests.filter((r) => r.path === '/v1/models')).toHaveLength(1);

    await server.close();
    server = undefined;
    clock.t += 25 * 60 * 60 * 1000;
    const stale = await catalog.get(provider);
    expect(stale).toMatchObject({ stale: true, fetchedAt: 0 });
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });
});

describe('debug log', () => {
  it('redacts keys by shape and by registered value', () => {
    expect(redact('key=gsk_abcdefgh12345678 and sk-or-v1-abcdef123456')).toBe(
      'key=[REDACTED] and [REDACTED]',
    );
    expect(redact('Authorization: Bearer abc.def-ghi_jkl')).toBe(
      'Authorization: Bearer [REDACTED]',
    );
    expect(redact('custom secret-token-xyz here', ['secret-token-xyz'])).toBe(
      'custom [REDACTED] here',
    );
  });

  it('writes redacted JSON lines', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vinax-log-'));
    const logger = createFileLogger(dir, () => new Date('2026-09-23T00:00:00Z'));
    logger.addSecret('my-plain-secret');
    logger.debug('request', { apiKey: 'gsk_abcdefgh12345678', note: 'my-plain-secret' });
    const text = await fs.readFile(path.join(dir, 'debug-2026-09-23.log'), 'utf8');
    expect(text).not.toContain('gsk_abcdefgh');
    expect(text).not.toContain('my-plain-secret');
    expect(JSON.parse(text)).toMatchObject({ event: 'request', apiKey: '[REDACTED]' });
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });
});

describe('request hygiene for strict (vLLM) chat templates', () => {
  const history: ChatMessage[] = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'hi' },
    // a reply that only reasoned: nothing to send
    { role: 'assistant', content: '' },
    { role: 'user', content: 'list files' },
    {
      role: 'assistant',
      content: '',
      toolCalls: [
        { id: 'c1', name: 'Glob', arguments: '' },
        { id: 'c2', name: 'Read', arguments: '{"path":' },
        { id: 'c3', name: 'Bash', arguments: '{"command":"ls"}' },
      ],
    },
    { role: 'tool', toolCallId: 'c1', name: 'Glob', content: 'a.ts' },
    { role: 'assistant', content: 'Done.' },
  ];

  it('drops empty assistant turns that carry no tool calls', () => {
    const wire = toWireMessages(history);
    expect(wire.map((m) => m.role)).toEqual([
      'system',
      'user',
      'user',
      'assistant',
      'tool',
      'assistant',
    ]);
    expect(toWireMessages([{ role: 'assistant', content: '  \n' }])).toEqual([]);
  });

  it('sends null content next to tool calls and {} for empty or broken arguments', () => {
    const call = toWireMessages(history)[3] as {
      content: unknown;
      tool_calls: { function: { arguments: string } }[];
    };
    expect(call.content).toBeNull();
    expect(call.tool_calls.map((c) => c.function.arguments)).toEqual([
      '{}',
      '{}',
      '{"command":"ls"}',
    ]);
    expect(wireArguments('[1]')).toBe('{}');
    expect(wireArguments(' {"a":1} ')).toBe(' {"a":1} ');
  });

  it('names the tool on tool results', () => {
    expect(toWireMessages(history)[4]).toEqual({
      role: 'tool',
      tool_call_id: 'c1',
      content: 'a.ts',
      name: 'Glob',
    });
  });

  it('sends the cleaned history on the wire', async () => {
    server = await startMockServer({ script: { m: [{ text: 'ok' }] } });
    await drain(
      makeProvider(server.url).stream({
        model: 'm',
        messages: history,
        signal: new AbortController().signal,
      }),
    );
    const body = server.requests.at(-1)?.body as { messages: { role: string }[] };
    expect(body.messages).toHaveLength(6);
    expect(body.messages[4]).toMatchObject({ role: 'tool', name: 'Glob' });
  });
});

describe('an error event partway through the stream', () => {
  it('surfaces as a server error after the text that came before it', async () => {
    server = await startMockServer({
      script: { m: [{ text: ['Hel', 'lo'], streamError: 'list index out of range' }] },
    });
    const seen: StreamDelta[] = [];
    const err = await (async () => {
      for await (const d of makeProvider(server.url).stream({
        model: 'm',
        messages: [{ role: 'user', content: 'hi' }],
        signal: new AbortController().signal,
      }))
        seen.push(d);
    })().catch((e: unknown) => e);
    expect(seen).toEqual([
      { type: 'text', text: 'Hel' },
      { type: 'text', text: 'lo' },
    ]);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).toMatchObject({ kind: 'server', message: 'Groq: list index out of range' });
  });
});
