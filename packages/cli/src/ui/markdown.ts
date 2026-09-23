import { Chalk, type ChalkInstance } from 'chalk';
import hljs from 'highlight.js/lib/common';
import { lexer, type Token, type Tokens } from 'marked';
import stringWidth from 'string-width';
import wrapAnsi from 'wrap-ansi';
import type { CodeRole, Theme } from './theme.js';

export interface MarkdownOptions {
  width: number;
  theme: Theme;
}

interface Ctx {
  ch: ChalkInstance;
  theme: Theme;
}

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&#x27;': "'",
};

function decode(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|#39|#x27);/g, (m) => ENTITIES[m] ?? m);
}

function paint(ctx: Ctx, color: string | undefined, s: string): string {
  return color === undefined ? s : ctx.ch.hex(color)(s);
}

/** An unfinished code fence renders as a code block while it streams, instead of flickering as text. */
export function closeOpenFence(src: string): string {
  let open: string | undefined;
  for (const line of src.split('\n')) {
    const m = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (!m?.[1]) continue;
    if (open === undefined) open = m[1];
    else if (m[1].startsWith(open[0] ?? '`') && m[1].length >= open.length) open = undefined;
  }
  return open === undefined ? src : `${src}\n${open}`;
}

const HLJS_ROLE: Record<string, CodeRole> = {
  keyword: 'keyword',
  'selector-tag': 'keyword',
  built_in: 'type',
  type: 'type',
  class: 'type',
  literal: 'literal',
  number: 'number',
  string: 'string',
  regexp: 'string',
  symbol: 'string',
  comment: 'comment',
  quote: 'comment',
  doctag: 'comment',
  title: 'title',
  section: 'title',
  name: 'title',
  attr: 'attr',
  attribute: 'attr',
  property: 'attr',
  meta: 'meta',
  variable: 'variable',
  params: 'variable',
  'template-variable': 'variable',
};

/** Converts highlight.js HTML (nested `<span class="hljs-…">`) into ANSI colours. */
function htmlToAnsi(html: string, ctx: Ctx): string {
  const stack: (string | undefined)[] = [];
  let out = '';
  for (const part of html.split(/(<span class="[^"]*">|<\/span>)/)) {
    if (part.startsWith('<span')) {
      const cls = /class="hljs-([\w-]+)/.exec(part)?.[1];
      const role = cls === undefined ? undefined : HLJS_ROLE[cls];
      stack.push(role === undefined ? stack.at(-1) : ctx.theme.code[role]);
    } else if (part === '</span>') {
      stack.pop();
    } else if (part !== '') {
      const text = decode(part);
      const color = stack.at(-1);
      // colour each line separately so wrapping and prefixes never split an escape sequence
      out += text
        .split('\n')
        .map((l) => (l === '' ? l : paint(ctx, color, l)))
        .join('\n');
    }
  }
  return out;
}

export function highlightCode(code: string, lang: string | undefined, ctx: Ctx): string {
  if (!ctx.theme.color || lang === undefined || lang === '' || !hljs.getLanguage(lang)) return code;
  try {
    return htmlToAnsi(hljs.highlight(code, { language: lang, ignoreIllegals: true }).value, ctx);
  } catch {
    return code;
  }
}

function inline(tokens: readonly Token[] | undefined, ctx: Ctx): string {
  if (!tokens) return '';
  const { ch, theme } = ctx;
  let out = '';
  for (const t of tokens as Tokens.Generic[]) {
    switch (t.type) {
      case 'strong':
        out += ch.bold(inline(t.tokens, ctx));
        break;
      case 'em':
        out += ch.italic(inline(t.tokens, ctx));
        break;
      case 'del':
        out += ch.strikethrough(inline(t.tokens, ctx));
        break;
      case 'codespan':
        out += paint(ctx, theme.accent, decode(t.text as string));
        break;
      case 'link': {
        const label = inline(t.tokens, ctx);
        const href = t.href as string;
        const shown = paint(ctx, theme.accent, ch.underline(label));
        out +=
          label === href || href.startsWith('#')
            ? shown
            : `${shown} ${paint(ctx, theme.muted, `(${href})`)}`;
        break;
      }
      case 'image':
        out += paint(ctx, theme.muted, `[image: ${t.text as string}]`);
        break;
      case 'br':
        out += '\n';
        break;
      case 'checkbox': // shown as the list marker instead
        break;
      case 'text':
        out += t.tokens ? inline(t.tokens, ctx) : decode(t.text as string);
        break;
      default:
        out += decode((t.text as string | undefined) ?? t.raw);
    }
  }
  return out;
}

function wrap(text: string, width: number, trim = true): string[] {
  return wrapAnsi(text, Math.max(1, width), { hard: true, trim }).split('\n');
}

function indentBlock(lines: string[], first: string, rest: string): string[] {
  return lines.map((l, i) => (i === 0 ? first : rest) + l);
}

function renderList(list: Tokens.List, width: number, ctx: Ctx, depth: number): string[] {
  const bullets = ['•', '◦', '▪'];
  const start = typeof list.start === 'number' ? list.start : 1;
  const markers = list.items.map((item, i) => {
    if (item.task) return item.checked === true ? '☑' : '☐';
    return list.ordered ? `${start + i}.` : (bullets[depth % bullets.length] ?? '•');
  });
  const markerWidth = Math.max(...markers.map((m) => stringWidth(m))) + 1;
  const out: string[] = [];
  list.items.forEach((item, i) => {
    const marker = (markers[i] ?? '').padEnd(markerWidth);
    const body = blocks(item.tokens, width - markerWidth, ctx, depth + 1, false);
    out.push(
      ...indentBlock(
        body.length === 0 ? [''] : body,
        paint(ctx, ctx.theme.accent, marker),
        ' '.repeat(markerWidth),
      ),
    );
  });
  return out;
}

function renderTable(table: Tokens.Table, width: number, ctx: Ctx): string[] {
  const muted = (s: string): string => paint(ctx, ctx.theme.muted, s);
  const header = table.header.map((c) => ctx.ch.bold(inline(c.tokens, ctx)));
  const rows = table.rows.map((r) => r.map((c) => inline(c.tokens, ctx)));
  const cols = header.length;
  const natural = Array.from({ length: cols }, (_, i) =>
    Math.max(3, stringWidth(header[i] ?? ''), ...rows.map((r) => stringWidth(r[i] ?? ''))),
  );
  // 3 chars of border/padding per column plus the closing border
  const budget = Math.max(cols * 4, width - (cols * 3 + 1));
  const widths = [...natural];
  while (widths.reduce((a, b) => a + b, 0) > budget) {
    const widest = widths.indexOf(Math.max(...widths));
    if ((widths[widest] ?? 0) <= 4) break;
    widths[widest] = (widths[widest] ?? 4) - 1;
  }
  const line = (l: string, m: string, r: string): string =>
    muted(l + widths.map((w) => '─'.repeat(w + 2)).join(m) + r);
  const row = (cells: string[]): string[] => {
    const wrapped = cells.map((c, i) => wrap(c, widths[i] ?? 4));
    const height = Math.max(...wrapped.map((w) => w.length));
    const out: string[] = [];
    for (let h = 0; h < height; h++) {
      const parts = wrapped.map((w, i) => {
        const cell = w[h] ?? '';
        const pad = (widths[i] ?? 0) - stringWidth(cell);
        const align = table.align[i];
        if (align === 'right') return ' '.repeat(pad) + cell;
        if (align === 'center')
          return ' '.repeat(Math.floor(pad / 2)) + cell + ' '.repeat(Math.ceil(pad / 2));
        return cell + ' '.repeat(pad);
      });
      out.push(muted('│ ') + parts.join(muted(' │ ')) + muted(' │'));
    }
    return out;
  };
  return [
    line('┌', '┬', '┐'),
    ...row(header),
    line('├', '┼', '┤'),
    ...rows.flatMap((r) => row(r)),
    line('└', '┴', '┘'),
  ];
}

function block(t: Tokens.Generic, width: number, ctx: Ctx, depth: number): string[] {
  const { ch, theme } = ctx;
  switch (t.type) {
    case 'heading': {
      const text = inline(t.tokens, ctx);
      const styled = t.depth === 1 ? ch.bold.underline(text) : ch.bold(text);
      return wrap(t.depth <= 2 ? paint(ctx, theme.accent, styled) : styled, width);
    }
    case 'paragraph':
      return wrap(inline(t.tokens, ctx), width);
    case 'text':
      return wrap(t.tokens ? inline(t.tokens, ctx) : decode(t.text as string), width);
    case 'code': {
      const lang = typeof t.lang === 'string' ? t.lang.split(/\s/)[0] : undefined;
      const code = highlightCode(t.text as string, lang, ctx);
      const bar = paint(ctx, theme.muted, '│ ');
      const label = lang === undefined || lang === '' ? [] : [paint(ctx, theme.muted, `╭ ${lang}`)];
      return [
        ...label,
        ...code.split('\n').flatMap((l) => wrap(l, width - 2, false).map((w) => bar + w)),
      ];
    }
    case 'list':
      return renderList(t as unknown as Tokens.List, width, ctx, depth);
    case 'blockquote': {
      const inner = blocks(t.tokens, width - 2, ctx, depth, true);
      return inner.map((l) => paint(ctx, theme.muted, '▎ ') + ch.italic(l));
    }
    case 'hr':
      return [paint(ctx, theme.muted, '─'.repeat(Math.min(width, 48)))];
    case 'table':
      return renderTable(t as unknown as Tokens.Table, width, ctx);
    case 'space':
    case 'checkbox':
      return [];
    default:
      return wrap(decode(t.raw.trimEnd()), width);
  }
}

function blocks(
  tokens: readonly Token[] | undefined,
  width: number,
  ctx: Ctx,
  depth: number,
  spaced: boolean,
): string[] {
  const out: string[] = [];
  for (const t of (tokens ?? []) as Tokens.Generic[]) {
    const lines = block(t, width, ctx, depth);
    if (lines.length === 0) continue;
    if (spaced && out.length > 0) out.push('');
    out.push(...lines);
  }
  return out;
}

/** Renders Markdown to terminal text, already wrapped to `width` columns. */
export function renderMarkdown(src: string, opts: MarkdownOptions): string {
  const ctx: Ctx = { ch: new Chalk({ level: opts.theme.color ? 3 : 0 }), theme: opts.theme };
  const tokens = lexer(closeOpenFence(src));
  return blocks(tokens, Math.max(10, opts.width), ctx, 0, true).join('\n');
}
