import OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { z } from 'zod';
import type { Logger } from '../log/logger.js';
import { ProviderError, providerLabel, toProviderError } from './errors.js';
import { GATEWAY_WAKING, GatewayUnavailableError, type GatewayClient } from './gateway.js';
import type { RateLimitLedger } from './ratelimit.js';
import type {
  ChatMessage,
  ChatRequest,
  KeyCheck,
  ModelInfo,
  Provider,
  ProviderName,
  StreamDelta,
} from './types.js';

export interface OpenAICompatibleOptions {
  name: ProviderName;
  baseURL: string;
  apiKey: string;
  timeoutMs: number;
  ledger: RateLimitLedger;
  logger: Logger;
  defaultHeaders?: Record<string, string>;
  /** Authenticated GET used to validate a key (`/models` is public on some providers). */
  keyCheckPath: string;
  now?: () => number;
  /** Set when requests go through the VinaX gateway, which names models `<provider>:<id>`. */
  gateway?: GatewayClient;
}

const catalogEntrySchema = z.looseObject({
  id: z.string(),
  active: z.boolean().optional(),
  context_window: z.number().optional(),
  context_length: z.number().optional(),
  supported_parameters: z.array(z.string()).optional(),
  pricing: z.looseObject({ prompt: z.string(), completion: z.string() }).optional(),
});
const catalogSchema = z.looseObject({ data: z.array(z.unknown()) });

function toWire(m: ChatMessage): ChatCompletionMessageParam {
  switch (m.role) {
    case 'assistant':
      return m.toolCalls && m.toolCalls.length > 0
        ? {
            role: 'assistant',
            content: m.content === '' ? null : m.content,
            tool_calls: m.toolCalls.map((c) => ({
              id: c.id,
              type: 'function' as const,
              function: { name: c.name, arguments: c.arguments },
            })),
          }
        : { role: 'assistant', content: m.content };
    case 'tool':
      return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
    default:
      return { role: m.role, content: m.content };
  }
}

function toModelInfo(raw: unknown): ModelInfo | undefined {
  const parsed = catalogEntrySchema.safeParse(raw);
  if (!parsed.success || parsed.data.active === false) return undefined;
  const m = parsed.data;
  const zeroPrice =
    m.pricing !== undefined && Number(m.pricing.prompt) === 0 && Number(m.pricing.completion) === 0;
  return {
    id: m.id,
    contextWindow: m.context_window ?? m.context_length,
    supportsTools: m.supported_parameters?.includes('tools'),
    free: m.id.endsWith(':free') || zeroPrice,
  };
}

/** One OpenAI-compatible endpoint (Groq, OpenRouter) driven through the official `openai` SDK. */
export class OpenAICompatibleProvider implements Provider {
  readonly name: ProviderName;
  private readonly client: OpenAI;
  private readonly now: () => number;

  constructor(private readonly opts: OpenAICompatibleOptions) {
    this.name = opts.name;
    this.now = opts.now ?? Date.now;
    opts.logger.addSecret(opts.apiKey);
    this.client = new OpenAI({
      apiKey: opts.apiKey,
      baseURL: opts.baseURL,
      timeout: opts.timeoutMs,
      maxRetries: 0, // the router owns retries and fallback
      ...(opts.defaultHeaders ? { defaultHeaders: opts.defaultHeaders } : {}),
    });
  }

  /** The model id as the endpoint knows it. */
  private wireModel(model: string): string {
    return this.opts.gateway ? `${this.name}:${model}` : model;
  }

  /** Waits for a sleeping gateway; a gateway that never wakes becomes an `unavailable` error. */
  private async wakeGateway(signal?: AbortSignal): Promise<void> {
    try {
      await this.opts.gateway?.wake(signal);
    } catch (err) {
      if (err instanceof GatewayUnavailableError)
        throw new ProviderError('unavailable', err.message, this.name);
      throw err;
    }
  }

  private async getJson(
    pathname: string,
    signal?: AbortSignal,
  ): Promise<{ status: number; body: unknown }> {
    const res = await fetch(`${this.opts.baseURL.replace(/\/$/, '')}${pathname}`, {
      headers: { Authorization: `Bearer ${this.opts.apiKey}`, ...this.opts.defaultHeaders },
      signal: signal ?? AbortSignal.timeout(this.opts.timeoutMs),
    });
    const text = await res.text();
    if (res.ok) this.opts.gateway?.markOk();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      // keep text
    }
    return { status: res.status, body };
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const { status, body } = await this.getJson('/models', signal);
    if (status !== 200)
      throw new Error(`${providerLabel(this.name)} /models returned HTTP ${status}`);
    const parsed = catalogSchema.parse(body);
    const models = parsed.data.map(toModelInfo).filter((m): m is ModelInfo => m !== undefined);
    if (!this.opts.gateway) return models;
    const prefix = `${this.name}:`;
    return models
      .filter((m) => m.id.startsWith(prefix))
      .map((m) => ({ ...m, id: m.id.slice(prefix.length) }));
  }

  async accountInfo(signal?: AbortSignal): Promise<Record<string, string> | undefined> {
    if (this.opts.keyCheckPath !== '/key') return undefined;
    try {
      const { status, body } = await this.getJson('/key', signal);
      if (status !== 200 || typeof body !== 'object' || body === null) return undefined;
      const data = (body as { data?: Record<string, unknown> }).data ?? {};
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(data)) {
        if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')
          out[k] = String(v);
        else if (typeof v === 'object' && v !== null) out[k] = JSON.stringify(v);
      }
      return out;
    } catch {
      return undefined;
    }
  }

  async validateKey(signal?: AbortSignal): Promise<KeyCheck> {
    try {
      await this.wakeGateway(signal);
      const { status } = await this.getJson(this.opts.keyCheckPath, signal);
      if (status === 200) return { ok: true };
      if (status === 401 || status === 403)
        return { ok: false, rejected: true, reason: 'the key was rejected' };
      return { ok: false, rejected: false, reason: `unexpected HTTP ${status}` };
    } catch (err) {
      return {
        ok: false,
        rejected: false,
        reason: `could not reach ${providerLabel(this.name)} (${String(err)})`,
      };
    }
  }

  async *stream(req: ChatRequest): AsyncGenerator<StreamDelta> {
    const { logger, ledger, gateway } = this.opts;
    let started = this.now();
    logger.debug('request', {
      provider: this.name,
      model: req.model,
      messages: req.messages.length,
      tools: req.tools?.length ?? 0,
      maxTokens: req.maxTokens,
    });
    let chunks = 0;
    try {
      if (gateway && !gateway.isAwake() && !(await gateway.probe(undefined, req.signal)).ok) {
        yield { type: 'status', text: GATEWAY_WAKING };
        await this.wakeGateway(req.signal);
        yield { type: 'status', text: '' };
        started = this.now();
      }
      const { data, response } = await this.client.chat.completions
        .create(
          {
            model: this.wireModel(req.model),
            messages: req.messages.map(toWire),
            ...(req.tools && req.tools.length > 0
              ? {
                  tools: req.tools.map((t) => ({
                    type: 'function' as const,
                    function: {
                      name: t.name,
                      description: t.description,
                      parameters: t.parameters,
                    },
                  })),
                  tool_choice: 'auto' as const,
                }
              : {}),
            stream: true,
            stream_options: { include_usage: true },
            ...(req.maxTokens === undefined ? {} : { max_tokens: req.maxTokens }),
          },
          { signal: req.signal },
        )
        .withResponse();
      ledger.observe(this.name, req.model, response.headers);
      gateway?.markOk();
      logger.debug('response', {
        provider: this.name,
        model: req.model,
        status: response.status,
        ttfbMs: this.now() - started,
        rateLimit: ledger.snapshot(this.name, req.model),
      });
      for await (const chunk of data) {
        chunks++;
        const delta = chunk.choices[0]?.delta;
        const text = delta?.content;
        if (typeof text === 'string' && text !== '') yield { type: 'text', text };
        for (const tc of delta?.tool_calls ?? []) {
          yield {
            type: 'tool_call_delta',
            index: tc.index,
            ...(tc.id === undefined ? {} : { id: tc.id }),
            ...(tc.function?.name === undefined ? {} : { name: tc.function.name }),
            ...(tc.function?.arguments === undefined ? {} : { argsChunk: tc.function.arguments }),
          };
        }
        if (chunk.usage) {
          yield {
            type: 'usage',
            usage: {
              promptTokens: chunk.usage.prompt_tokens,
              completionTokens: chunk.usage.completion_tokens,
            },
          };
        }
      }
      // The SDK ends the iteration quietly when aborted; surface it so a cut-off answer is not
      // mistaken for a finished one.
      if (req.signal.aborted) throw new ProviderError('aborted', 'Request aborted', this.name);
      logger.debug('complete', {
        provider: this.name,
        model: req.model,
        chunks,
        ms: this.now() - started,
      });
    } catch (err) {
      const headers =
        err instanceof OpenAI.APIError ? (err.headers as Headers | undefined) : undefined;
      if (headers) ledger.observe(this.name, req.model, headers);
      const perr = toProviderError(err, this.name, this.now());
      logger.debug('error', {
        provider: this.name,
        model: req.model,
        kind: perr.kind,
        status: perr.status,
        message: perr.message,
        chunks,
      });
      throw perr;
    }
  }
}
