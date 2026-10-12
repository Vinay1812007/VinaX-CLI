/* The Anthropic SSE event envelope is intentionally forward-compatible; narrow it at runtime. */
/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any */
import type { Logger } from '../log/logger.js';
import { ProviderError, providerLabel } from './errors.js';
import type { RateLimitLedger } from './ratelimit.js';
import type {
  ChatMessage,
  ChatRequest,
  KeyCheck,
  ModelInfo,
  Provider,
  StreamDelta,
} from './types.js';

const MODELS: ModelInfo[] = [
  { id: 'claude-sonnet-5', contextWindow: 200_000, supportsTools: true, free: false, vision: true },
  { id: 'claude-opus-5', contextWindow: 200_000, supportsTools: true, free: false, vision: true },
  {
    id: 'claude-haiku-4-5-20251001',
    contextWindow: 200_000,
    supportsTools: true,
    free: false,
    vision: true,
  },
];

/** Native Anthropic Messages API adapter (Claude is not an OpenAI-compatible API). */
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
    this.base = baseURL.replace(/\/$/, '');
    logger.addSecret(apiKey);
  }

  listModels(): Promise<ModelInfo[]> {
    return Promise.resolve(MODELS);
  }

  private headers(): Record<string, string> {
    return {
      'content-type': 'application/json',
      'x-api-key': this.apiKey,
      'anthropic-version': '2023-06-01',
    };
  }

  async validateKey(signal?: AbortSignal): Promise<KeyCheck> {
    try {
      const res = await fetch(`${this.base}/messages`, {
        method: 'POST',
        headers: this.headers(),
        signal: signal ?? AbortSignal.timeout(this.timeoutMs),
        body: JSON.stringify({
          model: MODELS[2]?.id ?? 'claude-haiku-4-5-20251001',
          max_tokens: 1,
          messages: [{ role: 'user', content: 'ping' }],
        }),
      });
      if (res.ok) return { ok: true };
      if (res.status === 401 || res.status === 403)
        return { ok: false, rejected: true, reason: 'the key was rejected' };
      return { ok: false, rejected: false, reason: `unexpected HTTP ${res.status}` };
    } catch (err) {
      return { ok: false, rejected: false, reason: `could not reach Claude (${String(err)})` };
    }
  }

  private wire(messages: readonly ChatMessage[]): { system?: string; messages: unknown[] } {
    const system = messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n');
    const wire = messages
      .filter((m) => m.role !== 'system')
      .map((m) => {
        if (m.role === 'tool')
          return {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: m.toolCallId, content: m.content }],
          };
        if (m.role === 'assistant' && m.toolCalls?.length)
          return {
            role: 'assistant',
            content: [
              ...(m.content === '' ? [] : [{ type: 'text', text: m.content }]),
              ...m.toolCalls.map((t) => ({
                type: 'tool_use',
                id: t.id,
                name: t.name,
                input: JSON.parse(t.arguments),
              })),
            ],
          };
        if (m.role === 'user' && m.images?.length)
          return {
            role: 'user',
            content: [
              ...m.images.map((i) => ({
                type: 'image',
                source: { type: 'base64', media_type: i.mediaType, data: i.data },
              })),
              { type: 'text', text: m.content },
            ],
          };
        return { role: m.role, content: m.content };
      });
    return system === '' ? { messages: wire } : { system, messages: wire };
  }

  async *stream(req: ChatRequest): AsyncGenerator<StreamDelta> {
    const res = await fetch(`${this.base}/messages`, {
      method: 'POST',
      headers: this.headers(),
      signal: req.signal,
      body: JSON.stringify({
        model: req.model,
        max_tokens: req.maxTokens ?? 8192,
        stream: true,
        ...this.wire(req.messages),
        ...(req.tools?.length
          ? {
              tools: req.tools.map((t) => ({
                name: t.name,
                description: t.description,
                input_schema: t.parameters,
              })),
            }
          : {}),
      }),
    });
    this.ledger.observe(this.name, req.model, res.headers);
    if (!res.ok || res.body === null)
      throw new ProviderError(
        res.status === 401 || res.status === 403
          ? 'auth'
          : res.status === 429
            ? 'rate_limit'
            : res.status >= 500
              ? 'server'
              : 'bad_request',
        `${providerLabel(this.name)} ${res.status}`,
        this.name,
        res.status,
      );
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    let toolIndex = 0;
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      buffer += next.value;
      const events = buffer.split('\n\n');
      buffer = events.pop() ?? '';
      for (const event of events) {
        const data = event
          .split('\n')
          .find((line) => line.startsWith('data: '))
          ?.slice(6);
        if (!data) continue;
        let value: any;
        try {
          value = JSON.parse(data);
        } catch {
          continue;
        }
        if (value.type === 'content_block_delta' && value.delta?.type === 'text_delta')
          yield { type: 'text', text: value.delta.text };
        if (value.type === 'content_block_start' && value.content_block?.type === 'tool_use') {
          toolIndex = value.index;
          yield {
            type: 'tool_call_delta',
            index: toolIndex,
            id: value.content_block.id,
            name: value.content_block.name,
          };
        }
        if (value.type === 'content_block_delta' && value.delta?.type === 'input_json_delta')
          yield {
            type: 'tool_call_delta',
            index: value.index ?? toolIndex,
            argsChunk: value.delta.partial_json,
          };
        if (value.type === 'message_delta' && value.usage?.output_tokens !== undefined)
          yield {
            type: 'usage',
            usage: { promptTokens: 0, completionTokens: value.usage.output_tokens },
          };
        if (value.type === 'message_start' && value.message?.usage)
          yield {
            type: 'usage',
            usage: { promptTokens: value.message.usage.input_tokens ?? 0, completionTokens: 0 },
          };
      }
    }
  }
}
