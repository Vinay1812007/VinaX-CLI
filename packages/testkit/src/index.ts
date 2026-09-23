import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createDemoMcpServer } from './mcp-tools.js';
import type { AddressInfo } from 'node:net';

/** One scripted reply to a `POST /v1/chat/completions`. */
export interface MockTurn {
  status?: number;
  headers?: Record<string, string>;
  /** Streamed as SSE content deltas, one chunk per array entry. */
  text?: string | string[];
  /** Native tool calls, streamed after the text with their arguments split across two deltas. */
  toolCalls?: { id?: string; name: string; arguments: string }[];
  /** JSON error body for non-200 replies. */
  error?: { message: string; type?: string; code?: string };
  usage?: { prompt_tokens: number; completion_tokens: number };
  /** Delay before any bytes are sent. */
  delayMs?: number;
  /** Delay between streamed content chunks. */
  chunkDelayMs?: number;
  /** Destroy the socket after this many content chunks (simulates a dropped stream). */
  breakAfterChunks?: number;
}

export interface RecordedRequest {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  body: unknown;
}

export interface MockServerOptions {
  /** Queues of replies keyed by model id; `*` serves any model without its own queue. */
  script?: Record<string, MockTurn[]>;
  /** Served from `GET /v1/models`. When omitted, `/models` returns 404. */
  models?: { id: string; context_window?: number; supported_parameters?: string[] }[];
  /** Keys accepted as `Authorization: Bearer <key>`. Empty means any key. */
  apiKeys?: string[];
  /** Serves an unauthenticated `GET /health` like the VinaX gateway: 200 while it returns true, else 503. */
  health?: () => boolean;
}

export interface MockServer {
  /** Base URL including `/v1`, ready for a provider's `baseUrl`. */
  readonly url: string;
  readonly requests: RecordedRequest[];
  enqueue(model: string, ...turns: MockTurn[]): void;
  close(): Promise<void>;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (c: string) => {
      data += c;
    });
    req.on('end', () => {
      resolve(data);
    });
    req.on('error', reject);
  });
}

function sse(res: http.ServerResponse, payload: unknown): void {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function chunk(
  model: string,
  delta: Record<string, unknown>,
  finish: string | null = null,
): unknown {
  return {
    id: 'chatcmpl-mock',
    object: 'chat.completion.chunk',
    created: 0,
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
}

async function reply(res: http.ServerResponse, model: string, turn: MockTurn): Promise<void> {
  if (turn.delayMs !== undefined) await new Promise((r) => setTimeout(r, turn.delayMs));
  const status = turn.status ?? 200;
  if (status !== 200) {
    res.writeHead(status, { 'content-type': 'application/json', ...turn.headers });
    res.end(JSON.stringify({ error: turn.error ?? { message: `mock error ${status}` } }));
    return;
  }
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    ...turn.headers,
  });
  const parts = turn.text === undefined ? [] : Array.isArray(turn.text) ? turn.text : [turn.text];
  sse(res, chunk(model, { role: 'assistant', content: '' }));
  for (const [i, part] of parts.entries()) {
    if (turn.breakAfterChunks !== undefined && i >= turn.breakAfterChunks) {
      res.socket?.destroy();
      return;
    }
    if (turn.chunkDelayMs !== undefined && i > 0)
      await new Promise((r) => setTimeout(r, turn.chunkDelayMs));
    if (res.destroyed) return;
    sse(res, chunk(model, { content: part }));
  }
  for (const [index, call] of (turn.toolCalls ?? []).entries()) {
    const half = Math.floor(call.arguments.length / 2);
    sse(
      res,
      chunk(model, {
        tool_calls: [
          {
            index,
            id: call.id ?? `call_${String(index)}`,
            type: 'function',
            function: { name: call.name, arguments: call.arguments.slice(0, half) },
          },
        ],
      }),
    );
    sse(
      res,
      chunk(model, {
        tool_calls: [{ index, function: { arguments: call.arguments.slice(half) } }],
      }),
    );
  }
  sse(res, chunk(model, {}, turn.toolCalls && turn.toolCalls.length > 0 ? 'tool_calls' : 'stop'));
  const usage = turn.usage ?? { prompt_tokens: 10, completion_tokens: parts.length };
  sse(res, {
    id: 'chatcmpl-mock',
    object: 'chat.completion.chunk',
    created: 0,
    model,
    choices: [],
    usage: { ...usage, total_tokens: usage.prompt_tokens + usage.completion_tokens },
  });
  res.write('data: [DONE]\n\n');
  res.end();
}

/** A scriptable OpenAI-compatible server for tests and offline demos. */
export async function startMockServer(opts: MockServerOptions = {}): Promise<MockServer> {
  const queues = new Map<string, MockTurn[]>(
    Object.entries(opts.script ?? {}).map(([k, v]) => [k, [...v]]),
  );
  const requests: RecordedRequest[] = [];
  const keys = opts.apiKeys ?? [];

  const server = http.createServer((req, res) => {
    void (async () => {
      const raw = await readBody(req);
      let body: unknown = raw;
      try {
        body = raw === '' ? undefined : JSON.parse(raw);
      } catch {
        // keep raw text
      }
      const path = (req.url ?? '/').split('?')[0] ?? '/';
      requests.push({ method: req.method ?? 'GET', path, headers: req.headers, body });

      if (req.method === 'GET' && path === '/health' && opts.health) {
        const up = opts.health();
        res.writeHead(up ? 200 : 503, { 'content-type': 'application/json' });
        res.end(JSON.stringify(up ? { status: 'ok', version: 'mock' } : { status: 'starting' }));
        return;
      }
      const auth = req.headers.authorization ?? '';
      const key = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      if (key === '' || (keys.length > 0 && !keys.includes(key))) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Invalid API Key' } }));
        return;
      }

      if (req.method === 'GET' && path === '/v1/models' && opts.models) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: opts.models }));
        return;
      }
      if (req.method === 'GET' && path === '/v1/key') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: { label: 'mock', is_free_tier: true } }));
        return;
      }
      if (req.method === 'POST' && path === '/v1/chat/completions') {
        const model =
          typeof body === 'object' && body !== null && 'model' in body ? String(body.model) : '';
        const queue = queues.get(model) ?? queues.get('*');
        const turn = queue?.shift();
        if (!turn) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: `mock: no scripted reply for ${model}` } }));
          return;
        }
        await reply(res, model, turn);
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'not found' } }));
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    enqueue(model, ...turns) {
      queues.set(model, [...(queues.get(model) ?? []), ...turns]);
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      }),
  };
}

/** Path of the stdio MCP demo server script (run it with `node --import tsx <path>`). */
export const MCP_STDIO_SERVER = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'mcp-stdio-server.ts',
);

/** A stateless streamable-HTTP MCP server with the demo tools, at `<url>/mcp`. */
export async function startMockMcpHttpServer(): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  const server = http.createServer((req, res) => {
    void (async () => {
      const raw = await readBody(req);
      const mcp = createDemoMcpServer('remote');
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => {
        void transport.close();
        void mcp.close();
      });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, raw === '' ? undefined : JSON.parse(raw));
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(port)}/mcp`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}

/**
 * The parts of the real environment a child process needs: PATH everywhere, and on Windows the
 * variables that locate Git Bash, PowerShell and the temp folder. Tests use it instead of the
 * whole environment, so real API keys never leak into them.
 */
export function systemEnv(): Record<string, string> {
  const keys = [
    'PATH',
    'SystemRoot',
    'windir',
    'ComSpec',
    'PATHEXT',
    'ProgramFiles',
    'ProgramFiles(x86)',
    'ProgramData',
    'LOCALAPPDATA',
    'APPDATA',
    'USERPROFILE',
    'HOMEDRIVE',
    'HOMEPATH',
    'TEMP',
    'TMP',
  ];
  const out: Record<string, string> = {};
  for (const k of keys) {
    const v = process.env[k];
    if (v !== undefined) out[k] = v;
  }
  return out;
}
