import TurndownService from 'turndown';
import { z } from 'zod';
import type { Router } from '../router/router.js';
import { truncateMiddle } from './truncate.js';
import { defineTool } from './types.js';

const FETCH_TIMEOUT_MS = 20_000;
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_PAGE_CHARS = 40_000;
const CACHE_MS = 15 * 60 * 1000;
const MAX_REDIRECTS = 5;

interface Page {
  url: string;
  markdown: string;
  at: number;
}

export function htmlToMarkdown(html: string): string {
  const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
  td.remove(['script', 'style', 'noscript', 'iframe']);
  return td
    .turndown(html)
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

type FetchResult = { page: Page } | { redirect: string } | { error: string };

async function fetchPage(url: string, signal: AbortSignal): Promise<FetchResult> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await fetch(current, {
      redirect: 'manual',
      signal: AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]),
      headers: {
        'User-Agent': 'VinaX-CLI (+https://github.com/Vinay1812007/VinaX-CLI)',
        Accept: 'text/html,text/plain,application/json;q=0.9,*/*;q=0.5',
      },
    });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (location === null)
        return { error: `HTTP ${String(res.status)} without a Location header` };
      const next = new URL(location, current);
      // following a redirect to another host would sidestep domain permission rules
      if (next.host !== new URL(current).host) return { redirect: next.toString() };
      current = next.toString();
      continue;
    }
    if (!res.ok) return { error: `HTTP ${String(res.status)} ${res.statusText}` };
    const type = res.headers.get('content-type') ?? '';
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_BYTES) return { error: 'The page is larger than 5 MB.' };
    const text = buf.toString('utf8');
    if (type.includes('html'))
      return { page: { url: current, markdown: htmlToMarkdown(text), at: Date.now() } };
    if (type.startsWith('text/') || type.includes('json') || type.includes('xml') || type === '') {
      return { page: { url: current, markdown: text, at: Date.now() } };
    }
    return { error: `Unsupported content type ${type}` };
  }
  return { error: 'Too many redirects.' };
}

/** WebFetch: turns a page into Markdown and has the small model answer a question about it. */
function charCount(n: number): string {
  return n < 1000 ? `${String(n)} chars` : `${(n / 1000).toFixed(1)}K chars`;
}

export function createWebFetchTool(router: Router) {
  const cache = new Map<string, Page>();
  return defineTool({
    name: 'WebFetch',
    description:
      'Fetch a web page (HTML is converted to Markdown) and answer a question about it with a fast model. Give the full URL and say exactly what you need from the page. Results are cached for 15 minutes. Redirects to another site are reported instead of followed.',
    input: z.object({
      url: z.url().describe('Full URL; http is upgraded to https (except localhost)'),
      prompt: z.string().min(1).describe('What to extract or answer from the page'),
    }),
    kind: 'network',
    readOnly: true,
    label: (i) => i.url,
    target: (i) => {
      try {
        return { domain: new URL(i.url).hostname };
      } catch {
        return { domain: i.url };
      }
    },
    async run(i, ctx) {
      // local dev servers (localhost, 127.0.0.1) usually speak plain http
      const url = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(i.url)
        ? i.url
        : i.url.replace(/^http:\/\//i, 'https://');
      let page = cache.get(url);
      if (!page || Date.now() - page.at > CACHE_MS) {
        const r = await fetchPage(url, ctx.signal);
        if ('redirect' in r) {
          return {
            ok: false,
            content: `The page redirects to another site: ${r.redirect}\nCall WebFetch again with that URL if it is what you want.`,
            summary: 'Redirected to another site',
          };
        }
        if ('error' in r)
          return { ok: false, content: `Could not fetch ${url}: ${r.error}`, summary: r.error };
        page = r.page;
        cache.set(url, page);
      }
      const body = truncateMiddle(page.markdown, MAX_PAGE_CHARS, 'page truncated');
      let answer = '';
      try {
        for await (const ev of router.stream({
          purpose: 'small',
          signal: ctx.signal,
          maxTokens: 1200,
          messages: [
            {
              role: 'system',
              content:
                'You answer questions about one web page using only its content. Quote code and exact values verbatim. Say so plainly if the page does not contain the answer.',
            },
            {
              role: 'user',
              content: `Page: ${page.url}\n\n<page>\n${body}\n</page>\n\n${i.prompt}`,
            },
          ],
        })) {
          if (ev.type === 'text') answer += ev.text;
        }
      } catch {
        answer = '';
      }
      if (answer.trim() === '') {
        return {
          ok: true,
          content: `Source: ${page.url}\n(The page could not be summarised; here is its start.)\n\n${page.markdown.slice(0, 8000)}`,
          summary: `Fetched ${charCount(page.markdown.length)} (raw)`,
        };
      }
      return {
        ok: true,
        content: `Source: ${page.url}\n\n${answer.trim()}`,
        summary: `Fetched ${charCount(page.markdown.length)} and answered`,
      };
    },
  });
}
