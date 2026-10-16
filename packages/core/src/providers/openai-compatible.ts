import OpenAI from 'openai';
import type {
  ChatCompletionContentPartImage,
  ChatCompletionMessageParam,
} from 'openai/resources/chat/completions';
import { z } from 'zod';
import type { Logger } from '../log/logger.js';
import { chatModels } from './chat-models.js';
import { ProviderError, providerLabel, toProviderError } from './errors.js';
import { GATEWAY_WAKING, GatewayUnavailableError, type GatewayClient } from './gateway.js';
import { findCatalogModel, restrictToFreeModels } from './nvidia-free.js';
import type { RateLimitLedger } from './ratelimit.js';
import {
  KEY_CHECK_TIMEOUT_MS,
  type ChatMessage,
  type ChatRequest,
  type KeyCheck,
  type ModelInfo,
  type Provider,
  type ProviderName,
  type StreamDelta,
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
  /**
   * Every endpoint in this provider's catalog is free to call, so the catalog needs no price to
   * prove it. NVIDIA's hosted NIM endpoints are all free (rate-limited) and its `/models` reports
   * only `id`/`owned_by`, which would otherwise leave every model looking paid.
   */
  freeCatalog?: boolean;
  now?: () => number;
  /** Set when requests go through the VinaX gateway, which names models `<provider>:<id>`. */
  gateway?: GatewayClient;
  /** How long checking a key may take (defaults to {@link KEY_CHECK_TIMEOUT_MS}). */
  keyCheckTimeoutMs?: number;
}

/**
 * An authenticated GET, or one-token completions when the provider has no such endpoint. The
 * completion check tries every listed model (and a few chat models from the public catalog) at
 * once and passes as soon as one answers, so a single hung model cannot fail a good key.
 */
export type KeyCheckMethod = { path: string } | { completionModels: readonly string[] };

/** Catalog models added to a completion key check, beyond the configured ones. */
const KEY_CHECK_CATALOG_SAMPLE = 4;

function verdict(status: number): KeyCheck {
  if (status === 200) return { ok: true };
  if (status === 401 || status === 403)
    return { ok: false, rejected: true, reason: 'the key was rejected' };
  return { ok: false, rejected: false, reason: `unexpected HTTP ${String(status)}` };
}

const catalogEntrySchema = z.looseObject({
  id: z.string(),
  active: z.boolean().optional(),
  context_window: z.number().optional(),
  context_length: z.number().optional(),
  /** vLLM-based servers (self-hosted NVIDIA NIM) report the context window here. */
  max_model_len: z.number().optional(),
  max_context_length: z.number().optional(),
  capabilities: z
    .object({
      completion_chat: z.boolean().optional(),
      function_calling: z.boolean().optional(),
      vision: z.boolean().optional(),
    })
    .optional(),
  supported_parameters: z.array(z.string()).optional(),
  pricing: z.looseObject({ prompt: z.string(), completion: z.string() }).optional(),
  architecture: z.looseObject({ input_modalities: z.array(z.string()).optional() }).optional(),
});
const catalogSchema = z.looseObject({ data: z.array(z.unknown()) });

/**
 * Tool-call arguments as a JSON object text: an empty or broken one becomes `{}`. vLLM-based
 * servers (NVIDIA NIM) re-parse the history's arguments, and malformed history is a suspected
 * trigger of gpt-oss's mid-reply "list index out of range".
 */
export function wireArguments(args: string): string {
  if (args.trim() === '') return '{}';
  try {
    const parsed: unknown = JSON.parse(args);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? args : '{}';
  } catch {
    return '{}';
  }
}

/**
 * The conversation as sent: an assistant message with neither text nor tool calls (a reply that
 * only reasoned) is left out, since strict chat templates break on empty turns.
 */
export function toWireMessages(messages: readonly ChatMessage[]): ChatCompletionMessageParam[] {
  return messages
    .filter(
      (m) =>
        m.role !== 'assistant' ||
        m.content.trim() !== '' ||
        (m.toolCalls !== undefined && m.toolCalls.length > 0),
    )
    .map(toWire);
}

function toWire(m: ChatMessage): ChatCompletionMessageParam {
  switch (m.role) {
    case 'assistant':
      return m.toolCalls && m.toolCalls.length > 0
        ? {
            role: 'assistant',
            // null is what the OpenAI spec and vLLM's gpt-oss (harmony) path expect alongside
            // tool calls; text, when there is some, is kept
            content: m.content.trim() === '' ? null : m.content,
            tool_calls: m.toolCalls.map((c) => ({
              id: c.id,
              type: 'function' as const,
              function: { name: c.name, arguments: wireArguments(c.arguments) },
            })),
          }
        : { role: 'assistant', content: m.content };
    case 'tool':
      // `name` is not in the OpenAI types, but vLLM's gpt-oss path reads it to address the result
      return {
        role: 'tool',
        tool_call_id: m.toolCallId,
        content: m.content,
        name: m.name,
      } as ChatCompletionMessageParam;
    case 'user':
      return (m.images && m.images.length > 0) || (m.videos && m.videos.length > 0)
        ? {
            role: 'user',
            content: [
              { type: 'text', text: m.content },
              ...(m.images ?? []).map((img) => ({
                type: 'image_url' as const,
                image_url: { url: `data:${img.mediaType};base64,${img.data}` },
              })),
              // `video_url` is an extension (NVIDIA, vLLM) the SDK's types do not know
              ...((m.videos ?? []).map((v) => ({
                type: 'video_url',
                video_url: { url: `data:${v.mediaType};base64,${v.data}` },
              })) as unknown as ChatCompletionContentPartImage[]),
            ],
          }
        : { role: 'user', content: m.content };
    default:
      return { role: m.role, content: m.content };
  }
}

function toModelInfo(raw: unknown, freeCatalog = false): ModelInfo | undefined {
  const parsed = catalogEntrySchema.safeParse(raw);
  if (
    !parsed.success ||
    parsed.data.active === false ||
    parsed.data.capabilities?.completion_chat === false
  )
    return undefined;
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
    contextWindow: m.context_window ?? m.context_length ?? m.max_model_len ?? m.max_context_length,
    supportsTools: m.capabilities?.function_calling ?? m.supported_parameters?.includes('tools'),
    free: freeCatalog || m.id.endsWith(':free') || zeroPrice,
    ...(m.architecture?.input_modalities === undefined
      ? m.capabilities?.vision === undefined
        ? {}
        : { vision: m.capabilities.vision }
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
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(this.opts.timeoutMs)])
        : AbortSignal.timeout(this.opts.timeoutMs),
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
    const free = this.opts.freeCatalog === true;
    const models = parsed.data
      .map((m) => toModelInfo(m, free))
      .filter((m): m is ModelInfo => m !== undefined);
    if (!this.opts.gateway) return restrictToFreeModels(this.name, models);
    const prefix = `${this.name}:`;
    return restrictToFreeModels(
      this.name,
      models
        .filter((m) => m.id.startsWith(prefix))
        .map((m) => ({ ...m, id: m.id.slice(prefix.length) })),
    );
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
    const limitMs = this.opts.keyCheckTimeoutMs ?? KEY_CHECK_TIMEOUT_MS;
    const label = providerLabel(this.name);
    try {
      // a sleeping gateway gets its own (longer) wake-up budget before the check starts
      await this.wakeGateway(signal);
      const timeout = AbortSignal.timeout(limitMs);
      const bounded = signal ? AbortSignal.any([signal, timeout]) : timeout;
      const check = this.opts.keyCheck;
      try {
        if ('path' in check) return verdict((await this.getJson(check.path, bounded)).status);
        return await this.completionCheck(check.completionModels, bounded);
      } catch (err) {
        if (timeout.aborted && signal?.aborted !== true)
          return {
            ok: false,
            rejected: false,
            reason: `${label} did not answer within ${String(Math.round(limitMs / 1000))}s`,
          };
        throw err;
      }
    } catch (err) {
      return {
        ok: false,
        rejected: false,
        reason: `could not reach ${label} (${String(err)})`,
      };
    }
  }

  /** One-token completions to several models at once; the first answer proves the key. */
  private async completionCheck(
    configured: readonly string[],
    signal: AbortSignal,
  ): Promise<KeyCheck> {
    const list = await this.listModels(signal).catch((): ModelInfo[] => []);
    const sample = chatModels(list, this.name)
      .map((m) => m.id)
      .filter((id) => /instruct|chat/i.test(id))
      .slice(0, KEY_CHECK_CATALOG_SAMPLE);
    // the catalog's spelling of each configured model, where it lists one
    const named = configured.map((id) => findCatalogModel(this.name, list, id)?.id ?? id);
    const models = [...new Set([...named, ...sample])];
    const done = new AbortController();
    const shared = AbortSignal.any([signal, done.signal]);
    const statuses: number[] = [];
    const attempts = models.map(async (model) => {
      const { status } = await this.getJson('/chat/completions', shared, {
        model: this.wireModel(model),
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
      });
      statuses.push(status);
      if (status !== 200) throw new Error(`HTTP ${String(status)}`);
    });
    try {
      await Promise.any(attempts);
      return { ok: true };
    } catch (err) {
      if (statuses.length === 0) throw err instanceof AggregateError ? err.errors[0] : err;
      if (statuses.length === models.length && statuses.every((s) => s === 401 || s === 403))
        return verdict(statuses[0] ?? 401);
      if (signal.aborted) throw err instanceof AggregateError ? err.errors[0] : err;
      return verdict(statuses.find((s) => s !== 401 && s !== 403) ?? statuses[0] ?? 0);
    } finally {
      // the other requests are no longer needed once one answered (or all failed)
      done.abort();
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
              messages: toWireMessages(req.messages),
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
