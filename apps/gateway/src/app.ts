import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import pkg from '../package.json' with { type: 'json' };
import { UPSTREAMS, type GatewayConfig, type Upstream, type UpstreamName } from './config.js';
import { RateLimiter } from './limits.js';
import { hashToken } from './tokens.js';

export const GATEWAY_VERSION: string = pkg.version;
const MODELS_CACHE_MS = 10 * 60_000;
const PROJECT_URL = 'https://github.com/Vinay1812007/VinaX-CLI';

/** Upstream response headers worth passing on: the client's router reads the rate-limit ones. */
const PASSTHROUGH_HEADER = /^(content-type|cache-control|retry-after|x-ratelimit-.*)$/i;

export interface GatewayDeps {
  fetch?: typeof fetch;
  now?: () => number;
  /** Receives one line per request. Request and response bodies are never included. */
  log?: (line: Record<string, unknown>) => void;
}

type Env = { Variables: { tokenName: string } };

function errorBody(message: string, type: string): { error: { message: string; type: string } } {
  return { error: { message, type } };
}

interface Candidate {
  ref: string;
  upstream: Upstream | undefined;
  provider: string;
  model: string;
}

function toCandidate(ref: string, config: GatewayConfig): Candidate {
  const sep = ref.indexOf(':');
  const provider = sep === -1 ? '' : ref.slice(0, sep);
  const model = sep === -1 ? ref : ref.slice(sep + 1);
  const upstream = provider in UPSTREAMS ? config.upstreams[provider as UpstreamName] : undefined;
  return { ref, upstream, provider, model };
}

function upstreamHeaders(u: Upstream): Record<string, string> {
  return {
    Authorization: `Bearer ${u.apiKey}`,
    'Content-Type': 'application/json',
    ...(u.name === 'openrouter' ? { 'HTTP-Referer': PROJECT_URL, 'X-Title': 'VinaX gateway' } : {}),
  };
}

function passthroughHeaders(from: Headers): Headers {
  const out = new Headers();
  from.forEach((value, key) => {
    if (PASSTHROUGH_HEADER.test(key)) out.set(key, value);
  });
  return out;
}

/** Worth trying the next model: rate limits, upstream outages and our own key being rejected. */
function shouldFallBack(status: number): boolean {
  return status === 401 || status === 403 || status === 408 || status === 429 || status >= 500;
}

export function createApp(config: GatewayConfig, deps: GatewayDeps = {}): Hono<Env> {
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const log =
    deps.log ??
    ((line: Record<string, unknown>) => {
      console.log(JSON.stringify(line));
    });
  const limiter = new RateLimiter(config.rpm, config.rpd, now);
  let modelsCache: { at: number; body: unknown } | undefined;
  const app = new Hono<Env>();

  app.use('*', async (c, next) => {
    const started = now();
    await next();
    log({
      time: new Date(started).toISOString(),
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      ms: now() - started,
      token: c.get('tokenName'),
      model: c.res.headers.get('x-vinax-model') ?? undefined,
    });
  });

  app.get('/health', (c) =>
    c.json({
      status: 'ok',
      service: 'vinax-gateway',
      version: GATEWAY_VERSION,
      providers: Object.keys(config.upstreams),
    }),
  );
  app.get('/', (c) => c.json({ service: 'vinax-gateway', docs: `${PROJECT_URL}#gateway` }));

  app.use('/v1/*', async (c, next) => {
    const header = c.req.header('authorization') ?? '';
    const match = /^Bearer\s+(\S+)$/i.exec(header);
    const name = match?.[1] === undefined ? undefined : config.tokens.get(hashToken(match[1]));
    if (name === undefined)
      return c.json(errorBody('Missing or unknown VinaX gateway token.', 'auth'), 401);
    c.set('tokenName', name);
    await next();
  });

  app.get('/v1/models', async (c) => {
    if (modelsCache && now() - modelsCache.at < MODELS_CACHE_MS) return c.json(modelsCache.body);
    const lists = await Promise.all(
      Object.values(config.upstreams).map(async (u) => {
        try {
          const res = await doFetch(`${u.baseUrl}/models`, {
            headers: upstreamHeaders(u),
            signal: AbortSignal.timeout(15_000),
          });
          if (!res.ok) return undefined;
          const body = (await res.json()) as { data?: unknown };
          if (!Array.isArray(body.data)) return undefined;
          return body.data
            .filter((m): m is Record<string, unknown> & { id: string } => {
              return (
                typeof m === 'object' &&
                m !== null &&
                typeof (m as { id?: unknown }).id === 'string'
              );
            })
            .map((m) => ({ ...m, id: `${u.name}:${m.id}` }));
        } catch {
          return undefined;
        }
      }),
    );
    if (lists.every((l) => l === undefined))
      return c.json(errorBody('No provider model list is reachable right now.', 'upstream'), 502);
    const body = { object: 'list', data: lists.flatMap((l) => l ?? []) };
    if (lists.every((l) => l !== undefined)) modelsCache = { at: now(), body };
    return c.json(body);
  });

  app.post(
    '/v1/chat/completions',
    bodyLimit({
      maxSize: config.maxBodyBytes,
      onError: (c) =>
        c.json(
          errorBody(
            `Request body is larger than ${String(config.maxBodyBytes)} bytes.`,
            'too_large',
          ),
          413,
        ),
    }),
    async (c) => {
      const decision = limiter.take(c.get('tokenName'));
      if (!decision.ok) {
        c.header('retry-after', String(decision.retryAfterSec));
        return c.json(errorBody(`VinaX gateway: ${decision.reason}.`, 'rate_limit'), 429);
      }
      let body: Record<string, unknown>;
      try {
        const parsed: unknown = await c.req.json();
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
          throw new Error('not an object');
        body = parsed as Record<string, unknown>;
      } catch {
        return c.json(errorBody('The body must be a JSON object.', 'bad_request'), 400);
      }
      const { model, models: extra, ...rest } = body;
      if (typeof model !== 'string' || !Array.isArray(rest.messages))
        return c.json(errorBody('"model" and "messages" are required.', 'bad_request'), 400);
      const refs =
        model === 'auto'
          ? [...config.defaultModels]
          : [model, ...(Array.isArray(extra) ? extra.filter((m) => typeof m === 'string') : [])];
      return relay(c, refs, rest);
    },
  );

  app.notFound((c) => c.json(errorBody('Not found.', 'not_found'), 404));
  app.onError((err, c) => {
    log({ level: 'error', path: c.req.path, message: err.message });
    return c.json(errorBody('Internal gateway error.', 'server'), 500);
  });

  /** Tries each model until one starts answering, then streams its response through unchanged. */
  async function relay(
    c: Context<Env>,
    refs: readonly string[],
    rest: Record<string, unknown>,
  ): Promise<Response> {
    const failures: string[] = [];
    let attempted = false;
    let last: { status: number; text: string; headers: Headers } | undefined;
    for (const ref of [...new Set(refs)]) {
      const cand = toCandidate(ref, config);
      if (cand.upstream === undefined) {
        failures.push(
          cand.provider in UPSTREAMS
            ? `${ref}: this gateway has no ${cand.provider} key`
            : `${ref}: unknown provider (use groq:<model> or openrouter:<model>)`,
        );
        continue;
      }
      attempted = true;
      const ac = new AbortController();
      const onClientAbort = (): void => {
        ac.abort();
      };
      c.req.raw.signal.addEventListener('abort', onClientAbort, { once: true });
      const timer = setTimeout(() => {
        ac.abort(new Error('upstream timeout'));
      }, config.upstreamTimeoutMs);
      let res: Response;
      try {
        res = await doFetch(`${cand.upstream.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: upstreamHeaders(cand.upstream),
          body: JSON.stringify({ ...rest, model: cand.model }),
          signal: ac.signal,
        });
      } catch (err) {
        clearTimeout(timer);
        c.req.raw.signal.removeEventListener('abort', onClientAbort);
        if (c.req.raw.signal.aborted) return new Response(null, { status: 499 });
        failures.push(`${ref}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      clearTimeout(timer);
      if (res.ok) {
        const headers = passthroughHeaders(res.headers);
        headers.set('x-vinax-model', ref);
        if (failures.length > 0) headers.set('x-vinax-fallback', String(failures.length));
        return new Response(res.body, { status: res.status, headers });
      }
      c.req.raw.signal.removeEventListener('abort', onClientAbort);
      const text = await res.text().catch(() => '');
      last = { status: res.status, text, headers: res.headers };
      if (!shouldFallBack(res.status)) break;
      failures.push(`${ref}: HTTP ${String(res.status)}`);
    }
    if (last && !shouldFallBack(last.status)) {
      const headers = passthroughHeaders(last.headers);
      return new Response(last.text, { status: last.status, headers });
    }
    if (last?.status === 429) {
      // Every model was rate limited: pass the limit on so the client can wait or fall back.
      const headers = passthroughHeaders(last.headers);
      return new Response(last.text, { status: 429, headers });
    }
    const message = `No model could answer: ${failures.join('; ') || 'no models requested'}.`;
    return c.json(errorBody(message, 'upstream'), (attempted ? 502 : 400) as ContentfulStatusCode);
  }

  return app;
}
