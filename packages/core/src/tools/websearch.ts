import { z } from 'zod';
import type { Env } from '../config/paths.js';
import { defineTool } from './types.js';

const SEARCH_TIMEOUT_MS = 15_000;
const DEFAULT_RESULTS = 8;
const MAX_RESULTS = 20;
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 VinaX-CLI';

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export type SearchProvider = 'duckduckgo' | 'brave' | 'tavily';

export const SEARCH_PROVIDER_LABELS: Record<SearchProvider, string> = {
  duckduckgo: 'DuckDuckGo',
  brave: 'Brave Search',
  tavily: 'Tavily',
};

type FetchFn = typeof fetch;

export interface WebSearchOptions {
  env?: Env;
  /** Injectable for tests. */
  fetch?: FetchFn;
}

/** Brave or Tavily when their API key is set (Brave first), otherwise keyless DuckDuckGo. */
export function pickSearchProvider(env: Env = process.env): SearchProvider {
  if ((env.BRAVE_API_KEY ?? '') !== '') return 'brave';
  if ((env.TAVILY_API_KEY ?? '') !== '') return 'tavily';
  return 'duckduckgo';
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (code.startsWith('#x') || code.startsWith('#X'))
      return String.fromCodePoint(parseInt(code.slice(2), 16));
    if (code.startsWith('#')) return String.fromCodePoint(parseInt(code.slice(1), 10));
    return ENTITIES[code.toLowerCase()] ?? whole;
  });
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, ''))
    .replace(/\s+/g, ' ')
    .trim();
}

function attr(attrs: string, name: string): string | undefined {
  const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(attrs);
  return m === null ? undefined : (m[2] ?? m[3]);
}

/** DuckDuckGo links go through `//duckduckgo.com/l/?uddg=<target>`; returns the target. */
export function unwrapDuckDuckGoUrl(href: string): string | undefined {
  const raw = decodeEntities(href);
  let url: URL;
  try {
    url = new URL(raw.startsWith('//') ? `https:${raw}` : raw, 'https://duckduckgo.com');
  } catch {
    return undefined;
  }
  if (url.hostname.endsWith('duckduckgo.com')) {
    const target = url.searchParams.get('uddg');
    // anything else on duckduckgo.com (ads go through /y.js) is not a result
    return target === null || target === '' ? undefined : target;
  }
  return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : undefined;
}

/** Results from DuckDuckGo's HTML page (`html.duckduckgo.com/html/`), ads skipped. */
export function parseDuckDuckGoHtml(html: string): SearchResult[] {
  const results: SearchResult[] = [];
  let current: SearchResult | undefined;
  const anchor = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  for (const m of html.matchAll(anchor)) {
    const attrs = m[1] ?? '';
    const cls = attr(attrs, 'class') ?? '';
    if (/\bresult__a\b/.test(cls)) {
      const url = unwrapDuckDuckGoUrl(attr(attrs, 'href') ?? '');
      current = undefined;
      if (url === undefined) continue;
      current = { title: stripTags(m[2] ?? ''), url, snippet: '' };
      if (!results.some((r) => r.url === url)) results.push(current);
    } else if (/\bresult__snippet\b/.test(cls) && current !== undefined) {
      current.snippet = stripTags(m[2] ?? '');
    }
  }
  return results.filter((r) => r.title !== '');
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

/** `docs.github.com` matches `github.com`; a leading `*.` or `www.` in the domain is ignored. */
export function domainMatches(host: string, domain: string): boolean {
  const d = domain
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^\*\./, '')
    .replace(/^www\./, '')
    .replace(/\/.*$/, '');
  if (d === '') return false;
  return host === d || host.endsWith(`.${d}`);
}

export function filterByDomain(
  results: readonly SearchResult[],
  allowed: readonly string[] = [],
  blocked: readonly string[] = [],
): SearchResult[] {
  return results.filter((r) => {
    const host = hostOf(r.url);
    if (host === undefined) return false;
    if (blocked.some((d) => domainMatches(host, d))) return false;
    return allowed.length === 0 || allowed.some((d) => domainMatches(host, d));
  });
}

export function formatResults(
  query: string,
  provider: SearchProvider,
  results: readonly SearchResult[],
): string {
  const lines = [`Web search results for "${query}" (${SEARCH_PROVIDER_LABELS[provider]}):`, ''];
  results.forEach((r, i) => {
    lines.push(`${String(i + 1)}. ${r.title}`, `   ${r.url}`);
    if (r.snippet !== '') lines.push(`   ${r.snippet}`);
    lines.push('');
  });
  lines.push(
    'Read a page with WebFetch before relying on it, and cite the URLs you used in your answer.',
  );
  return lines.join('\n');
}

class SearchError extends Error {}

interface SearchRequest {
  query: string;
  max: number;
  allowed: readonly string[];
  blocked: readonly string[];
  signal: AbortSignal;
}

async function duckDuckGo(req: SearchRequest, fetchFn: FetchFn): Promise<SearchResult[]> {
  // DuckDuckGo honours `site:`; with one allowed domain it narrows the search itself
  const [only] = req.allowed;
  const q =
    req.allowed.length === 1 && only !== undefined ? `${req.query} site:${only}` : req.query;
  const res = await fetchFn('https://html.duckduckgo.com/html/', {
    method: 'POST',
    signal: req.signal,
    headers: {
      'User-Agent': USER_AGENT,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'text/html',
    },
    body: new URLSearchParams({ q, kl: 'wt-wt' }).toString(),
  });
  if (!res.ok) throw new SearchError(`DuckDuckGo answered HTTP ${String(res.status)}`);
  const html = await res.text();
  const results = parseDuckDuckGoHtml(html);
  if (results.length === 0 && /anomaly|captcha|challenge/i.test(html))
    throw new SearchError(
      'DuckDuckGo is rate-limiting these searches. Wait a minute, or set BRAVE_API_KEY or TAVILY_API_KEY for a keyed search provider.',
    );
  return results;
}

async function brave(req: SearchRequest, key: string, fetchFn: FetchFn): Promise<SearchResult[]> {
  const url = new URL('https://api.search.brave.com/res/v1/web/search');
  url.searchParams.set('q', req.query);
  url.searchParams.set('count', String(Math.min(req.max * 2, 20)));
  const res = await fetchFn(url, {
    signal: req.signal,
    headers: { Accept: 'application/json', 'X-Subscription-Token': key },
  });
  if (!res.ok) throw new SearchError(`Brave Search answered HTTP ${String(res.status)}`);
  const body = (await res.json()) as {
    web?: { results?: { title?: string; url?: string; description?: string }[] };
  };
  return (body.web?.results ?? []).flatMap((r) =>
    r.url === undefined
      ? []
      : [
          {
            title: stripTags(r.title ?? r.url),
            url: r.url,
            snippet: stripTags(r.description ?? ''),
          },
        ],
  );
}

async function tavily(req: SearchRequest, key: string, fetchFn: FetchFn): Promise<SearchResult[]> {
  const res = await fetchFn('https://api.tavily.com/search', {
    method: 'POST',
    signal: req.signal,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      query: req.query,
      max_results: Math.min(req.max * 2, 20),
      ...(req.allowed.length === 0 ? {} : { include_domains: req.allowed }),
      ...(req.blocked.length === 0 ? {} : { exclude_domains: req.blocked }),
    }),
  });
  if (!res.ok) throw new SearchError(`Tavily answered HTTP ${String(res.status)}`);
  const body = (await res.json()) as {
    results?: { title?: string; url?: string; content?: string }[];
  };
  return (body.results ?? []).flatMap((r) =>
    r.url === undefined
      ? []
      : [
          {
            title: r.title ?? r.url,
            url: r.url,
            snippet: (r.content ?? '').replace(/\s+/g, ' ').trim(),
          },
        ],
  );
}

/** Runs one search with the chosen provider and applies the domain filters. */
export async function webSearch(
  query: string,
  opts: {
    max?: number;
    allowed?: readonly string[];
    blocked?: readonly string[];
    signal: AbortSignal;
    env?: Env;
    fetch?: FetchFn;
  },
): Promise<{ provider: SearchProvider; results: SearchResult[] }> {
  const env = opts.env ?? process.env;
  const fetchFn = opts.fetch ?? fetch;
  const provider = pickSearchProvider(env);
  const req: SearchRequest = {
    query,
    max: opts.max ?? DEFAULT_RESULTS,
    allowed: opts.allowed ?? [],
    blocked: opts.blocked ?? [],
    signal: AbortSignal.any([opts.signal, AbortSignal.timeout(SEARCH_TIMEOUT_MS)]),
  };
  const raw =
    provider === 'brave'
      ? await brave(req, env.BRAVE_API_KEY ?? '', fetchFn)
      : provider === 'tavily'
        ? await tavily(req, env.TAVILY_API_KEY ?? '', fetchFn)
        : await duckDuckGo(req, fetchFn);
  return { provider, results: filterByDomain(raw, req.allowed, req.blocked).slice(0, req.max) };
}

const domainList = z
  .array(z.string().min(1))
  .optional()
  .describe('Domains like "github.com" (subdomains included)');

/** WebSearch: searches the web (DuckDuckGo without a key; Brave or Tavily with one). */
export function createWebSearchTool(opts: WebSearchOptions = {}) {
  return defineTool({
    name: 'WebSearch',
    description:
      'Search the web and get a numbered list of results (title, URL, snippet). Use it for current information, documentation, error messages and anything past your knowledge cutoff, then read the most relevant pages with WebFetch. Restrict or exclude sites with allowed_domains / blocked_domains. Cite the URLs you used.',
    input: z.object({
      query: z.string().min(2).describe('The search query'),
      allowed_domains: domainList,
      blocked_domains: domainList,
      max_results: z
        .number()
        .int()
        .min(1)
        .max(MAX_RESULTS)
        .optional()
        .describe(`How many results to return (default ${String(DEFAULT_RESULTS)})`),
    }),
    kind: 'network',
    readOnly: true,
    label: (i) => i.query,
    target: () => ({}),
    async run(i, ctx) {
      try {
        const { provider, results } = await webSearch(i.query, {
          ...(i.max_results === undefined ? {} : { max: i.max_results }),
          ...(i.allowed_domains === undefined ? {} : { allowed: i.allowed_domains }),
          ...(i.blocked_domains === undefined ? {} : { blocked: i.blocked_domains }),
          signal: ctx.signal,
          ...(opts.env === undefined ? {} : { env: opts.env }),
          ...(opts.fetch === undefined ? {} : { fetch: opts.fetch }),
        });
        if (results.length === 0)
          return {
            ok: true,
            content: `No results for "${i.query}" (${SEARCH_PROVIDER_LABELS[provider]}). Try a shorter or different query.`,
            summary: 'No results',
          };
        return {
          ok: true,
          content: formatResults(i.query, provider, results),
          summary: `${String(results.length)} result${results.length === 1 ? '' : 's'} · ${SEARCH_PROVIDER_LABELS[provider]}`,
        };
      } catch (e) {
        if (ctx.signal.aborted) throw e;
        const timedOut = e instanceof Error && e.name === 'TimeoutError';
        const message = timedOut
          ? `the search took longer than ${String(SEARCH_TIMEOUT_MS / 1000)} seconds`
          : e instanceof Error
            ? e.message
            : String(e);
        return {
          ok: false,
          content: `Web search failed: ${message}. Try again later, or answer from what you know and say so.`,
          summary: timedOut ? 'Search timed out' : 'Search failed',
        };
      }
    },
  });
}
