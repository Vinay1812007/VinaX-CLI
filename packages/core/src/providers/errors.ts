import { APIConnectionError, APIConnectionTimeoutError, APIError, APIUserAbortError } from 'openai';
import { parseRetryAfter } from './ratelimit.js';
import type { ProviderName } from './types.js';

export type ProviderErrorKind =
  | 'rate_limit'
  | 'too_large'
  | 'auth'
  | 'not_found'
  | 'bad_request'
  /** The model produced a malformed tool call, or the endpoint does not support tools. */
  | 'tool_format'
  | 'server'
  | 'timeout'
  | 'network'
  /** The endpoint cannot be used right now (a VinaX gateway that did not wake up). */
  | 'unavailable'
  | 'aborted';

export class ProviderError extends Error {
  constructor(
    readonly kind: ProviderErrorKind,
    message: string,
    readonly provider: ProviderName,
    readonly status?: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

const LABEL: Record<ProviderName, string> = { groq: 'Groq', openrouter: 'OpenRouter' };

export function providerLabel(name: ProviderName): string {
  return LABEL[name];
}

function kindForStatus(status: number | undefined): ProviderErrorKind {
  if (status === undefined) return 'server'; // error event inside an SSE stream
  if (status === 429) return 'rate_limit';
  if (status === 413) return 'too_large';
  if (status === 401 || status === 403) return 'auth';
  if (status === 404) return 'not_found';
  if (status >= 500) return 'server';
  return 'bad_request';
}

const TOOL_FORMAT =
  /tool_use_failed|failed to call a function|support tool use|tool calling|tools? (is|are) not supported/i;

function describe(err: { error: unknown; message: string }): string {
  const body = err.error as { message?: unknown } | undefined;
  const msg = typeof body?.message === 'string' ? body.message : err.message;
  return msg.replace(/\s+/g, ' ').trim();
}

/** `retry-after` if present, else OpenRouter's `x-ratelimit-reset` (epoch ms) on an exhausted window. */
function retryAfterFrom(headers: Headers, now: number): number | undefined {
  const direct = parseRetryAfter(headers, now);
  if (direct !== undefined) return direct;
  const reset = Number(headers.get('x-ratelimit-reset') ?? '');
  return Number.isFinite(reset) && reset > now ? reset - now : undefined;
}

export function toProviderError(err: unknown, provider: ProviderName, now: number): ProviderError {
  if (err instanceof ProviderError) return err;
  const label = LABEL[provider];
  if (err instanceof APIUserAbortError)
    return new ProviderError('aborted', 'Request aborted', provider);
  if (err instanceof APIConnectionTimeoutError) {
    return new ProviderError('timeout', `${label} did not respond in time`, provider);
  }
  if (err instanceof APIConnectionError) {
    return new ProviderError('network', `Could not reach ${label}: ${err.message}`, provider);
  }
  if (err instanceof APIError) {
    const status = typeof err.status === 'number' ? err.status : undefined;
    const headers = err.headers as Headers | undefined;
    const retryAfterMs = headers ? retryAfterFrom(headers, now) : undefined;
    const body = err.error as { code?: unknown } | undefined;
    const toolFormat =
      (status === 400 || status === 404 || status === 422) &&
      (body?.code === 'tool_use_failed' || TOOL_FORMAT.test(describe(err)));
    return new ProviderError(
      toolFormat ? 'tool_format' : kindForStatus(status),
      `${label}${status === undefined ? '' : ` ${status}`}: ${describe(err)}`,
      provider,
      status,
      retryAfterMs,
    );
  }
  if (err instanceof Error && err.name === 'AbortError') {
    return new ProviderError('aborted', 'Request aborted', provider);
  }
  return new ProviderError('network', `${label}: ${String(err)}`, provider);
}
