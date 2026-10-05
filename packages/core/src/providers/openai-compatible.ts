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
  /** How to prove a key works (`/models` is public on some providers). */
  keyCheck: KeyCheckMethod;
  now?: () => number;
  /** Set when requests go through the VinaX gateway, which names models `<provider>:<id>`. */
  gateway?: GatewayClient;
}

/** An authenticated GET, or a one-token completion when the provider has no such endpoint. */
export type KeyCheckMethod = { path: string } | { completionModel: string };

const catalogEntrySchema = z.looseObject({
  id: z.string(),
  active: z.boolean().optional(),
  context_window: z.number().optional(),
  context_length: z.number().optional(),
  /** vLLM-based servers (self-hosted NVIDIA NIM) report the context window here. */
  max_model_len: z.number().optional(),
  supported_parameters: z.array(z.string()).optional(),
  pricing: z.looseObject({ prompt: z.string(), completion: z.string() }).optional(),
  architecture: z.looseObject({ input_modalities: z.array(z.string()).optional() }).optional(),
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
    case 'user':
      return m.images && m.images.length > 0
        ? {
            role: 'user',
            content: [
              { type: 'text', text: m.content },
              ...m.images.map((img) => ({
                type: 'image_url' as const,
                image_url: { url: `data:${img.mediaType};base64,${img.data}` },
              })),
            ],
          }
        : { role: 'user', content: m.content };
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
  // a fixed published price only: OpenRouter uses -1 for variable pricing (e.g. routers)
  const prompt = Number(m.pricing?.prompt);
  const completion = Number(m.pricing?.completion);
  const priced =
    m.pricing !== undefined &&
    m.pricing.prompt.trim() !== '' &&
    m.pricing.completion.trim() !== '' &&
    Number.isFinite(prompt) &&
    Number.isFinite(completion) &&
    prompt >= 0 &&
    completion >= 0;
  return {
    id: m.id,
    contextWindow: m.context_window ?? m.context_length ?? m.max_model_len,
    supportsTools: m.supported_parameters?.includes('tools'),
    free: m.id.endsWith(':free') || zeroPrice,
    ...(m.architecture?.input_modalities === undefined
      ? {}
      : { vision: m.architecture.input_modalities.includes('image') }),
    ...(priced ? { pricing: { prompt, completion } } : {}),
  };
}

/** One OpenAI-compatible endpoint (Groq, OpenRouter, NVIDIA), driven by the `openai` SDK. */
export class OpenAICompatibleProvider implements Provider {
  readonly name: ProviderName;
  private readonly client: OpenAI;
  private readonly now: () => number;
  /** Models that rejected a reasoning-effort parameter; it is left out for them from then on. */
  private readonly noEffort = new Set<string>();

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
    post?: unknown,
  ): Promise<{ status: number; body: unknown }> {
    const res = await fetch(`${this.opts.baseURL.replace(/\/$/, '')}${pathname}`, {
      headers: {
        Authorization: `Bearer ${this.opts.apiKey}`,
        ...(post === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...this.opts.defaultHeaders,
      },
      ...(post === undefined ? {} : { method: 'POST', body: JSON.stringify(post) }),
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
    if (!('path' in this.opts.keyCheck) || this.opts.keyCheck.path !== '/key') return undefined;
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
      const check = this.opts.keyCheck;
      const { status } =
        'path' in check
          ? await this.getJson(check.path, signal)
          : await this.getJson('/chat/completions', signal, {
              model: this.wireModel(check.completionModel),
              messages: [{ role: 'user', content: 'ping' }],
              max_tokens: 1,
            });
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

  /** The provider's spelling of reasoning effort: OpenRouter nests it, others take it flat. */
  private effortParams(req: ChatRequest): Record<string, unknown> {
    if (req.reasoningEffort === undefined || this.noEffort.has(req.model)) return {};
    return this.name === 'openrouter'
      ? { reasoning: { effort: req.reasoningEffort } }
      : { reasoning_effort: req.reasoningEffort };
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
      const send = (extra: Record<string, unknown>) =>
        this.client.chat.completions
          .create(
            {
              ...extra,
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
      const effort = this.effortParams(req);
      let sent;
      try {
        sent = await send(effort);
      } catch (err) {
        // A provider that does not know the effort parameter gets the request again without it.
        const rejected =
          Object.keys(effort).length > 0 &&
          err instanceof OpenAI.APIError &&
          (err.status === 400 || err.status === 422) &&
          /reason/i.test(err.message);
        if (!rejected) throw err;
        this.noEffort.add(req.model);
        logger.debug('effort_unsupported', { provider: this.name, model: req.model });
        sent = await send({});
      }
      const { data, response } = sent;
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
        // reasoning models stream their thinking as `reasoning` (Groq, OpenRouter) or
        // `reasoning_content` (vLLM-based servers such as NVIDIA NIM)
        const extra = delta as { reasoning?: unknown; reasoning_content?: unknown } | undefined;
        const thought = extra?.reasoning ?? extra?.reasoning_content;
        if (typeof thought === 'string' && thought !== '')
          yield { type: 'reasoning', text: thought };
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
