import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { AnthropicProvider } from '../src/providers/anthropic.js';
import { noopLogger, RateLimitLedger, type StreamDelta } from '../src/index.js';

let server: Server | undefined;
afterEach(async () => {
  if (!server) return;
  server.closeAllConnections();
  await new Promise<void>((resolve) => {
    server?.close(() => {
      resolve();
    });
  });
  server = undefined;
});
async function provider(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  timeout = 1000,
) {
  server = createServer(handler);
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('No test address');
  return new AnthropicProvider(
    `http://127.0.0.1:${addr.port}/v1`,
    'test-key',
    timeout,
    new RateLimitLedger(() => Infinity),
    noopLogger,
  );
}
async function drain(stream: AsyncIterable<StreamDelta>) {
  const out: StreamDelta[] = [];
  for await (const d of stream) out.push(d);
  return out;
}
const request = {
  model: 'claude-test',
  messages: [{ role: 'user' as const, content: 'hello' }],
  signal: new AbortController().signal,
};
const frame = (data: unknown) => `data: ${JSON.stringify(data)}\r\n\r\n`;

describe('Claude native API', () => {
  it('discovers live models with pagination and validates without a billable completion', async () => {
    const calls: string[] = [];
    const p = await provider((req, res) => {
      calls.push(req.url ?? '');
      expect(req.headers['x-api-key']).toBe('test-key');
      expect(req.headers['anthropic-version']).toBe('2023-06-01');
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify(
          req.url?.includes('after_id=')
            ? { data: [{ id: 'claude-b' }], has_more: false }
            : {
                data: [{ id: 'claude-a', max_input_tokens: 200000 }],
                has_more: true,
                last_id: 'claude-a',
              },
        ),
      );
    });
    expect((await p.listModels()).map((m) => m.id)).toEqual(['claude-a', 'claude-b']);
    expect(await p.validateKey()).toEqual({ ok: true });
    expect(calls.every((url) => url.startsWith('/v1/models?'))).toBe(true);
  });

  it('streams fragmented CRLF events and reports cumulative input, cache and output usage', async () => {
    const p = await provider((_req, res) => {
      res.setHeader('content-type', 'text/event-stream');
      const payload = Buffer.from(
        [
          {
            type: 'message_start',
            message: { usage: { input_tokens: 11, cache_read_input_tokens: 3 } },
          },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Héllo' } },
          {
            type: 'content_block_start',
            index: 1,
            content_block: { type: 'tool_use', id: 'call-1', name: 'Read' },
          },
          {
            type: 'content_block_delta',
            index: 1,
            delta: { type: 'input_json_delta', partial_json: '{"file_path":"a"}' },
          },
          { type: 'message_delta', usage: { output_tokens: 9 } },
          { type: 'message_stop' },
        ]
          .map(frame)
          .join(''),
      );
      for (let i = 0; i < payload.length; i += 3) res.write(payload.subarray(i, i + 3));
      res.end();
    });
    expect(await drain(p.stream(request))).toEqual([
      { type: 'text', text: 'Héllo' },
      { type: 'tool_call_delta', index: 1, id: 'call-1', name: 'Read' },
      { type: 'tool_call_delta', index: 1, argsChunk: '{"file_path":"a"}' },
      { type: 'usage', usage: { promptTokens: 14, completionTokens: 9 } },
    ]);
  });

  it('sends parallel tool results in one user message', async () => {
    let body: unknown;
    const p = await provider((req, res) => {
      let text = '';
      req.setEncoding('utf8');
      req.on('data', (chunk: string) => {
        text += chunk;
      });
      req.on('end', () => {
        body = JSON.parse(text);
        res.end(frame({ type: 'message_stop' }));
      });
    });
    await drain(
      p.stream({
        ...request,
        messages: [
          { role: 'system', content: 'System' },
          {
            role: 'assistant',
            content: '',
            toolCalls: [
              { id: 'a', name: 'Read', arguments: '{}' },
              { id: 'b', name: 'Read', arguments: '{}' },
            ],
          },
          { role: 'tool', toolCallId: 'a', name: 'Read', content: 'one' },
          { role: 'tool', toolCallId: 'b', name: 'Read', content: 'two' },
        ],
      }),
    );
    expect(body).toMatchObject({
      system: 'System',
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'a' },
            { type: 'tool_use', id: 'b' },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'a' },
            { type: 'tool_result', tool_use_id: 'b' },
          ],
        },
      ],
    });
  });

  it.each([401, 429, 500])(
    'classifies HTTP %i errors and preserves retry-after',
    async (status) => {
      const p = await provider((_req, res) => {
        res.writeHead(status, { 'retry-after': '2' });
        res.end(JSON.stringify({ error: { message: 'provider detail' } }));
      });
      await expect(drain(p.stream(request))).rejects.toMatchObject({
        kind: status === 401 ? 'auth' : status === 429 ? 'rate_limit' : 'server',
        retryAfterMs: 2000,
        message: `Claude ${status}: provider detail`,
      });
    },
  );

  it('rejects a truncated stream and an in-stream error', async () => {
    let error = false;
    const p = await provider((_req, res) => {
      res.end(
        frame(
          error
            ? { type: 'error', error: { type: 'overloaded_error', message: 'busy' } }
            : { type: 'ping' },
        ),
      );
    });
    await expect(drain(p.stream(request))).rejects.toMatchObject({ kind: 'network' });
    error = true;
    await expect(drain(p.stream(request))).rejects.toMatchObject({
      kind: 'server',
      message: 'Claude: busy',
    });
  });

  it('times out a stalled stream even when a caller supplies a signal', async () => {
    const p = await provider((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(frame({ type: 'ping' }));
    }, 50);
    await expect(drain(p.stream(request))).rejects.toMatchObject({ kind: 'timeout' });
  });
});
