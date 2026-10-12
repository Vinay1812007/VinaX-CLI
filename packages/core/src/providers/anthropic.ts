import { z } from 'zod';
import type { Logger } from '../log/logger.js';
import { ProviderError, toProviderError } from './errors.js';
import { parseRetryAfter, type RateLimitLedger } from './ratelimit.js';
import type {
  ChatMessage,
  ChatRequest,
  KeyCheck,
  ModelInfo,
  Provider,
  StreamDelta,
} from './types.js';

const usageSchema = z.object({
  input_tokens: z.number().optional(),
  output_tokens: z.number().optional(),
  cache_creation_input_tokens: z.number().optional(),
  cache_read_input_tokens: z.number().optional(),
});
const eventSchema = z.object({
  type: z.string(),
  index: z.number().optional(),
  message: z.object({ usage: usageSchema }).optional(),
  usage: usageSchema.optional(),
  error: z.object({ type: z.string(), message: z.string() }).optional(),
  content_block: z
    .object({ type: z.string(), id: z.string().optional(), name: z.string().optional() })
    .optional(),
  delta: z
    .object({
      type: z.string().optional(),
      text: z.string().optional(),
      partial_json: z.string().optional(),
    })
    .optional(),
});
const catalogSchema = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      max_input_tokens: z.number().nullish(),
      lifecycle: z.string().optional(),
    }),
  ),
  has_more: z.boolean().optional(),
  last_id: z.string().nullish(),
});

/** Decode SSE across arbitrary UTF-8 chunks, accepting LF and CRLF framing. */
async function* events(
  body: NonNullable<Response['body']>,
): AsyncGenerator<z.infer<typeof eventSchema>> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = (await reader.read()) as { value?: Uint8Array; done: boolean };
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      for (;;) {
        const end = /\r?\n\r?\n/.exec(buffer);
        if (!end) break;
        const frame = buffer.slice(0, end.index);
        buffer = buffer.slice(end.index + end[0].length);
        const data = frame
          .split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).replace(/^ /, ''))
          .join('\n');
        if (data !== '') yield eventSchema.parse(JSON.parse(data));
      }
      if (done) break;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function wire(messages: readonly ChatMessage[]): { system?: string; messages: unknown[] } {
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n');
  const out: { role: 'user' | 'assistant'; content: Record<string, unknown>[] }[] = [];
  for (const m of messages) {
    if (m.role === 'system') continue;
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    const content: Record<string, unknown>[] = [];
    if (m.role === 'tool')
      content.push({ type: 'tool_result', tool_use_id: m.toolCallId, content: m.content });
    else {
      if (m.role === 'user')
        for (const i of m.images ?? [])
          content.push({
            type: 'image',
            source: { type: 'base64', media_type: i.mediaType, data: i.data },
          });
      if (m.content !== '') content.push({ type: 'text', text: m.content });
      if (m.role === 'assistant')
        for (const t of m.toolCalls ?? []) {
          let input: unknown;
          try {
            input = JSON.parse(t.arguments || '{}');
          } catch {
            throw new ProviderError(
              'tool_format',
              'Claude tool arguments must be valid JSON',
              'claude',
            );
          }
          content.push({ type: 'tool_use', id: t.id, name: t.name, input });
        }
    }
    if (content.length === 0) continue;
    // Parallel tool results must arrive together in the next user message.
    const previous = out.at(-1);
    if (previous?.role === role) previous.content.push(...content);
    else out.push({ role, content });
  }
  return { ...(system === '' ? {} : { system }), messages: out };
}

/** Native Anthropic Messages API, with live catalogs and router-owned retries. */
export class AnthropicProvider implements Provider {
  readonly name = 'claude' as const;
  private readonly base: string;
  constructor(
    baseURL: string,
    private readonly apiKey: string,
    private readonly timeoutMs: number,
    private readonly ledger: RateLimitLedger,
    logger: Logger,
  ) {
    this.base = baseURL.replace(/\/+$/, '');
    logger.addSecret(apiKey);
  }

  private async request(path: string, signal?: AbortSignal, body?: unknown): Promise<Response> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      const res = await fetch(`${this.base}${path}`, {
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
        },
        signal: combined,
        ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
      });
      if (res.ok) return res;
      const raw: unknown = await res.json().catch(() => undefined);
      const parsed = z.object({ error: z.object({ message: z.string() }) }).safeParse(raw);
      const kind =
        res.status === 401 || res.status === 403
          ? 'auth'
          : res.status === 429
            ? 'rate_limit'
            : res.status === 404
              ? 'not_found'
              : res.status === 413
                ? 'too_large'
                : res.status >= 500
                  ? 'server'
                  : 'bad_request';
      throw new ProviderError(
        kind,
        `Claude ${res.status}: ${parsed.success ? parsed.data.error.message : res.statusText}`,
        this.name,
        res.status,
        parseRetryAfter(res.headers, Date.now()),
      );
    } catch (err) {
      if (signal?.aborted) throw new ProviderError('aborted', 'Request aborted', this.name);
      if (timeout.aborted)
        throw new ProviderError('timeout', 'Claude did not respond in time', this.name);
      throw toProviderError(err, this.name, Date.now());
    }
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const models: ModelInfo[] = [];
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
      const page = catalogSchema.parse(
        await (
          await this.request(
            `/models?limit=100${cursor ? `&after_id=${encodeURIComponent(cursor)}` : ''}`,
            signal,
          )
        ).json(),
      );
      for (const m of page.data)
        if (m.lifecycle !== 'retired')
          models.push({
            id: m.id,
            contextWindow: m.max_input_tokens ?? undefined,
            supportsTools: true,
            free: false,
            vision: true,
          });
      if (!page.has_more) break;
      if (!page.last_id || seen.has(page.last_id))
        throw new Error('Claude returned an invalid model pagination cursor');
      cursor = page.last_id;
      seen.add(cursor);
    } while (cursor);
    return models;
  }

  async validateKey(signal?: AbortSignal): Promise<KeyCheck> {
    try {
      await this.listModels(signal);
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        rejected: err instanceof ProviderError && err.kind === 'auth',
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async *stream(req: ChatRequest): AsyncGenerator<StreamDelta> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    try {
      const res = await this.request('/messages', AbortSignal.any([req.signal, timeout]), {
        model: req.model,
        max_tokens: req.maxTokens ?? 8192,
        stream: true,
        ...wire(req.messages),
        ...(req.tools?.length
          ? {
              tools: req.tools.map((t) => ({
                name: t.name,
                description: t.description,
                input_schema: t.parameters,
              })),
            }
          : {}),
      });
      this.ledger.observe(this.name, req.model, res.headers);
      if (!res.body)
        throw new ProviderError('server', 'Claude returned an empty stream', this.name);
      let promptTokens = 0;
      let completionTokens = 0;
      let stopped = false;
      for await (const e of events(res.body)) {
        if (e.type === 'error')
          throw new ProviderError(
            e.error?.type === 'rate_limit_error' ? 'rate_limit' : 'server',
            `Claude: ${e.error?.message ?? 'stream error'}`,
            this.name,
          );
        if (e.type === 'message_start' && e.message) {
          const u = e.message.usage;
          promptTokens =
            (u.input_tokens ?? 0) +
            (u.cache_creation_input_tokens ?? 0) +
            (u.cache_read_input_tokens ?? 0);
          completionTokens = u.output_tokens ?? 0;
        }
        if (
          e.type === 'content_block_start' &&
          e.content_block?.type === 'tool_use' &&
          e.index !== undefined &&
          e.content_block.id &&
          e.content_block.name
        )
          yield {
            type: 'tool_call_delta',
            index: e.index,
            id: e.content_block.id,
            name: e.content_block.name,
          };
        if (e.type === 'content_block_delta') {
          if (e.delta?.type === 'text_delta' && e.delta.text)
            yield { type: 'text', text: e.delta.text };
          if (
            e.delta?.type === 'input_json_delta' &&
            e.delta.partial_json !== undefined &&
            e.index !== undefined
          )
            yield { type: 'tool_call_delta', index: e.index, argsChunk: e.delta.partial_json };
        }
        if (e.type === 'message_delta')
          completionTokens = e.usage?.output_tokens ?? completionTokens;
        if (e.type === 'message_stop') {
          stopped = true;
          break;
        }
      }
      if (!stopped)
        throw new ProviderError('network', 'Claude stream ended before message_stop', this.name);
      yield { type: 'usage', usage: { promptTokens, completionTokens } };
    } catch (err) {
      if (req.signal.aborted) throw new ProviderError('aborted', 'Request aborted', this.name);
      if (timeout.aborted || (err instanceof Error && err.name === 'TimeoutError'))
        throw new ProviderError('timeout', 'Claude stream timed out', this.name);
      throw toProviderError(err, this.name, Date.now());
    }
  }
}
